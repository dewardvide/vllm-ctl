import "server-only";

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PATHS } from "@/lib/paths";
import { getSettings, resolveExe } from "@/lib/settings";
import type { FlagSchema } from "@/lib/types";

import { parseHelpText } from "./parse-help";

const exec = promisify(execFile);

/**
 * Produces the settings form's schema by asking the installed vLLM what it
 * supports.
 *
 * `vllm serve --help=all` imports torch, so it takes a few seconds — far too
 * slow to run per request. The result is therefore cached on disk keyed by
 * vLLM version and held in memory for the process lifetime, which makes the
 * form's data a static payload after the first load.
 */

let memo: FlagSchema | null = null;

export async function getVllmVersion(): Promise<string | null> {
  const vllm = resolveExe(getSettings().vllmBinDir, "vllm");
  if (!vllm) return null;
  try {
    const { stdout } = await exec(vllm, ["--version"], { timeout: 120_000 });
    // Output is a bare version string, sometimes preceded by log noise.
    const m = /(\d+\.\d+\.\d+(?:[.\w-]*)?)/.exec(stdout.trim());
    return m ? m[1] : stdout.trim() || null;
  } catch {
    return null;
  }
}

function cachePath(version: string): string {
  return path.join(PATHS.schemaCache, `vllm-${version}.json`);
}

export async function loadFlagSchema(opts: { refresh?: boolean } = {}): Promise<FlagSchema> {
  if (memo && !opts.refresh) return memo;

  const settings = getSettings();
  const vllm = resolveExe(settings.vllmBinDir, "vllm");
  if (!vllm) {
    throw new Error(
      "No vLLM executable found. Set the Python environment path in Settings.",
    );
  }

  const version = (await getVllmVersion()) ?? "unknown";
  const file = cachePath(version);

  if (!opts.refresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as FlagSchema;
      if (cached.flags?.length > 0) {
        memo = cached;
        return cached;
      }
    } catch {
      /* no usable cache — fall through and regenerate */
    }
  }

  const { stdout } = await exec(vllm, ["serve", "--help=all"], {
    timeout: 300_000,
    maxBuffer: 16 << 20,
    env: { ...process.env, VLLM_LOGGING_LEVEL: "ERROR" },
  });

  const schema = parseHelpText(stdout, version);
  if (schema.flags.length === 0) {
    throw new Error("Parsed no options from `vllm serve --help=all`.");
  }

  try {
    fs.mkdirSync(PATHS.schemaCache, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(schema));
  } catch {
    /* an uncacheable schema is slow, not broken */
  }

  memo = schema;
  return schema;
}

/** Non-throwing variant for pages that must render even without vLLM present. */
export async function tryLoadFlagSchema(): Promise<
  { ok: true; schema: FlagSchema } | { ok: false; error: string }
> {
  try {
    return { ok: true, schema: await loadFlagSchema() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function invalidateFlagSchema() {
  memo = null;
}
