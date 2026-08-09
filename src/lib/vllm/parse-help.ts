import type { FlagSchema, FlagSpec, FlagType } from "@/lib/types";

/**
 * Parses `vllm serve --help=all` into a typed flag schema.
 *
 * The alternative — hand-maintaining a list of vLLM's ~270 options — would be
 * wrong the day vLLM is upgraded. Reading argparse's own output means the form
 * always matches the installed engine exactly, including flags that did not
 * exist when this app was written.
 *
 * The output has four shapes, all of which appear in vLLM 0.26:
 *
 *   --headless                                   boolean, no negative form
 *   --allow-credentials, --no-allow-credentials  boolean pair
 *   --gdn-prefill-backend {flashinfer,triton}    enum
 *   --api-key API_KEY [API_KEY ...]              variadic value
 *   --data-parallel-address ADDR, -dpa ADDR      long form plus short alias
 *
 * Help text wraps at column 72 and the argparse-supplied `(default: X)` may be
 * split across those wrapped lines, so help is joined before defaults are read.
 */

/** A section heading sits at column 0 and ends in a colon. */
const SECTION_RE = /^([A-Za-z][A-Za-z0-9_ ]*):\s*$/;
/** An option entry is indented exactly two spaces and starts with a dash. */
const ENTRY_RE = /^ {2}(-{1,2}[^\s].*)$/;

/**
 * Flags shown in the "Essentials" tier, in the order an operator reaches for
 * them. Names that a given vLLM build does not have are simply not marked —
 * the tier degrades rather than breaking when the engine is upgraded. (0.26
 * dropped `--swap-space` along with the V0 engine, for instance.)
 */
export const ESSENTIAL_FLAGS = [
  "max-model-len",
  "gpu-memory-utilization",
  "dtype",
  "quantization",
  "kv-cache-dtype",
  "max-num-seqs",
  "max-num-batched-tokens",
  "tensor-parallel-size",
  "pipeline-parallel-size",
  "enable-prefix-caching",
  "enable-chunked-prefill",
  "kv-cache-memory-bytes",
  "cpu-offload-gb",
  "trust-remote-code",
  "download-dir",
  "load-format",
  "tokenizer",
  "chat-template",
  "tool-call-parser",
  "enable-auto-tool-choice",
  "reasoning-parser",
  "max-logprobs",
  "seed",
  "api-key",
  "enforce-eager",
  "disable-log-stats",
] as const;

const ESSENTIAL_SET = new Set<string>(ESSENTIAL_FLAGS);

/** Rank within the Essentials tier, so it reads in reach-for order. */
export function essentialRank(name: string): number {
  const i = (ESSENTIAL_FLAGS as readonly string[]).indexOf(name);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

interface RawEntry {
  signature: string;
  helpLines: string[];
  group: string;
}

/** Splits the help dump into (signature, help) pairs grouped by section. */
export function extractEntries(text: string): RawEntry[] {
  const lines = text.split("\n");
  const entries: RawEntry[] = [];
  let group = "options";
  let current: RawEntry | null = null;

  for (const line of lines) {
    const section = SECTION_RE.exec(line);
    if (section) {
      if (current) entries.push(current);
      current = null;
      group = section[1];
      continue;
    }

    const entry = ENTRY_RE.exec(line);
    if (entry) {
      if (current) entries.push(current);
      // argparse puts help on the same line when the signature is short,
      // separated by a run of two or more spaces.
      const rest = entry[1];
      const split = /\s{2,}/.exec(rest);
      const signature = split ? rest.slice(0, split.index) : rest;
      const inlineHelp = split ? rest.slice(split.index).trim() : "";
      current = { signature, helpLines: inlineHelp ? [inlineHelp] : [], group };
      continue;
    }

    // Continuation of the current entry's help text.
    if (current && /^\s{4,}\S/.test(line)) {
      current.helpLines.push(line.trim());
      continue;
    }

    // A blank line inside a section ends nothing; a non-indented line does.
    if (line.trim() === "") continue;
    if (current) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

interface Signature {
  names: string[]; // long names, without dashes
  shorts: string[]; // short aliases, without dashes
  negatable: boolean;
  choices: string[] | null;
  variadic: boolean;
  hasValue: boolean;
}

/**
 * Splits an option signature on the commas that separate alternative spellings,
 * ignoring the commas inside a `{a,b,c}` choice list. Splitting naively is the
 * subtle bug this guards: `--fmt {auto,openai}` would otherwise parse as three
 * separate flags and lose its enum entirely.
 */
function splitTopLevel(sig: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of sig) {
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseSignature(sig: string): Signature {
  const names: string[] = [];
  const shorts: string[] = [];
  let choices: string[] | null = null;
  let variadic = false;
  let hasValue = false;
  let negatable = false;

  for (const part of splitTopLevel(sig)) {
    if (!part.startsWith("-")) continue;

    // `--api-key API_KEY [API_KEY ...]` → flag token then metavar tokens
    const [flagToken, ...valueTokens] = part.split(/\s+/);
    const bare = flagToken.replace(/^-{1,2}/, "");

    // Choices are attached to the flag token with no space: `--x {a,b,c}`
    // is split above, but `--x{a,b}` never occurs — argparse always spaces it.
    const valueBlob = valueTokens.join(" ");
    if (valueBlob) {
      hasValue = true;
      if (valueBlob.includes("[") && valueBlob.includes("...")) variadic = true;
      const ch = /^\{(.+)\}$/.exec(valueBlob.trim());
      if (ch) choices = ch[1].split(",").map((c) => c.trim());
    }

    const isLong = flagToken.startsWith("--");
    if (isLong) {
      if (bare.startsWith("no-")) negatable = true;
      else names.push(bare);
    } else {
      shorts.push(bare);
    }
  }

  // A `--no-x` with no positive sibling still describes flag `x`.
  if (names.length === 0 && negatable) {
    const m = /--no-([^\s,]+)/.exec(sig);
    if (m) names.push(m[1]);
  }

  return { names, shorts, negatable, choices, variadic, hasValue };
}

/** Pulls argparse's trailing `(default: …)` off the joined help text. */
export function splitDefault(help: string): { help: string; default: string | null } {
  const m = /\(default:\s*([\s\S]*?)\)\s*$/.exec(help);
  if (!m) return { help: help.trim(), default: null };
  const raw = m[1].replace(/\s+/g, " ").trim();
  return {
    help: help.slice(0, m.index).trim(),
    default: raw === "None" ? null : raw,
  };
}

/** Name fragments that reliably indicate a numeric flag when no default shows. */
const INT_HINTS = /(-size|-len|-length|-num-|-count|-port|-seed|-steps|-tokens|-seqs|-blocks|-workers|-rank|-gb|-timeout|-retries|-limit|-depth)$|^(seed|port|max-|min-)/;
const FLOAT_HINTS = /(utilization|fraction|ratio|-rate|threshold|temperature|-gb|scale)/;

export function inferType(
  sig: Signature,
  def: string | null,
  help: string,
  name: string,
): FlagType {
  if (sig.choices) return "enum";
  if (!sig.hasValue) return "boolean";
  if (sig.variadic) return "list";

  // JSON-shaped options (compilation config, hf overrides, chat kwargs).
  if (/valid JSON string|JSON key|dictionary|JSON object/i.test(help)) return "json";
  if (def && (def.startsWith("{") || def.startsWith("["))) return "json";

  if (def !== null) {
    if (/^-?\d+$/.test(def)) return "int";
    if (/^-?\d*\.\d+(e-?\d+)?$/i.test(def)) return "float";
    if (def === "True" || def === "False") return "boolean";
  }

  if (FLOAT_HINTS.test(name)) return "float";
  if (INT_HINTS.test(name)) return "int";
  return "string";
}

export function parseHelpText(text: string, vllmVersion: string): FlagSchema {
  const seen = new Map<string, FlagSpec>();
  const groups: string[] = [];

  for (const entry of extractEntries(text)) {
    const sig = parseSignature(entry.signature);
    if (sig.names.length === 0) continue;

    const name = sig.names[0];
    if (name === "help") continue;

    const joined = entry.helpLines.join(" ").replace(/\s+/g, " ").trim();
    const { help, default: def } = splitDefault(joined);
    const type = inferType(sig, def, help, name);

    // `--help=<group>` duplicates entries across sections; first wins so each
    // flag keeps the most specific group it was documented under.
    if (seen.has(name)) continue;

    if (!groups.includes(entry.group)) groups.push(entry.group);

    seen.set(name, {
      name,
      aliases: [...sig.names.slice(1), ...sig.shorts],
      group: entry.group,
      type,
      choices: sig.choices,
      default: def,
      help,
      negatable: sig.negatable,
      variadic: sig.variadic,
      essential: ESSENTIAL_SET.has(name),
    });
  }

  const flags = [...seen.values()].sort(
    (a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name),
  );

  return {
    vllmVersion,
    generatedAt: Date.now(),
    groups: groups.filter((g) => flags.some((f) => f.group === g)),
    flags,
  };
}

/** Coerces a form value to the type the flag expects, or reports why it can't. */
export function coerceFlagValue(
  spec: FlagSpec,
  raw: string | boolean | string[],
): { ok: true; value: string | number | boolean | string[] } | { ok: false; error: string } {
  if (spec.type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    return { ok: true, value: raw === "true" || raw === "True" || raw === "1" };
  }

  if (spec.type === "list") {
    const items = Array.isArray(raw)
      ? raw
      : String(raw)
          .split(/[,\s]+/)
          .filter(Boolean);
    return { ok: true, value: items };
  }

  const s = Array.isArray(raw) ? raw.join(",") : String(raw);

  if (spec.type === "enum") {
    if (spec.choices && !spec.choices.includes(s)) {
      return { ok: false, error: `Must be one of: ${spec.choices.join(", ")}` };
    }
    return { ok: true, value: s };
  }

  if (spec.type === "int") {
    if (!/^-?\d+$/.test(s.trim())) return { ok: false, error: "Must be a whole number" };
    return { ok: true, value: Number.parseInt(s, 10) };
  }

  if (spec.type === "float") {
    const n = Number.parseFloat(s);
    if (!Number.isFinite(n)) return { ok: false, error: "Must be a number" };
    return { ok: true, value: n };
  }

  if (spec.type === "json") {
    const t = s.trim();
    if (t === "") return { ok: true, value: "" };
    try {
      JSON.parse(t);
    } catch {
      return { ok: false, error: "Must be valid JSON" };
    }
    return { ok: true, value: t };
  }

  return { ok: true, value: s };
}
