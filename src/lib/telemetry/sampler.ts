import "server-only";

import fs from "node:fs";

import { RingBuffer } from "@/lib/server/ring-buffer";
import { hub } from "@/lib/server/broadcast";
import { getDb } from "@/lib/server/db";
import { getSettings } from "@/lib/settings";
import type { TelemetrySample } from "@/lib/types";

import { queryGpus, queryComputeApps, type ComputeApp } from "./nvidia";
import { sampleHost } from "./host";

/**
 * The single telemetry loop.
 *
 * One instance exists per Node process no matter how many browser tabs are
 * open: viewers attach to the broadcast hub, not to their own sampler. The
 * ring buffer holds the recent window so a newly-opened chart paints fully
 * populated on its very first frame, with no DB round-trip.
 */

export const TELEMETRY_TOPIC = "telemetry";

/** ~15 minutes at 1 Hz. Sized for the dashboard's longest live window. */
const WINDOW_SAMPLES = 900;

/** Telemetry rows are batched to keep SQLite writes off the 1 Hz path. */
const FLUSH_EVERY = 15;

class TelemetrySampler {
  readonly buffer = new RingBuffer<TelemetrySample>(WINDOW_SAMPLES);
  /** Per-PID VRAM from the last tick, for attributing rail segments. */
  computeApps: ComputeApp[] = [];
  gpuUnavailableReason: string | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pending: TelemetrySample[] = [];
  private ticking = false;

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }

  private schedule() {
    if (!this.running) return;
    const period = getSettings().sampleIntervalMs;
    this.timer = setTimeout(() => void this.tick(), period);
  }

  private async tick() {
    // Guard against overlap if a sample ever runs longer than the period.
    if (this.ticking) {
      this.schedule();
      return;
    }
    this.ticking = true;
    try {
      const [gpus, host, apps] = await Promise.all([
        queryGpus().catch((e: Error) => {
          this.gpuUnavailableReason = e.message;
          return [];
        }),
        sampleHost(),
        queryComputeApps(),
      ]);
      if (gpus.length > 0) this.gpuUnavailableReason = null;
      this.computeApps = apps;

      const sample: TelemetrySample = { ts: Date.now(), gpus, host };
      this.buffer.push(sample);
      this.pending.push(sample);
      if (this.pending.length >= FLUSH_EVERY) this.flush();

      hub().publish(TELEMETRY_TOPIC, "sample", sample);
    } catch {
      // Never let a bad tick kill the loop; the next one may well succeed.
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  private flush() {
    if (this.pending.length === 0) return;
    const rows = this.pending;
    this.pending = [];
    try {
      const db = getDb();
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO telemetry_samples
          (ts, gpu_index, util_gpu, util_mem, mem_used_mib, mem_total_mib,
           temp_c, power_w, power_cap_w, clock_sm_mhz, fan_pct, pstate,
           cpu_pct, ram_used_mib, ram_total_mib)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const insertAll = db.transaction((samples: TelemetrySample[]) => {
        for (const s of samples) {
          for (const g of s.gpus) {
            stmt.run(
              s.ts, g.index, g.utilGpu, g.utilMem, g.memUsedMiB, g.memTotalMiB,
              g.tempC, g.powerW, g.powerCapW, g.clockSmMhz, g.fanPct, g.pstate,
              s.host.cpuPct, s.host.ramUsedMiB, s.host.ramTotalMiB,
            );
          }
        }
      });
      insertAll(rows);
    } catch {
      // Losing a telemetry batch is acceptable; blocking the loop is not.
    }
  }

  /** Most recent `count` samples, oldest first. */
  window(count = WINDOW_SAMPLES): TelemetrySample[] {
    return this.buffer.toArray(count);
  }

  latest(): TelemetrySample | undefined {
    return this.buffer.last();
  }

  /**
   * VRAM in MiB held by a process *or any of its descendants*.
   *
   * vLLM's API server does not touch the GPU itself — it forks a
   * `VLLM::EngineCore` worker that owns every byte of the allocation. Matching
   * only the pid we spawned therefore reports null for a deployment that is
   * plainly using 10 GiB, so ancestry is walked instead.
   */
  vramForPid(pid: number | null): number | null {
    if (pid == null) return null;
    let total = 0;
    let found = false;
    for (const app of this.computeApps) {
      if (app.pid === pid || isDescendantOf(app.pid, pid)) {
        total += app.usedMiB;
        found = true;
      }
    }
    return found ? total : null;
  }
}

/** Parent pid from /proc, or null when the process is gone. */
function parentOf(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field is parenthesised and may contain spaces, so fields are
    // counted from after the closing paren: state, then ppid.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number.parseInt(after[1], 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

function isDescendantOf(pid: number, ancestor: number): boolean {
  let current = parentOf(pid);
  // Bounded walk: pid 1 terminates it, and the depth guard protects against a
  // pathological /proc read.
  for (let depth = 0; current != null && current > 1 && depth < 24; depth++) {
    if (current === ancestor) return true;
    current = parentOf(current);
  }
  return false;
}

declare global {
  var __vllmAdminSampler: TelemetrySampler | undefined;
}

export function sampler(): TelemetrySampler {
  if (!globalThis.__vllmAdminSampler) {
    globalThis.__vllmAdminSampler = new TelemetrySampler();
    globalThis.__vllmAdminSampler.start();
  }
  return globalThis.__vllmAdminSampler;
}

/**
 * Deletes telemetry older than the retention window. Called on boot; cheap
 * enough that a periodic sweep would be over-engineering for a local tool.
 */
export function pruneTelemetry() {
  try {
    const hours = getSettings().telemetryRetentionHours;
    const cutoff = Date.now() - hours * 3600_000;
    getDb().prepare("DELETE FROM telemetry_samples WHERE ts < ?").run(cutoff);
  } catch {
    /* pruning is best-effort */
  }
}
