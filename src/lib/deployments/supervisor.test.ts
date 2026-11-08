import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
vi.mock("@/lib/telemetry/sampler", () => ({ sampler: () => ({ vramForPid: () => null }) }));
let dir: string;
let supervisor: import("./supervisor").Supervisor;
let settings: typeof import("@/lib/settings");
let db: ReturnType<typeof import("@/lib/server/db").getDb>;
const spec = { backend: "llamacpp" as const, name: "fake", model: "org/fake", modelSource: { kind: "hub" as const, quantization: "Q4_K_M" }, flags: {} };
const eventually = async (fn: () => boolean) => { await vi.waitFor(() => expect(fn()).toBe(true), { timeout: 4000, interval: 20 }); };
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-test-"));
  process.env.VLLM_ADMIN_DATA_DIR = dir;
  vi.resetModules();
  settings = await import("@/lib/settings");
  const executable = path.join(dir, "fake llama");
  fs.writeFileSync(executable, `#!${process.execPath}
const http = require('node:http');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('version: 11960 (test)'); process.exit(); }
if (args.includes('--help')) { console.log('--hf-repo --hf-file --host --port --alias --metrics --model --gpu-layers --reasoning --temp'); process.exit(); }
const behavior = process.env.FAKE_BEHAVIOR;
if (behavior === 'failure') { console.error('failed to load model'); process.exit(1); }
if (behavior === 'child') {
 const child = spawn(process.execPath, ['-e', 'process.on("SIGINT",()=>{}); setInterval(()=>{},1000)'], {stdio:'ignore'});
 fs.writeFileSync(process.env.FAKE_CHILD_FILE, String(child.pid));
}
console.log('loading model');
const started = Date.now();
const server = http.createServer((req,res) => {
 const loading = behavior === 'timeout' || Date.now()-started < 80;
 res.writeHead(loading ? 503 : 200, {'content-type':'application/json'});
 res.end(JSON.stringify({status: loading ? 'loading model' : 'ok'}));
});
server.listen(Number(args[args.indexOf('--port')+1]), args[args.indexOf('--host')+1]);
if (behavior === 'crash') setTimeout(()=>process.exit(3), 250);
process.on('SIGINT',()=>server.close(()=>process.exit()));
`);
  fs.chmodSync(executable, 0o755);
  settings.saveSettings({ llamaExecutable: executable, llamaInvocation: "server", llamaCacheDir: dir, portRangeStart: 19200, portRangeEnd: 19220 });
  db = (await import("@/lib/server/db")).getDb();
  const { Supervisor } = await import("./supervisor");
  supervisor = new Supervisor({ readyTimeoutMs: 700, healthPollMs: 25, stopGraceMs: 150 });
});
afterAll(async () => {
  for (const run of supervisor.list()) await supervisor.stop(run.runId);
  db.close(); globalThis.__vllmAdminDb = undefined;
  delete process.env.VLLM_ADMIN_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});
it("loads, becomes healthy, snapshots executable/host/arguments and restarts faithfully", async () => {
  const first = await supervisor.start(spec);
  await eventually(() => supervisor.get(first.runId)?.status === "healthy");
  const snapshot = db.prepare("SELECT argv FROM deployment_runs WHERE id=?").get(first.runId) as { argv: string };
  const original = settings.getSettings().llamaExecutable;
  settings.saveSettings({ llamaExecutable: "/missing/replacement", serveHost: "127.0.0.2" });
  const second = await supervisor.restart(first.runId);
  expect(second).not.toBeNull();
  expect(supervisor.get(second!.runId)?.host).toBe("127.0.0.1");
  expect((db.prepare("SELECT argv FROM deployment_runs WHERE id=?").get(second!.runId) as { argv: string }).argv).toBe(snapshot.argv);
  await supervisor.stop(second!.runId);
  settings.saveSettings({ llamaExecutable: original, serveHost: "127.0.0.1" });
});
it("rejects occupied ports", async () => {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(19230, "127.0.0.1", resolve));
  try { await expect(supervisor.start({ ...spec, port: 19230 })).rejects.toThrow("already in use"); }
  finally { server.close(); }
});
it("records startup failures, timeout and crashes", async () => {
  for (const behavior of ["failure", "timeout", "crash"]) {
    const run = await supervisor.start({ ...spec, env: { FAKE_BEHAVIOR: behavior } });
    await eventually(() => !supervisor.get(run.runId));
    const row = db.prepare("SELECT status,error FROM deployment_runs WHERE id=?").get(run.runId) as { status: string; error: string };
    expect(row.status).toBe(behavior === "crash" ? "crashed" : "failed");
    expect(row.error).toBeTruthy();
  }
});
it("cancels loading and kills remaining process-group children", async () => {
  const childFile = path.join(dir, "child.pid");
  const run = await supervisor.start({ ...spec, env: { FAKE_BEHAVIOR: "child", FAKE_CHILD_FILE: childFile } });
  await eventually(() => fs.existsSync(childFile));
  const child = Number(fs.readFileSync(childFile, "utf8"));
  await supervisor.stop(run.runId);
  await eventually(() => {
    try { return fs.readFileSync(`/proc/${child}/stat`, "utf8").split(" ")[2] === "Z"; } catch { return true; }
  });
  expect(supervisor.get(run.runId)).toBeUndefined();
});
it("runs both backends simultaneously with distinct ports", async () => {
  fs.copyFileSync(settings.getSettings().llamaExecutable!, path.join(dir, "vllm"));
  settings.saveSettings({ vllmBinDir: dir });
  const [a, b] = await Promise.all([supervisor.start(spec), supervisor.start({ name: "vllm", model: "org/model", flags: {} })]);
  expect(a.port).not.toBe(b.port);
  await eventually(() => supervisor.list().filter(d => d.status === "healthy").length === 2);
  expect(supervisor.list().map(d => d.backend).sort()).toEqual(["llamacpp", "vllm"]);
  await supervisor.stop(a.runId); await supervisor.stop(b.runId);
});
