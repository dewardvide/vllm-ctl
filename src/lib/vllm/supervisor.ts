import "server-only";

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { PATHS } from "@/lib/paths";
import { getDb } from "@/lib/server/db";
import { hub } from "@/lib/server/broadcast";
import { getSettings, resolveExe, effectiveHfToken, detectCudaHome } from "@/lib/settings";
import { sampler } from "@/lib/telemetry/sampler";
import type { DeploymentStatus, LiveDeployment } from "@/lib/types";

import { LogRing, LineSplitter, type LogLine } from "./log-ring";
import { classifyLogLine } from "./phase";
import { buildServeArgv, type LaunchSpec } from "./argv";

/**
 * Supervises `vllm serve` child processes.
 *
 * One registry per Node process, holding every running deployment. Deliberately
 * *not* backed by request-scoped state: a start request returns as soon as the
 * process is spawned, and the lifecycle continues under this singleton while
 * the UI watches through SSE.
 */

export const DEPLOYMENTS_TOPIC = "deployments";
export const logTopic = (runId: number) => `deployment-logs:${runId}`;

/** How long a launch may sit below `healthy` before we give up on it. */
const READY_TIMEOUT_MS = 20 * 60_000; // first run may download tens of GB
const HEALTH_POLL_MS = 1500;
/** Grace period between SIGINT and SIGKILL when stopping. */
const STOP_GRACE_MS = 20_000;

interface Supervised {
  runId: number;
  deploymentId: number | null;
  name: string;
  model: string;
  servedName: string | null;
  port: number;
  proc: ChildProcess;
  status: DeploymentStatus;
  phase: string | null;
  error: string | null;
  startedAt: number;
  readyAt: number | null;
  logs: LogRing;
  logFile: fs.WriteStream | null;
  healthTimer: ReturnType<typeof setInterval> | null;
  readyDeadline: ReturnType<typeof setTimeout> | null;
  /** Set once the user asked to stop, so exit is reported as intentional. */
  stopping: boolean;
}

class Supervisor {
  private procs = new Map<number, Supervised>();

  /* ---------------------------------------------------------------------- */
  /* lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  async start(spec: LaunchSpec): Promise<{ runId: number; port: number }> {
    const settings = getSettings();
    const vllm = resolveExe(settings.vllmBinDir, "vllm");
    if (!vllm) {
      throw new Error(
        "No vLLM executable found. Set the Python environment path in Settings.",
      );
    }

    const port = spec.port ?? (await this.allocatePort());
    if (await isPortBusy(port)) {
      throw new Error(`Port ${port} is already in use.`);
    }

    const argv = buildServeArgv(spec, { host: settings.serveHost, port });

    const db = getDb();
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO deployment_runs
           (deployment_id, port, argv, status, started_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(spec.deploymentId ?? null, port, JSON.stringify([vllm, ...argv]), "starting", now);
    const runId = Number(info.lastInsertRowid);

    fs.mkdirSync(PATHS.logs, { recursive: true });
    const logPath = path.join(PATHS.logs, `run-${runId}.log`);
    db.prepare("UPDATE deployment_runs SET log_path = ? WHERE id = ?").run(logPath, runId);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HF_HUB_CACHE: settings.hfCacheDir,
      // vLLM's logs are worth far more than the few ms of unbuffered writes.
      PYTHONUNBUFFERED: "1",
      ...spec.env,
    };

    // Put the virtualenv's own bin directory on PATH, the way `activate` would.
    // Spawning `vllm` by absolute path is not enough: it shells out to build
    // tools that live beside it — `ninja` for torch's JIT extensions — and
    // without this they are invisible and the engine dies mid-initialisation.
    const pathParts: string[] = [];
    if (settings.vllmBinDir) pathParts.push(settings.vllmBinDir);

    // vLLM JIT-compiles kernels at engine init and resolves nvcc through
    // CUDA_HOME. Without this a machine that has only the NVIDIA driver fails
    // every launch, even though torch ships a usable toolkit in site-packages.
    const cudaHome = settings.cudaHome ?? detectCudaHome(settings.vllmBinDir);
    if (cudaHome) {
      env.CUDA_HOME = cudaHome;
      pathParts.push(path.join(cudaHome, "bin"));
    }

    if (pathParts.length > 0) {
      env.PATH = [...pathParts, env.PATH ?? ""].filter(Boolean).join(path.delimiter);
    }
    const token = effectiveHfToken(settings);
    if (token) env.HF_TOKEN = token;

    const proc = spawn(vllm, argv, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so stopping kills the engine's worker children too.
      detached: true,
    });

    const sup: Supervised = {
      runId,
      deploymentId: spec.deploymentId ?? null,
      name: spec.name,
      model: spec.model,
      servedName: spec.servedName ?? null,
      port,
      proc,
      status: "starting",
      phase: null,
      error: null,
      startedAt: now,
      readyAt: null,
      logs: new LogRing(),
      logFile: fs.createWriteStream(logPath, { flags: "a" }),
      healthTimer: null,
      readyDeadline: null,
      stopping: false,
    };
    this.procs.set(runId, sup);

    db.prepare("UPDATE deployment_runs SET pid = ? WHERE id = ?").run(proc.pid ?? null, runId);
    this.writePidFile();

    this.wireOutput(sup, "stdout");
    this.wireOutput(sup, "stderr");

    proc.on("error", (err) => {
      this.fail(sup, `Failed to launch: ${err.message}`);
    });

    proc.on("exit", (code, signal) => {
      this.onExit(sup, code, signal);
    });

    sup.healthTimer = setInterval(() => void this.pollHealth(sup), HEALTH_POLL_MS);
    sup.readyDeadline = setTimeout(() => {
      if (sup.status === "starting" || sup.status === "loading") {
        this.fail(sup, `Did not become healthy within ${Math.round(READY_TIMEOUT_MS / 60000)} minutes.`);
        void this.stop(runId);
      }
    }, READY_TIMEOUT_MS);

    this.publish();
    return { runId, port };
  }

  async stop(runId: number): Promise<void> {
    const sup = this.procs.get(runId);
    if (!sup) return;
    if (sup.stopping) return;

    sup.stopping = true;
    this.setStatus(sup, "stopping");

    // SIGINT to the whole process group: vLLM installs a handler for it and
    // shuts the engine down cleanly, releasing VRAM. SIGTERM leaves workers.
    killGroup(sup.proc.pid, "SIGINT");

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killGroup(sup.proc.pid, "SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      sup.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async restart(runId: number): Promise<{ runId: number; port: number } | null> {
    const sup = this.procs.get(runId);
    if (!sup) return null;
    const spec = this.specFromRun(sup);
    await this.stop(runId);
    return this.start(spec);
  }

  private specFromRun(sup: Supervised): LaunchSpec {
    const row = getDb()
      .prepare("SELECT argv FROM deployment_runs WHERE id = ?")
      .get(sup.runId) as { argv: string } | undefined;
    return {
      deploymentId: sup.deploymentId,
      name: sup.name,
      model: sup.model,
      servedName: sup.servedName,
      port: sup.port,
      flags: {},
      // Reuse the exact argv from the original launch so a restart is faithful
      // even if the saved profile has been edited since.
      rawArgv: row ? (JSON.parse(row.argv) as string[]).slice(1) : undefined,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* process plumbing                                                        */
  /* ---------------------------------------------------------------------- */

  private wireOutput(sup: Supervised, stream: "stdout" | "stderr") {
    const src = stream === "stdout" ? sup.proc.stdout : sup.proc.stderr;
    if (!src) return;
    const splitter = new LineSplitter();
    src.setEncoding("utf8");

    // Coalesce SSE frames: a burst of a hundred lines becomes one flush rather
    // than a hundred, which is what stops CUDA graph capture stalling the loop.
    let queued: LogLine[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (queued.length === 0) return;
      const batch = queued;
      queued = [];
      hub().publish(logTopic(sup.runId), "lines", batch);
    };

    src.on("data", (chunk: string) => {
      // Weight-download and graph-capture progress bars are redrawn with \r and
      // carry no newline until they finish. Splitting on \n alone would buffer
      // the entire download as one unterminated line, so the log would sit
      // silent for minutes during exactly the phase the user wants to watch.
      for (const text of splitter.push(chunk.replace(/\r/g, "\n"))) {
        const line = sup.logs.append(stream, text);
        sup.logFile?.write(text + "\n");
        queued.push(line);
        this.applyHint(sup, text);
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
    });

    src.on("end", () => {
      for (const text of splitter.flush()) {
        const line = sup.logs.append(stream, text);
        sup.logFile?.write(text + "\n");
        queued.push(line);
      }
      flush();
    });
  }

  private applyHint(sup: Supervised, text: string) {
    const hint = classifyLogLine(text);
    if (!hint) return;
    if (hint.fatal) {
      sup.error = hint.fatal;
      this.publish();
      return;
    }
    let changed = false;
    if (hint.phase && hint.phase !== sup.phase) {
      sup.phase = hint.phase;
      changed = true;
    }
    // A log line may promote starting → loading, but never claims `healthy`:
    // only a real /health response does that.
    if (hint.status === "loading" && sup.status === "starting") {
      sup.status = "loading";
      this.persistStatus(sup);
      changed = true;
    }
    if (changed) this.publish();
  }

  private async pollHealth(sup: Supervised) {
    if (sup.status === "stopping" || sup.status === "stopped") return;
    const ok = await probeHealth(sup.port);
    if (!ok) return;

    if (sup.status !== "healthy") {
      sup.status = "healthy";
      sup.readyAt = Date.now();
      sup.phase = "serving";
      sup.error = null;
      getDb()
        .prepare("UPDATE deployment_runs SET status = 'healthy', ready_at = ? WHERE id = ?")
        .run(sup.readyAt, sup.runId);
      if (sup.readyDeadline) {
        clearTimeout(sup.readyDeadline);
        sup.readyDeadline = null;
      }
      this.publish();
    }
  }

  private onExit(sup: Supervised, code: number | null, signal: NodeJS.Signals | null) {
    if (sup.healthTimer) clearInterval(sup.healthTimer);
    if (sup.readyDeadline) clearTimeout(sup.readyDeadline);
    sup.logFile?.end();
    sup.logFile = null;

    const intentional = sup.stopping;
    sup.status = intentional ? "stopped" : code === 0 ? "stopped" : "crashed";
    if (!intentional && !sup.error) {
      sup.error =
        signal != null
          ? `Process was killed by ${signal}.`
          : `Process exited with code ${code}. See the log for details.`;
    }

    getDb()
      .prepare(
        `UPDATE deployment_runs
            SET status = ?, stopped_at = ?, exit_code = ?, exit_signal = ?, error = ?
          WHERE id = ?`,
      )
      .run(sup.status, Date.now(), code, signal, sup.error, sup.runId);

    this.procs.delete(sup.runId);
    this.writePidFile();
    // Publish the terminal state, then again so the UI settles on the list
    // without the exited entry still occupying a slot.
    hub().publish(DEPLOYMENTS_TOPIC, "exited", {
      runId: sup.runId,
      status: sup.status,
      error: sup.error,
    });
    this.publish();
  }

  private fail(sup: Supervised, message: string) {
    sup.error = message;
    sup.status = "failed";
    this.persistStatus(sup);
    this.publish();
  }

  private setStatus(sup: Supervised, status: DeploymentStatus) {
    sup.status = status;
    this.persistStatus(sup);
    this.publish();
  }

  private persistStatus(sup: Supervised) {
    try {
      getDb()
        .prepare("UPDATE deployment_runs SET status = ?, error = ? WHERE id = ?")
        .run(sup.status, sup.error, sup.runId);
    } catch {
      /* status persistence is advisory; the in-memory view is authoritative */
    }
  }

  /* ---------------------------------------------------------------------- */
  /* views                                                                   */
  /* ---------------------------------------------------------------------- */

  list(): LiveDeployment[] {
    const s = sampler();
    return [...this.procs.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((d) => ({
        runId: d.runId,
        deploymentId: d.deploymentId,
        name: d.name,
        model: d.model,
        servedName: d.servedName,
        port: d.port,
        pid: d.proc.pid ?? null,
        status: d.status,
        startedAt: d.startedAt,
        readyAt: d.readyAt,
        phase: d.phase,
        error: d.error,
        vramMiB: s.vramForPid(d.proc.pid ?? null),
        // Read through the global rather than importing the poller: the poller
        // imports this module, and a static cycle between them would leave one
        // of the two singletons undefined at module-eval time.
        metrics: globalThis.__vllmAdminMetrics?.get(d.runId) ?? null,
      }));
  }

  get(runId: number): Supervised | undefined {
    return this.procs.get(runId);
  }

  logsFor(runId: number, count = 500): LogLine[] {
    return this.procs.get(runId)?.logs.tail(count) ?? [];
  }

  /** MiB of VRAM currently held by all supervised processes. */
  attributedVramMiB(): number {
    const s = sampler();
    let total = 0;
    for (const d of this.procs.values()) {
      total += s.vramForPid(d.proc.pid ?? null) ?? 0;
    }
    return total;
  }

  publish(): void {
    hub().publish(DEPLOYMENTS_TOPIC, "state", { live: this.list() });
  }

  /* ---------------------------------------------------------------------- */
  /* ports and orphans                                                       */
  /* ---------------------------------------------------------------------- */

  async allocatePort(): Promise<number> {
    const { portRangeStart, portRangeEnd } = getSettings();
    const taken = new Set([...this.procs.values()].map((d) => d.port));
    for (let p = portRangeStart; p <= portRangeEnd; p++) {
      if (taken.has(p)) continue;
      if (!(await isPortBusy(p))) return p;
    }
    throw new Error(
      `No free port in range ${portRangeStart}–${portRangeEnd}. Widen the range in Settings.`,
    );
  }

  private writePidFile() {
    try {
      fs.mkdirSync(PATHS.dataDir, { recursive: true });
      const entries = [...this.procs.values()].map((d) => ({
        runId: d.runId,
        pid: d.proc.pid,
        port: d.port,
      }));
      fs.writeFileSync(PATHS.pidFile, JSON.stringify(entries, null, 2));
    } catch {
      /* the pid file is a recovery aid, not a source of truth */
    }
  }

  /**
   * Cleans up after an unclean shutdown of this app.
   *
   * Any vLLM process we started is now unparented and still holding VRAM, and
   * we can no longer stream its logs, so re-adopting it is not possible.
   * Killing it is the honest outcome: it keeps the rail truthful and stops
   * phantom deployments appearing in the UI.
   */
  async reconcileOrphans(): Promise<void> {
    let entries: Array<{ runId: number; pid: number; port: number }> = [];
    try {
      entries = JSON.parse(fs.readFileSync(PATHS.pidFile, "utf8"));
    } catch {
      return;
    }

    for (const e of entries) {
      if (!e.pid || !isAlive(e.pid)) continue;
      killGroup(e.pid, "SIGINT");
    }

    try {
      fs.writeFileSync(PATHS.pidFile, "[]");
    } catch {
      /* best effort */
    }

    // Any run still marked live in the DB certainly is not.
    try {
      getDb()
        .prepare(
          `UPDATE deployment_runs
              SET status = 'crashed',
                  stopped_at = COALESCE(stopped_at, ?),
                  error = COALESCE(error, 'Interrupted by an app restart.')
            WHERE status IN ('starting','loading','healthy','stopping')`,
        )
        .run(Date.now());
    } catch {
      /* best effort */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signals the process *group*. vLLM spawns engine-core workers; signalling only
 * the parent leaves them alive and holding VRAM.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}

async function probeHealth(port: number): Promise<boolean> {
  const ctl = AbortController ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: ctl?.signal,
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

declare global {
  var __vllmAdminSupervisor: Supervisor | undefined;
}

export function supervisor(): Supervisor {
  if (!globalThis.__vllmAdminSupervisor) {
    globalThis.__vllmAdminSupervisor = new Supervisor();
  }
  return globalThis.__vllmAdminSupervisor;
}
