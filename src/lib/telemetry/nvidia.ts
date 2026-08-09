import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GpuSample } from "@/lib/types";

const exec = promisify(execFile);

/**
 * nvidia-smi is invoked one-shot per tick rather than with `-l 1`.
 *
 * Loop mode looks cheaper, but nvidia-smi block-buffers its stdout when it is
 * not attached to a tty (and ignores stdbuf), so a piped `-l 1` emits nothing
 * for seconds at a time. A one-shot query measures ~24 ms on this machine,
 * which is a rounding error at 1 Hz.
 */

const GPU_FIELDS = [
  "index",
  "name",
  "utilization.gpu",
  "utilization.memory",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "power.limit",
  "clocks.sm",
  "fan.speed",
  "pstate",
] as const;

/** `[Not Supported]` and `[N/A]` appear on consumer cards for some fields. */
function num(raw: string): number {
  const v = Number.parseFloat(raw.trim());
  return Number.isFinite(v) ? v : 0;
}

export function parseGpuCsv(stdout: string): GpuSample[] {
  const out: GpuSample[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const c = t.split(",").map((s) => s.trim());
    if (c.length < GPU_FIELDS.length) continue;
    out.push({
      index: num(c[0]),
      name: c[1],
      utilGpu: num(c[2]),
      utilMem: num(c[3]),
      memUsedMiB: num(c[4]),
      memTotalMiB: num(c[5]),
      tempC: num(c[6]),
      powerW: num(c[7]),
      powerCapW: num(c[8]),
      clockSmMhz: num(c[9]),
      fanPct: num(c[10]),
      pstate: c[11] || "—",
    });
  }
  return out;
}

export async function queryGpus(): Promise<GpuSample[]> {
  const { stdout } = await exec(
    "nvidia-smi",
    [
      `--query-gpu=${GPU_FIELDS.join(",")}`,
      "--format=csv,noheader,nounits",
    ],
    { timeout: 5000, maxBuffer: 1 << 20 },
  );
  return parseGpuCsv(stdout);
}

export interface ComputeApp {
  pid: number;
  usedMiB: number;
}

export function parseComputeAppsCsv(stdout: string): ComputeApp[] {
  const out: ComputeApp[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const c = t.split(",").map((s) => s.trim());
    if (c.length < 2) continue;
    const pid = Number.parseInt(c[0], 10);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, usedMiB: num(c[1]) });
  }
  return out;
}

/**
 * Per-process VRAM, used to attribute slices of the headroom rail to the
 * deployment that actually owns them.
 */
export async function queryComputeApps(): Promise<ComputeApp[]> {
  try {
    const { stdout } = await exec(
      "nvidia-smi",
      ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
      { timeout: 5000, maxBuffer: 1 << 20 },
    );
    return parseComputeAppsCsv(stdout);
  } catch {
    return [];
  }
}

export async function nvidiaSmiAvailable(): Promise<boolean> {
  try {
    await exec("nvidia-smi", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
