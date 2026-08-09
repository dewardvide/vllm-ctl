import type { FlagSpec } from "@/lib/types";

/**
 * Turns a launch specification into the exact argv passed to `vllm serve`.
 *
 * This module is deliberately pure and dependency-free: the command preview in
 * the UI and the command the supervisor actually spawns come from this one
 * function, so what you read on screen is what runs. Any divergence between
 * them would make the preview a lie.
 */

export type FlagValue = string | number | boolean | string[];

export interface LaunchSpec {
  deploymentId?: number | null;
  name: string;
  /** HF repo id or a local path. Passed positionally. */
  model: string;
  servedName?: string | null;
  port?: number | null;
  /** Non-default flags keyed by long name without `--`. */
  flags: Record<string, FlagValue>;
  env?: Record<string, string>;
  /**
   * Escape hatch used by restart: replay a previous launch verbatim instead of
   * rebuilding from flags that may have been edited since.
   */
  rawArgv?: string[];
}

export interface HostPort {
  host: string;
  port: number;
}

/** Flags the app owns; a user value for these is ignored to avoid conflicts. */
const RESERVED = new Set(["host", "port", "model", "served-model-name"]);

export function buildServeArgv(spec: LaunchSpec, hp: HostPort): string[] {
  if (spec.rawArgv) return applyHostPort(spec.rawArgv, hp);

  const argv: string[] = ["serve", spec.model];
  argv.push("--host", hp.host, "--port", String(hp.port));
  if (spec.servedName) argv.push("--served-model-name", spec.servedName);

  for (const name of Object.keys(spec.flags).sort()) {
    if (RESERVED.has(name)) continue;
    argv.push(...renderFlag(name, spec.flags[name]));
  }
  return argv;
}

/** Renders one flag. Returns an empty array when the value contributes nothing. */
export function renderFlag(name: string, value: FlagValue): string[] {
  if (value === undefined || value === null) return [];

  if (typeof value === "boolean") {
    // vLLM's argparse exposes booleans as a `--x` / `--no-x` pair. Emitting the
    // negative form explicitly is safer than omitting the flag, because a
    // saved profile should override a default that changes between versions.
    return value ? [`--${name}`] : [`--no-${name}`];
  }

  if (Array.isArray(value)) {
    const items = value.map(String).filter((v) => v.length > 0);
    return items.length === 0 ? [] : [`--${name}`, ...items];
  }

  const s = String(value);
  if (s.trim() === "") return [];
  return [`--${name}`, s];
}

/** Replaces host/port in an existing argv, appending them if absent. */
function applyHostPort(argv: string[], hp: HostPort): string[] {
  const out = [...argv];
  for (const [flag, val] of [
    ["--host", hp.host],
    ["--port", String(hp.port)],
  ] as const) {
    const i = out.indexOf(flag);
    if (i >= 0 && i + 1 < out.length) out[i + 1] = val;
    else out.push(flag, val);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* display                                                                     */
/* -------------------------------------------------------------------------- */

/** POSIX-quotes a token only when it needs it, for a readable preview. */
export function shellQuote(token: string): string {
  if (token === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** The full command as the user would type it, wrapped for readability. */
export function formatCommand(exe: string, argv: string[]): string {
  const parts = [exe, ...argv].map(shellQuote);
  const lines: string[] = [];
  let current = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const tok = parts[i];
    // Keep a flag and its value on the same line.
    const isFlag = tok.startsWith("--");
    if (isFlag && current.length > 0) {
      lines.push(current);
      current = "  " + tok;
    } else {
      current += " " + tok;
    }
  }
  lines.push(current);
  return lines.join(" \\\n");
}

/* -------------------------------------------------------------------------- */
/* parsing back                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses a pasted `vllm serve …` command into a spec, so an existing shell
 * script can be imported rather than retyped into the form.
 */
export function parseServeCommand(
  input: string,
  specs: Map<string, FlagSpec>,
): { model: string | null; flags: Record<string, FlagValue>; unknown: string[] } {
  const tokens = tokenize(input);
  // Drop a leading `vllm serve`, `python -m vllm.entrypoints...`, etc.
  const serveIdx = tokens.indexOf("serve");
  const rest = serveIdx >= 0 ? tokens.slice(serveIdx + 1) : tokens;

  let model: string | null = null;
  const flags: Record<string, FlagValue> = {};
  const unknown: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith("-")) {
      if (model === null) model = tok;
      continue;
    }

    // --flag=value
    const eq = tok.indexOf("=");
    let name = eq >= 0 ? tok.slice(0, eq) : tok;
    const inlineValue = eq >= 0 ? tok.slice(eq + 1) : null;
    name = name.replace(/^--?/, "");

    const negated = name.startsWith("no-") && !specs.has(name);
    const lookup = negated ? name.slice(3) : name;
    const spec = specs.get(lookup) ?? findByAlias(specs, lookup);

    if (!spec) {
      unknown.push(tok);
      // Consume a value that clearly belongs to it, so it isn't read as model.
      if (inlineValue === null && rest[i + 1] && !rest[i + 1].startsWith("-")) i++;
      continue;
    }

    if (spec.type === "boolean") {
      flags[spec.name] = !negated;
      continue;
    }

    if (inlineValue !== null) {
      flags[spec.name] = inlineValue;
      continue;
    }

    const values: string[] = [];
    while (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
      values.push(rest[++i]);
      if (!spec.variadic) break;
    }
    if (values.length === 0) continue;
    flags[spec.name] = spec.variadic && values.length > 1 ? values : values[0];
  }

  return { model, flags, unknown };
}

function findByAlias(specs: Map<string, FlagSpec>, name: string): FlagSpec | undefined {
  for (const s of specs.values()) {
    if (s.aliases.includes(name)) return s;
  }
  return undefined;
}

/** Minimal POSIX-ish tokenizer: quotes, escapes, and line continuations. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\") {
      const next = input[i + 1];
      if (next === "\n") {
        i++;
        continue;
      }
      if (next !== undefined) {
        cur += next;
        i++;
        started = true;
        continue;
      }
    }
    if (/\s/.test(c)) {
      if (cur.length > 0 || started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (cur.length > 0 || started) out.push(cur);
  return out.filter((t) => t.length > 0);
}
