import "server-only";

import fs from "node:fs";
import Database from "better-sqlite3";

import { PATHS } from "@/lib/paths";

/**
 * The SQLite handle, as a module-scope singleton.
 *
 * better-sqlite3 is synchronous, which is exactly what we want here: every
 * query in this app is a sub-millisecond local read, and the async overhead
 * would cost more than the work. Hot-path telemetry never touches this — it is
 * served from in-memory ring buffers and only *written* here in batches.
 */

declare global {
  // Survives Next's dev-mode module reloading so we don't leak handles.
  var __vllmAdminDb: Database.Database | undefined;
}

function open(): Database.Database {
  fs.mkdirSync(PATHS.dataDir, { recursive: true });
  const db = new Database(PATHS.db);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL"); // durable enough for telemetry, much faster
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function getDb(): Database.Database {
  if (!globalThis.__vllmAdminDb) globalThis.__vllmAdminDb = open();
  return globalThis.__vllmAdminDb;
}

/* -------------------------------------------------------------------------- */
/* migrations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Forward-only migrations, applied by comparing `user_version`. Each entry is
 * one schema step; never edit an entry that has shipped, append a new one.
 */
const MIGRATIONS: string[] = [
  /* 1 */ `
  -- A saved, reusable launch configuration.
  CREATE TABLE deployments (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    model        TEXT    NOT NULL,          -- HF repo id or local path
    served_name  TEXT,                      -- --served-model-name
    port         INTEGER,                   -- NULL = allocate at start time
    flags        TEXT    NOT NULL DEFAULT '{}', -- JSON: only non-default flags
    notes        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  -- One row per actual launch of a deployment.
  CREATE TABLE deployment_runs (
    id             INTEGER PRIMARY KEY,
    deployment_id  INTEGER REFERENCES deployments(id) ON DELETE SET NULL,
    port           INTEGER NOT NULL,
    pid            INTEGER,
    argv           TEXT    NOT NULL,        -- JSON array, exactly as spawned
    status         TEXT    NOT NULL,        -- see DeploymentStatus
    started_at     INTEGER NOT NULL,
    ready_at       INTEGER,                 -- first successful /health
    stopped_at     INTEGER,
    exit_code      INTEGER,
    exit_signal    TEXT,
    error          TEXT,
    log_path       TEXT
  );
  CREATE INDEX idx_runs_deployment ON deployment_runs(deployment_id, started_at DESC);
  CREATE INDEX idx_runs_status ON deployment_runs(status);

  -- Host + GPU telemetry. Written in batches from the sampler's ring buffer.
  CREATE TABLE telemetry_samples (
    ts            INTEGER NOT NULL,         -- epoch ms
    gpu_index     INTEGER NOT NULL,
    util_gpu      REAL,
    util_mem      REAL,
    mem_used_mib  REAL,
    mem_total_mib REAL,
    temp_c        REAL,
    power_w       REAL,
    power_cap_w   REAL,
    clock_sm_mhz  REAL,
    fan_pct       REAL,
    pstate        TEXT,
    cpu_pct       REAL,                     -- host-wide, duplicated per GPU row
    ram_used_mib  REAL,
    ram_total_mib REAL,
    PRIMARY KEY (ts, gpu_index)
  ) WITHOUT ROWID;

  -- Per-deployment engine metrics scraped from vLLM's Prometheus endpoint.
  CREATE TABLE deployment_metrics (
    ts                INTEGER NOT NULL,
    run_id            INTEGER NOT NULL REFERENCES deployment_runs(id) ON DELETE CASCADE,
    gen_tok_s         REAL,
    prompt_tok_s      REAL,
    requests_running  REAL,
    requests_waiting  REAL,
    kv_cache_pct      REAL,
    ttft_p50_ms       REAL,
    ttft_p95_ms       REAL,
    ttft_p99_ms       REAL,
    itl_p50_ms        REAL,
    itl_p95_ms        REAL,
    prefix_hit_pct    REAL,
    preemptions       REAL,
    PRIMARY KEY (ts, run_id)
  ) WITHOUT ROWID;

  -- A GuideLLM invocation.
  CREATE TABLE benchmark_runs (
    id               INTEGER PRIMARY KEY,
    name             TEXT,
    deployment_run_id INTEGER REFERENCES deployment_runs(id) ON DELETE SET NULL,
    model            TEXT,
    target           TEXT    NOT NULL,
    config           TEXT    NOT NULL,      -- JSON: the run builder's form state
    argv             TEXT    NOT NULL,      -- JSON array, exactly as spawned
    status           TEXT    NOT NULL,      -- queued|running|completed|failed|cancelled
    progress         REAL    NOT NULL DEFAULT 0,
    started_at       INTEGER NOT NULL,
    finished_at      INTEGER,
    exit_code        INTEGER,
    error            TEXT,
    result_path      TEXT,                  -- GuideLLM's raw benchmark.json
    log_path         TEXT
  );
  CREATE INDEX idx_bench_started ON benchmark_runs(started_at DESC);

  -- One row per strategy within a GuideLLM run (a sweep produces many).
  CREATE TABLE benchmark_results (
    id             INTEGER PRIMARY KEY,
    run_id         INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    idx            INTEGER NOT NULL,        -- ordinal within the run
    strategy       TEXT,                    -- synchronous|concurrent|constant|...
    rate           REAL,                    -- requested rate or stream count
    concurrency    REAL,                    -- measured mean concurrency
    started_at     INTEGER,
    finished_at    INTEGER,
    requests_ok    INTEGER,
    requests_err   INTEGER,
    req_per_s      REAL,
    output_tok_s   REAL,
    total_tok_s    REAL,
    ttft_mean_ms   REAL,
    ttft_p50_ms    REAL,
    ttft_p95_ms    REAL,
    ttft_p99_ms    REAL,
    itl_mean_ms    REAL,
    itl_p50_ms     REAL,
    itl_p95_ms     REAL,
    itl_p99_ms     REAL,
    e2e_mean_ms    REAL,
    e2e_p50_ms     REAL,
    e2e_p95_ms     REAL,
    e2e_p99_ms     REAL,
    prompt_tok_mean  REAL,
    output_tok_mean  REAL
  );
  CREATE INDEX idx_bench_results_run ON benchmark_results(run_id, idx);

  -- Model downloads driven through the hf CLI.
  CREATE TABLE downloads (
    id            INTEGER PRIMARY KEY,
    repo          TEXT    NOT NULL,
    revision      TEXT    NOT NULL DEFAULT 'main',
    status        TEXT    NOT NULL,         -- running|completed|failed|cancelled
    pct           REAL    NOT NULL DEFAULT 0,
    bytes_done    INTEGER NOT NULL DEFAULT 0,
    bytes_total   INTEGER,
    message       TEXT,
    error         TEXT,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER
  );
  CREATE INDEX idx_downloads_started ON downloads(started_at DESC);
  `,
];

function migrate(db: Database.Database) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${v + 1} failed: ${(err as Error).message}`);
    }
  }
}
