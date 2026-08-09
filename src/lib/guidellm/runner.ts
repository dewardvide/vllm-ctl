import "server-only";

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

import { PATHS } from "@/lib/paths";
import { getDb } from "@/lib/server/db";
import { hub } from "@/lib/server/broadcast";
import { getSettings, resolveExe } from "@/lib/settings";
import { LineSplitter } from "@/lib/vllm/log-ring";
import type { BenchmarkConfig, BenchmarkRun, BenchmarkResultRow } from "@/lib/types";

import { buildBenchmarkArgv, estimateRunSeconds } from "./argv";
import { parseReport } from "./ingest";

const exec = promisify(execFile);

/**
 * Runs GuideLLM benchmarks and ingests their results.
 *
 * Only one benchmark runs at a time: two concurrent load generators would
 * contend for the same GPU and neither result would mean anything.
 */

export const BENCHMARKS_TOPIC = "benchmarks";
export const benchLogTopic = (id: number) => `benchmark-logs:${id}`;

/** GuideLLM prints per-strategy progress the run page can turn into a bar. */
const PROGRESS_RE = /\((\d+)\s*\/\s*(\d+)\)|(\d+)%/;

class BenchmarkRunner {
  private active: { id: number; proc: ChildProcess } | null = null;

  get activeId(): number | null {
    return this.active?.id ?? null;
  }

  async guidellmVersion(): Promise<string | null> {
    const cli = this.cli();
    if (!cli) return null;
    try {
      const { stdout } = await exec(cli, ["--version"], { timeout: 60_000 });
      const m = /(\d+\.\d+\.\d+)/.exec(stdout);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  private cli(): string | null {
    const s = getSettings();
    return (
      resolveExe(s.guidellmBinDir, "guidellm") ??
      resolveExe(s.vllmBinDir, "guidellm")
    );
  }

  start(config: BenchmarkConfig): BenchmarkRun {
    if (this.active) {
      throw new Error(
        "A benchmark is already running. Two load generators on one GPU would invalidate both results.",
      );
    }
    const cli = this.cli();
    if (!cli) {
      throw new Error(
        "GuideLLM is not installed. Run `uv tool install 'guidellm[recommended]'`, then set its path in Settings.",
      );
    }

    const db = getDb();
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO benchmark_runs
           (name, deployment_run_id, model, target, config, argv, status, started_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        config.name || null,
        config.deploymentRunId,
        config.model,
        config.target,
        JSON.stringify(config),
        "[]",
        "running",
        now,
      );
    const id = Number(info.lastInsertRowid);

    const dir = path.join(PATHS.benchmarks, String(id));
    fs.mkdirSync(dir, { recursive: true });
    const resultPath = path.join(dir, "benchmark.json");
    const logPath = path.join(dir, "run.log");

    const argv = buildBenchmarkArgv(config, resultPath);
    db.prepare(
      "UPDATE benchmark_runs SET argv = ?, result_path = ?, log_path = ? WHERE id = ?",
    ).run(JSON.stringify([cli, ...argv]), resultPath, logPath, id);

    const logFile = fs.createWriteStream(logPath, { flags: "a" });
    const proc = spawn(cli, argv, {
      cwd: dir,
      env: { ...process.env, COLUMNS: "160", PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active = { id, proc };

    const splitter = new LineSplitter();
    let queued: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (queued.length === 0) return;
      const batch = queued;
      queued = [];
      hub().publish(benchLogTopic(id), "lines", batch);
    };

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8").replace(/\r/g, "\n");
      for (const line of splitter.push(text)) {
        // Strip ANSI so the stored log is readable as plain text.
        const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
        if (!clean) continue;
        logFile.write(clean + "\n");
        queued.push(clean);
        this.noteProgress(id, clean);
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 150);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => {
      logFile.end();
      this.finish(id, "failed", err.message, null);
    });

    proc.on("exit", (code) => {
      flush();
      logFile.end();
      this.active = null;
      if (code === 0) {
        try {
          this.ingest(id, resultPath);
          this.finish(id, "completed", null, code);
        } catch (err) {
          this.finish(id, "failed", `Result parsing failed: ${(err as Error).message}`, code);
        }
      } else if (code === null) {
        this.finish(id, "cancelled", "Cancelled.", null);
      } else {
        this.finish(
          id,
          "failed",
          `guidellm exited with code ${code}. Check the run log.`,
          code,
        );
      }
    });

    this.publish();
    return this.get(id)!;
  }

  cancel(id: number) {
    if (this.active?.id !== id) return;
    this.active.proc.kill("SIGINT");
    // GuideLLM writes partial results on SIGINT; give it a moment before force.
    setTimeout(() => {
      if (this.active?.id === id) this.active.proc.kill("SIGKILL");
    }, 8000);
  }

  private noteProgress(id: number, line: string) {
    const m = PROGRESS_RE.exec(line);
    if (!m) return;
    const pct = m[3]
      ? Number(m[3])
      : m[1] && m[2]
        ? (Number(m[1]) / Math.max(1, Number(m[2]))) * 100
        : null;
    if (pct == null || !Number.isFinite(pct)) return;
    getDb()
      .prepare("UPDATE benchmark_runs SET progress = ? WHERE id = ? AND status = 'running'")
      .run(Math.max(0, Math.min(100, pct)), id);
    this.publish();
  }

  private ingest(id: number, resultPath: string) {
    const json = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const rows = parseReport(json);
    const db = getDb();

    const stmt = db.prepare(`
      INSERT INTO benchmark_results
        (run_id, idx, strategy, rate, concurrency, started_at, finished_at,
         requests_ok, requests_err, req_per_s, output_tok_s, total_tok_s,
         ttft_mean_ms, ttft_p50_ms, ttft_p95_ms, ttft_p99_ms,
         itl_mean_ms, itl_p50_ms, itl_p95_ms, itl_p99_ms,
         e2e_mean_ms, e2e_p50_ms, e2e_p95_ms, e2e_p99_ms,
         prompt_tok_mean, output_tok_mean)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    db.transaction(() => {
      db.prepare("DELETE FROM benchmark_results WHERE run_id = ?").run(id);
      for (const r of rows) {
        stmt.run(
          id, r.idx, r.strategy, r.rate, r.concurrency, r.startedAt, r.finishedAt,
          r.requestsOk, r.requestsErr, r.reqPerS, r.outputTokS, r.totalTokS,
          r.ttftMeanMs, r.ttftP50Ms, r.ttftP95Ms, r.ttftP99Ms,
          r.itlMeanMs, r.itlP50Ms, r.itlP95Ms, r.itlP99Ms,
          r.e2eMeanMs, r.e2eP50Ms, r.e2eP95Ms, r.e2eP99Ms,
          r.promptTokMean, r.outputTokMean,
        );
      }
    })();
  }

  private finish(
    id: number,
    status: BenchmarkRun["status"],
    error: string | null,
    exitCode: number | null,
  ) {
    getDb()
      .prepare(
        `UPDATE benchmark_runs
            SET status = ?, error = ?, exit_code = ?, finished_at = ?,
                progress = CASE WHEN ? = 'completed' THEN 100 ELSE progress END
          WHERE id = ?`,
      )
      .run(status, error, exitCode, Date.now(), status, id);
    this.publish();
  }

  get(id: number): BenchmarkRun | null {
    const row = getDb().prepare("SELECT * FROM benchmark_runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRun(row) : null;
  }

  list(limit = 100): BenchmarkRun[] {
    const rows = getDb()
      .prepare("SELECT * FROM benchmark_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toRun);
  }

  results(id: number): BenchmarkResultRow[] {
    const rows = getDb()
      .prepare("SELECT * FROM benchmark_results WHERE run_id = ? ORDER BY idx")
      .all(id) as Record<string, unknown>[];
    return rows.map(toResult);
  }

  publish() {
    hub().publish(BENCHMARKS_TOPIC, "state", {
      runs: this.list(30),
      activeId: this.activeId,
    });
  }

  /** Marks runs orphaned by an app restart. */
  reconcile() {
    try {
      getDb()
        .prepare(
          `UPDATE benchmark_runs
              SET status = 'cancelled',
                  error = COALESCE(error, 'Interrupted by an app restart.'),
                  finished_at = COALESCE(finished_at, ?)
            WHERE status IN ('running','queued')`,
        )
        .run(Date.now());
    } catch {
      /* best effort */
    }
  }

  estimateSeconds = estimateRunSeconds;
}

function toRun(r: Record<string, unknown>): BenchmarkRun {
  return {
    id: r.id as number,
    name: (r.name as string) ?? null,
    deploymentRunId: (r.deployment_run_id as number) ?? null,
    model: (r.model as string) ?? null,
    target: r.target as string,
    config: JSON.parse((r.config as string) ?? "{}"),
    argv: JSON.parse((r.argv as string) ?? "[]"),
    status: r.status as BenchmarkRun["status"],
    progress: (r.progress as number) ?? 0,
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at as number) ?? null,
    exitCode: (r.exit_code as number) ?? null,
    error: (r.error as string) ?? null,
  };
}

function toResult(r: Record<string, unknown>): BenchmarkResultRow {
  const n = (k: string) => (r[k] as number) ?? null;
  return {
    id: r.id as number,
    runId: r.run_id as number,
    idx: r.idx as number,
    strategy: (r.strategy as string) ?? null,
    rate: n("rate"),
    concurrency: n("concurrency"),
    startedAt: n("started_at"),
    finishedAt: n("finished_at"),
    requestsOk: n("requests_ok"),
    requestsErr: n("requests_err"),
    reqPerS: n("req_per_s"),
    outputTokS: n("output_tok_s"),
    totalTokS: n("total_tok_s"),
    ttftMeanMs: n("ttft_mean_ms"),
    ttftP50Ms: n("ttft_p50_ms"),
    ttftP95Ms: n("ttft_p95_ms"),
    ttftP99Ms: n("ttft_p99_ms"),
    itlMeanMs: n("itl_mean_ms"),
    itlP50Ms: n("itl_p50_ms"),
    itlP95Ms: n("itl_p95_ms"),
    itlP99Ms: n("itl_p99_ms"),
    e2eMeanMs: n("e2e_mean_ms"),
    e2eP50Ms: n("e2e_p50_ms"),
    e2eP95Ms: n("e2e_p95_ms"),
    e2eP99Ms: n("e2e_p99_ms"),
    promptTokMean: n("prompt_tok_mean"),
    outputTokMean: n("output_tok_mean"),
  };
}

declare global {
  var __vllmAdminBench: BenchmarkRunner | undefined;
}

export function benchmarks(): BenchmarkRunner {
  if (!globalThis.__vllmAdminBench) {
    globalThis.__vllmAdminBench = new BenchmarkRunner();
    globalThis.__vllmAdminBench.reconcile();
  }
  return globalThis.__vllmAdminBench;
}

/** Telemetry samples covering a run's window, for the GPU overlay. */
export function telemetryForRun(runId: number) {
  const run = benchmarks().get(runId);
  if (!run) return [];
  const end = run.finishedAt ?? Date.now();
  return getDb()
    .prepare(
      `SELECT ts, util_gpu, mem_used_mib, power_w, temp_c, clock_sm_mhz
         FROM telemetry_samples
        WHERE gpu_index = 0 AND ts BETWEEN ? AND ?
        ORDER BY ts`,
    )
    .all(run.startedAt, end) as Array<{
    ts: number;
    util_gpu: number;
    mem_used_mib: number;
    power_w: number;
    temp_c: number;
    clock_sm_mhz: number;
  }>;
}
