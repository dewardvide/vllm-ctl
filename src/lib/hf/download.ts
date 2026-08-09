import "server-only";

import { spawn, type ChildProcess } from "node:child_process";

import { getDb } from "@/lib/server/db";
import { hub } from "@/lib/server/broadcast";
import { effectiveHfToken, getSettings, resolveHfCli } from "@/lib/settings";
import type { DownloadJob } from "@/lib/types";

import { LineSplitter } from "@/lib/vllm/log-ring";

/**
 * Downloads models through the `hf` CLI.
 *
 * Reimplementing the transfer in Node would mean reimplementing resumption,
 * xet chunk dedup and multi-worker fetching — all of which the official client
 * already does well. What this module adds is progress the UI can render:
 * tqdm's carriage-return bars are parsed into structured percentages.
 */

export const DOWNLOADS_TOPIC = "downloads";

/** tqdm writes `Fetching 12 files:  45%|███ | 5/12 [...]` on one rewritten line. */
const FETCHING_RE = /Fetching\s+(\d+)\s+files:\s+(\d+)%/;
/** Per-file bars read `model-00001-of-00004.safetensors:  63%|... | 3.1G/4.9G`. */
const FILE_RE = /^(\S.*?):\s+(\d+)%\|.*?\|\s*([\d.]+[kKMGT]?)\/([\d.]+[kKMGT]?)/;

export function parseProgress(
  line: string,
): { pct?: number; message?: string; bytesDone?: number; bytesTotal?: number } | null {
  const fetching = FETCHING_RE.exec(line);
  if (fetching) {
    return { pct: Number(fetching[2]), message: `Fetching ${fetching[1]} files` };
  }

  const file = FILE_RE.exec(line);
  if (file) {
    return {
      pct: Number(file[2]),
      message: file[1].trim(),
      bytesDone: parseSize(file[3]),
      bytesTotal: parseSize(file[4]),
    };
  }
  return null;
}

/** tqdm's human sizes: `3.1G`, `812M`, `1.02k`. Decimal units, per tqdm. */
export function parseSize(s: string): number | undefined {
  const m = /^([\d.]+)\s*([kKMGT])?/.exec(s.trim());
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const mult: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Math.round(n * (m[2] ? mult[m[2]] : 1));
}

class DownloadManager {
  private procs = new Map<number, ChildProcess>();

  start(repo: string, revision = "main"): DownloadJob {
    const settings = getSettings();
    const cli = resolveHfCli(settings);
    if (!cli) {
      throw new Error(
        "The `hf` command was not found. Install huggingface_hub, or set the Python environment in Settings.",
      );
    }

    const db = getDb();
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO downloads (repo, revision, status, started_at) VALUES (?,?,?,?)`,
      )
      .run(repo, revision, "running", now);
    const id = Number(info.lastInsertRowid);

    const args = [
      "download",
      repo,
      "--revision",
      revision,
      "--cache-dir",
      settings.hfCacheDir,
    ];
    const token = effectiveHfToken(settings);
    if (token) args.push("--token", token);

    const proc = spawn(cli, args, {
      env: {
        ...process.env,
        HF_HUB_CACHE: settings.hfCacheDir,
        // tqdm renders to stderr and needs to believe it has a terminal width.
        COLUMNS: "120",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.procs.set(id, proc);

    // tqdm rewrites its bar with \r, so split on both terminators.
    const splitter = new LineSplitter();
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8").replace(/\r/g, "\n");
      for (const line of splitter.push(text)) {
        const p = parseProgress(line);
        if (p) this.update(id, p);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => this.finish(id, "failed", err.message));
    proc.on("exit", (code) => {
      this.procs.delete(id);
      if (code === 0) this.finish(id, "completed", null);
      else if (code === null) this.finish(id, "cancelled", "Cancelled.");
      else this.finish(id, "failed", `hf download exited with code ${code}.`);
    });

    const job = this.get(id)!;
    this.publish();
    return job;
  }

  cancel(id: number) {
    const proc = this.procs.get(id);
    if (!proc) return;
    proc.kill("SIGTERM");
    this.finish(id, "cancelled", "Cancelled.");
  }

  private update(
    id: number,
    p: { pct?: number; message?: string; bytesDone?: number; bytesTotal?: number },
  ) {
    getDb()
      .prepare(
        `UPDATE downloads
            SET pct = COALESCE(?, pct),
                message = COALESCE(?, message),
                bytes_done = COALESCE(?, bytes_done),
                bytes_total = COALESCE(?, bytes_total)
          WHERE id = ? AND status = 'running'`,
      )
      .run(p.pct ?? null, p.message ?? null, p.bytesDone ?? null, p.bytesTotal ?? null, id);
    this.publish();
  }

  private finish(id: number, status: DownloadJob["status"], error: string | null) {
    getDb()
      .prepare(
        `UPDATE downloads
            SET status = ?, error = ?, finished_at = ?, pct = CASE WHEN ? = 'completed' THEN 100 ELSE pct END
          WHERE id = ?`,
      )
      .run(status, error, Date.now(), status, id);
    this.publish();
  }

  get(id: number): DownloadJob | null {
    const row = getDb().prepare("SELECT * FROM downloads WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toJob(row) : null;
  }

  /** Everything still running, plus recent history for context. */
  list(limit = 20): DownloadJob[] {
    const rows = getDb()
      .prepare("SELECT * FROM downloads ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toJob);
  }

  publish() {
    hub().publish(DOWNLOADS_TOPIC, "state", { downloads: this.list() });
  }

  /** Marks rows left "running" by an app restart, whose processes are gone. */
  reconcile() {
    try {
      getDb()
        .prepare(
          `UPDATE downloads
              SET status = 'cancelled',
                  error = COALESCE(error, 'Interrupted by an app restart.'),
                  finished_at = COALESCE(finished_at, ?)
            WHERE status = 'running'`,
        )
        .run(Date.now());
    } catch {
      /* best effort */
    }
  }
}

function toJob(r: Record<string, unknown>): DownloadJob {
  return {
    id: r.id as number,
    repo: r.repo as string,
    revision: r.revision as string,
    status: r.status as DownloadJob["status"],
    pct: (r.pct as number) ?? 0,
    bytesDone: (r.bytes_done as number) ?? 0,
    bytesTotal: (r.bytes_total as number) ?? null,
    message: (r.message as string) ?? null,
    error: (r.error as string) ?? null,
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at as number) ?? null,
  };
}

declare global {
  var __vllmAdminDownloads: DownloadManager | undefined;
}

export function downloads(): DownloadManager {
  if (!globalThis.__vllmAdminDownloads) {
    globalThis.__vllmAdminDownloads = new DownloadManager();
    globalThis.__vllmAdminDownloads.reconcile();
  }
  return globalThis.__vllmAdminDownloads;
}
