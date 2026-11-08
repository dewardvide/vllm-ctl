import "server-only";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSettings, resolveExe } from "@/lib/settings";
import { buildLlamaArgv, isLfm, lfmCompatible } from "./llamacpp";
import { buildServeArgv, type LaunchSpec, type HostPort } from "@/lib/vllm/argv";
const exec = promisify(execFile);
export function resolveLlama() {
  const s = getSettings();
  if (s.llamaExecutable) return { executable: s.llamaExecutable, mode: s.llamaInvocation };
  for (const name of ["llama-server", "llama"]) for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const executable = resolveExe(dir, name);
    if (executable) return { executable, mode: name === "llama" ? "serve" as const : "server" as const };
  }
  throw new Error("llama.cpp is not installed or on PATH. Configure its executable in Settings.");
}
export async function probeLlama() {
  const resolved = resolveLlama();
  const prefix = resolved.mode === "serve" ? ["serve"] : [];
  const results = await Promise.all(["--version", "--help"].map(flag => exec(resolved.executable, [...prefix, flag], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 })));
  return { ...resolved, version: (results[0].stdout + results[0].stderr).trim(), help: results[1].stdout + results[1].stderr };
}
export async function prepareLaunch(spec: LaunchSpec, hp: HostPort) {
  if (spec.rawArgv && spec.executable) return { executable: spec.executable, argv: [...spec.rawArgv] };
  if ((spec.backend ?? "vllm") === "vllm") {
    const executable = resolveExe(getSettings().vllmBinDir, "vllm");
    if (!executable) throw new Error("No vLLM executable found. Configure Settings.");
    return { executable, argv: buildServeArgv(spec, hp) };
  }
  if (spec.backend !== "llamacpp") throw new Error("Unknown deployment backend.");
  const probe = await probeLlama();
  const argv = buildLlamaArgv(spec, hp, probe.mode);
  if (isLfm(spec.model) && !lfmCompatible(probe.version)) throw new Error("LFM3-Omni requires llama.cpp b11960 / v0.8.0 or newer. Upgrade your installed executable.");
  const supported = new Set(probe.help.match(/--[a-z][a-z0-9-]*/g) ?? []);
  for (const arg of argv.filter(a => a.startsWith("--"))) if (!supported.has(arg)) throw new Error(`Installed llama.cpp does not support ${arg}. Upgrade or remove this option.`);
  for (const file of [spec.modelSource?.kind === "local" ? spec.model : null, spec.flags.mmproj]) if (file) {
    fs.accessSync(String(file), fs.constants.R_OK);
    if (!fs.statSync(String(file)).isFile()) throw new Error(`Not a readable file: ${file}`);
  }
  return { executable: probe.executable, argv };
}
