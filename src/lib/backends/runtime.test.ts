import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
let dir: string;
let settings: typeof import("@/lib/settings");
let runtime: typeof import("./runtime");
const spec = { backend: "llamacpp" as const, name: "local", model: "", modelSource: { kind: "local" as const }, flags: { "gpu-layers": 0 } };
const hp = { host: "127.0.0.1", port: 8000 };
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-runtime-"));
  process.env.VLLM_ADMIN_DATA_DIR = dir;
  vi.resetModules();
  settings = await import("@/lib/settings"); runtime = await import("./runtime");
  const exe = path.join(dir, "llama");
  fs.writeFileSync(exe, `#!${process.execPath}\nconsole.log(process.argv.includes('--version') ? 'version: 10217 (old)' : '--host --port --alias --metrics --model --gpu-layers --hf-repo --temp --reasoning');`);
  fs.chmodSync(exe, 0o755);
  settings.saveSettings({ llamaExecutable: exe, llamaInvocation: "serve" });
});
afterAll(() => { delete process.env.VLLM_ADMIN_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });
it("validates readable local files, CPU mode, and projector paths", async () => {
  const file = path.join(dir, "local model.gguf"); fs.writeFileSync(file, "fixture");
  const launch = await runtime.prepareLaunch({ ...spec, model: file }, hp);
  expect(launch.argv[0]).toBe("serve"); expect(launch.argv).toContain(file);
  expect(launch.argv.slice(-2)).toEqual(["--gpu-layers", "0"]);
  await expect(runtime.prepareLaunch({ ...spec, model: path.join(dir, "absent.gguf") }, hp)).rejects.toThrow();
  await expect(runtime.prepareLaunch({ ...spec, model: file, flags: { threads: 2 } }, hp)).rejects.toThrow("does not support --threads");
});
it("rejects old builds for LFM3 with an actionable upgrade message", async () => {
  await expect(runtime.prepareLaunch({ ...spec, model: "LiquidAI/LFM3-Omni-2B-GGUF", modelSource: { kind: "hub", quantization: "Q4_K_M" } }, hp)).rejects.toThrow("b11960 / v0.8.0");
});
