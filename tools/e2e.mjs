/**
 * End-to-end walkthrough of the real app, driven with Playwright.
 *
 * Configures a deployment through the UI, starts it, waits for the engine to
 * become healthy, drives real inference so the metrics panels have something to
 * show, then runs a GuideLLM benchmark against it — capturing a screenshot at
 * every step. The screenshots are what the docs use, so they are always of the
 * actual product rather than a mock-up.
 *
 *   node tools/e2e.mjs [--model Qwen/Qwen3-0.6B] [--out docs/images]
 *
 * Requires the app to already be running on http://localhost:3000.
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const EXE =
  process.env.CHROMIUM_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [],
  ),
);

const BASE = args.base ?? "http://localhost:3000";
const MODEL = args.model ?? "Qwen/Qwen3-0.6B";
const SERVED = args.served ?? "qwen3-0.6b";
const CONTEXT = args.context ?? "4096";
const GPU_UTIL = args.gpuUtil ?? "0.35";
const OUT = args.out ?? "docs/images";
const VIEW = { width: 1440, height: 900 };

fs.mkdirSync(OUT, { recursive: true });

const log = (...m) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...m);
const errors = [];
let shotCount = 0;

async function shot(page, name, { full = false } = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shotCount++;
  log(`shot → ${file}`);
}

/** Polls a predicate until it holds, so we never race the UI. */
async function until(label, fn, { timeoutMs = 600_000, everyMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const api = async (route, init) => {
  const res = await fetch(`${BASE}${route}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  return res.json().catch(() => null);
};

/**
 * The address to dial for a server bound to `bindHost`. Mirrors `connectHost`
 * in src/lib/vllm/host.ts — a wildcard bind is not a connectable destination.
 */
function connectHost(bindHost) {
  const h = (bindHost ?? "").trim();
  if (h === "" || h === "0.0.0.0") return "127.0.0.1";
  if (h === "::" || h === "[::]") return "[::1]";
  return !h.startsWith("[") && h.includes(":") ? `[${h}]` : h;
}

/**
 * Real inference traffic, so the engine panels show non-zero rates rather than
 * a screenshot of an idle server.
 */
function driveLoad(host, port, servedName, { seconds = 45, concurrency = 4 } = {}) {
  const target = `http://${connectHost(host)}:${port}`;
  const stopAt = Date.now() + seconds * 1000;
  let sent = 0;
  let failed = 0;
  const worker = async () => {
    while (Date.now() < stopAt) {
      try {
        const res = await fetch(`${target}/v1/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: servedName,
            prompt:
              "Write a short paragraph explaining why paged attention improves LLM serving throughput.",
            max_tokens: 128,
            temperature: 0.7,
          }),
        });
        if (res.ok) sent++;
        else failed++;
        await res.text();
      } catch {
        failed++;
      }
    }
  };
  const done = Promise.all(Array.from({ length: concurrency }, worker));
  return { done, stats: () => ({ sent, failed }) };
}

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2 });
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

try {
  /* ---------------------------------------------------------------- 1. env */
  log("settings — environment detection");
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shot(page, "01-settings");

  /* ------------------------------------------------------------- 2. models */
  log("models — local cache");
  await page.goto(`${BASE}/models`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await shot(page, "02-models");

  // Open the model's detail panel for the VRAM fit estimator.
  const row = page.locator("td", { hasText: MODEL.split("/").pop() }).first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(3000);
    await shot(page, "03-model-fit");
  }

  /* ---------------------------------------------------- 3. deployment form */
  log("deployment form — 274 options");
  await page.goto(`${BASE}/deployments/new`, { waitUntil: "networkidle" });
  await page.locator("[data-field=model]").waitFor({ timeout: 120_000 });
  await page.locator("[data-field=model]").fill(MODEL);
  await page.locator("[data-field=servedName]").fill(SERVED);

  // Wait for the option schema to arrive from the engine before touching flags.
  await page.locator("#flag-max-model-len").waitFor({ timeout: 180_000 });
  await page.locator("#flag-max-model-len").fill(CONTEXT);
  await page.locator("#flag-gpu-memory-utilization").fill(GPU_UTIL);
  await page.waitForTimeout(2500); // command preview + VRAM projection settle
  await shot(page, "04-deployment-form");

  // The full option surface, grouped as vLLM groups it.
  await page.locator("[data-field=flagSearch]").fill("cache");
  await page.waitForTimeout(800);
  await shot(page, "05-option-search");
  await page.locator("[data-field=flagSearch]").fill("");
  await page.waitForTimeout(500);

  /* ------------------------------------------------------------- 4. launch */
  log("starting deployment");
  await page.locator("button:has-text('start now')").click();
  await page.waitForTimeout(6000);
  await shot(page, "06-loading");

  log("waiting for healthy — first run compiles kernels, this is slow");
  await until(
    "deployment healthy",
    async () => {
      const s = await api("/api/deployments/history");
      const live = await fetch(`${BASE}/api/stream/deployments`);
      const reader = live.body.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      const text = new TextDecoder().decode(value);
      void s;
      return text.includes('"status":"healthy"');
    },
    { timeoutMs: 900_000, everyMs: 5000 },
  );
  log("healthy");

  // Which port did it get?
  const liveRes = await fetch(`${BASE}/api/stream/deployments`);
  const reader = liveRes.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const state = JSON.parse(
    new TextDecoder().decode(value).split("data: ")[1].split("\n")[0],
  );
  const deployment = state.live.find((d) => d.status === "healthy");
  log(`serving on ${deployment.host}:${deployment.port} as ${deployment.servedName}`);

  /* --------------------------------------------------------- 5. under load */
  log("driving real inference for the metrics panels");
  const load = driveLoad(deployment.host, deployment.port, deployment.servedName, {
    seconds: 50,
  });

  await page.waitForTimeout(18000);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(6000);
  await shot(page, "07-dashboard-under-load");

  await page.goto(`${BASE}/deployments/${deployment.runId}`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(8000);
  await shot(page, "08-deployment-detail");

  await load.done;
  log(`load finished: ${JSON.stringify(load.stats())}`);

  /* ------------------------------------------------------------ 5b. chat */
  // Driven through the UI rather than the API, so the screenshot proves the
  // panel streams and reports timings — not merely that the route works.
  log("chat panel — a real exchange with the deployment");
  const box = page.getByLabel("message");
  await box.fill("In one sentence, what is paged attention?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => !document.body.innerText.includes("waiting for the first token"),
    { timeout: 60_000 },
  );
  await page.waitForTimeout(6000); // let the reply finish and timings settle
  await shot(page, "08b-chat");

  /* ---------------------------------------------------------- 6. benchmark */
  log("benchmark run builder");
  await page.goto(`${BASE}/benchmarks/new`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await shot(page, "09-benchmark-form");

  log("starting benchmark via API (same payload the form posts)");
  const created = await api("/api/benchmarks", {
    method: "POST",
    body: JSON.stringify({
      name: `${SERVED} sweep`,
      deploymentRunId: deployment.runId,
      target: "",
      model: null,
      profile: { kind: "sweep", sweepSize: 4 },
      data: { kind: "synthetic_text", promptTokens: 256, outputTokens: 128 },
      constraints: { maxSeconds: 20 },
      tokenizer: MODEL,
      seed: 42,
    }),
  });
  if (created?.error) throw new Error(`benchmark rejected: ${created.error}`);
  const benchId = created.run.id;
  log(`benchmark ${benchId} running`);

  await page.goto(`${BASE}/benchmarks/${benchId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(9000);
  await shot(page, "10-benchmark-running");

  await until(
    "benchmark finished",
    async () => {
      const r = await api(`/api/benchmarks/${benchId}`);
      return r?.run?.status && r.run.status !== "running";
    },
    { timeoutMs: 900_000, everyMs: 5000 },
  );

  const final = await api(`/api/benchmarks/${benchId}`);
  log(`benchmark ${final.run.status}, ${final.results.length} levels`);
  if (final.run.status !== "completed") {
    throw new Error(`benchmark ${final.run.status}: ${final.run.error}`);
  }

  await page.goto(`${BASE}/benchmarks/${benchId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(5000);
  await shot(page, "11-benchmark-results", { full: true });

  /* ------------------------------------------------------------- 7. finish */
  log("stopping deployment");
  await api("/api/deployments/stop", {
    method: "POST",
    body: JSON.stringify({ runId: deployment.runId }),
  });
  await page.waitForTimeout(8000);

  console.log(
    JSON.stringify(
      {
        ok: true,
        screenshots: shotCount,
        deployment: {
          runId: deployment.runId,
          port: deployment.port,
          model: deployment.model,
        },
        benchmark: {
          id: benchId,
          levels: final.results.length,
          saturation: final.saturation,
          telemetrySamples: final.telemetry.length,
        },
        load: load.stats(),
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
} catch (err) {
  console.error("E2E FAILED:", err.message);
  await shot(page, "zz-failure").catch(() => {});
  console.error(JSON.stringify({ ok: false, consoleErrors: errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
