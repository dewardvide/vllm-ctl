import "server-only";

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";

import type { HostSample } from "@/lib/types";

/**
 * Host CPU/RAM/disk sampling straight from /proc.
 *
 * `os.cpus()` reports cumulative times too, but it allocates a fresh object per
 * core per call; reading /proc/stat once and diffing is cheaper and gives the
 * same numbers.
 */

interface CpuTimes {
  idle: number;
  total: number;
}

export function parseProcStat(text: string): { total: CpuTimes; cores: CpuTimes[] } {
  let total: CpuTimes = { idle: 0, total: 0 };
  const cores: CpuTimes[] = [];

  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) continue;
    const parts = line.trim().split(/\s+/);
    const label = parts[0];
    // user nice system idle iowait irq softirq steal guest guest_nice
    const vals = parts.slice(1).map((v) => Number.parseInt(v, 10) || 0);
    if (vals.length < 4) continue;
    // idle + iowait are both "not doing work"
    const idle = vals[3] + (vals[4] ?? 0);
    const sum = vals.reduce((a, b) => a + b, 0);
    const t: CpuTimes = { idle, total: sum };
    if (label === "cpu") total = t;
    else cores.push(t);
  }
  return { total, cores };
}

function pctBusy(prev: CpuTimes | undefined, now: CpuTimes): number {
  if (!prev) return 0;
  const dTotal = now.total - prev.total;
  const dIdle = now.idle - prev.idle;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
}

export function parseMeminfo(text: string): {
  ramUsedMiB: number;
  ramTotalMiB: number;
  swapUsedMiB: number;
  swapTotalMiB: number;
} {
  const kv = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (m) kv.set(m[1], Number.parseInt(m[2], 10));
  }
  const kib = (k: string) => (kv.get(k) ?? 0) / 1024; // kB → MiB

  const total = kib("MemTotal");
  // MemAvailable is the kernel's own estimate and is far more honest than
  // MemFree, which excludes reclaimable page cache.
  const available = kv.has("MemAvailable") ? kib("MemAvailable") : kib("MemFree");
  const swapTotal = kib("SwapTotal");
  const swapFree = kib("SwapFree");

  return {
    ramUsedMiB: Math.max(0, total - available),
    ramTotalMiB: total,
    swapUsedMiB: Math.max(0, swapTotal - swapFree),
    swapTotalMiB: swapTotal,
  };
}

/** Cumulative CPU times from the previous tick, for delta computation. */
let prevTotal: CpuTimes | undefined;
let prevCores: CpuTimes[] = [];

export async function sampleHost(diskPath: string = os.homedir()): Promise<HostSample> {
  const [statText, memText] = await Promise.all([
    fsp.readFile("/proc/stat", "utf8").catch(() => ""),
    fsp.readFile("/proc/meminfo", "utf8").catch(() => ""),
  ]);

  const { total, cores } = parseProcStat(statText);
  const cpuPct = pctBusy(prevTotal, total);
  const coresPct = cores.map((c, i) => pctBusy(prevCores[i], c));
  prevTotal = total;
  prevCores = cores;

  const mem = parseMeminfo(memText);

  let diskUsedGiB = 0;
  let diskTotalGiB = 0;
  try {
    const s = fs.statfsSync(diskPath);
    const totalB = Number(s.blocks) * Number(s.bsize);
    const freeB = Number(s.bavail) * Number(s.bsize);
    diskTotalGiB = totalB / 1024 ** 3;
    diskUsedGiB = (totalB - freeB) / 1024 ** 3;
  } catch {
    /* non-fatal: disk figures simply read zero */
  }

  const [l1, l5, l15] = os.loadavg();

  return {
    cpuPct,
    coresPct,
    ...mem,
    loadAvg: [l1, l5, l15],
    diskUsedGiB,
    diskTotalGiB,
    uptimeS: os.uptime(),
  };
}

/** Test seam: clears the delta state so a fresh sequence starts clean. */
export function resetHostSampler() {
  prevTotal = undefined;
  prevCores = [];
}
