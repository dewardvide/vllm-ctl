import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { BenchmarkConfig } from "@/lib/types";
import {
  buildBenchmarkArgv,
  buildConstraints,
  buildData,
  buildProfile,
  estimateRunSeconds,
} from "./argv";
import { findSaturationPoint, parseReport, reportVersion } from "./ingest";

/**
 * The fixture is a real GuideLLM 0.7.3 report, produced by running an actual
 * benchmark against `guidellm mock-server` — not a hand-written approximation.
 * Per-request detail was stripped; every aggregate the parser reads is intact.
 */
const REPORT = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, "__fixtures__", "guidellm-0.7.3-concurrent.json"),
    "utf8",
  ),
);

const baseConfig: BenchmarkConfig = {
  name: "test",
  deploymentRunId: null,
  target: "http://127.0.0.1:8000",
  model: "granite-4.1-8b",
  profile: { kind: "sweep", sweepSize: 10 },
  data: { kind: "synthetic_text", promptTokens: 256, outputTokens: 128 },
  constraints: { maxSeconds: 60 },
  tokenizer: null,
  seed: null,
};

describe("buildProfile", () => {
  it("builds each profile kind with its own parameter", () => {
    expect(buildProfile({ ...baseConfig, profile: { kind: "synchronous" } })).toBe(
      "kind=synchronous",
    );
    expect(
      buildProfile({ ...baseConfig, profile: { kind: "concurrent", streams: 16 } }),
    ).toBe("kind=concurrent,streams=16");
    expect(buildProfile({ ...baseConfig, profile: { kind: "constant", rate: 8 } })).toBe(
      "kind=constant,rate=8",
    );
    expect(buildProfile({ ...baseConfig, profile: { kind: "sweep", sweepSize: 12 } })).toBe(
      "kind=sweep,sweep_size=12",
    );
  });

  it("omits parameters that were left unset", () => {
    expect(buildProfile({ ...baseConfig, profile: { kind: "throughput" } })).toBe(
      "kind=throughput",
    );
  });
});

describe("buildData", () => {
  it("builds a synthetic text spec", () => {
    expect(buildData(baseConfig)).toBe(
      "kind=synthetic_text,prompt_tokens=256,output_tokens=128",
    );
  });

  it("builds a huggingface dataset spec", () => {
    expect(
      buildData({ ...baseConfig, data: { kind: "huggingface", source: "openai/gsm8k" } }),
    ).toBe("kind=huggingface,source=openai/gsm8k");
  });

  it("builds a file spec with a path", () => {
    expect(
      buildData({ ...baseConfig, data: { kind: "json_file", source: "/tmp/d.json" } }),
    ).toBe("kind=json_file,path=/tmp/d.json");
  });
});

describe("buildConstraints", () => {
  it("emits one constraint per configured limit", () => {
    const c = buildConstraints({
      ...baseConfig,
      constraints: { maxSeconds: 30, maxRequests: 500, maxErrorRate: 0.05 },
    });
    expect(c).toContain("kind=max_duration,seconds=30");
    expect(c).toContain("kind=max_requests,count=500");
    expect(c).toContain("kind=max_error_rate,rate=0.05");
  });

  it("defaults to a duration limit so a sweep cannot run forever", () => {
    expect(buildConstraints({ ...baseConfig, constraints: {} })).toEqual([
      "kind=max_duration,seconds=60",
    ]);
  });
});

describe("buildBenchmarkArgv", () => {
  const argv = buildBenchmarkArgv(baseConfig, "/tmp/out.json");

  it("uses the `run` subcommand, not the removed `benchmark` one", () => {
    expect(argv[0]).toBe("run");
    expect(argv).not.toContain("--rate-type");
  });

  it("passes the backend target and model", () => {
    const i = argv.indexOf("--backend");
    expect(argv[i + 1]).toBe(
      "kind=openai_http,target=http://127.0.0.1:8000,model=granite-4.1-8b",
    );
  });

  it("writes JSON to the requested path", () => {
    const i = argv.indexOf("--output");
    expect(argv[i + 1]).toBe("kind=json,path=/tmp/out.json");
  });

  it("disables the interactive renderer so the captured log stays readable", () => {
    expect(argv).toContain("--disable-console-interactive");
  });

  it("includes the tokenizer only when one is set", () => {
    expect(argv).not.toContain("--tokenizer");
    const withTok = buildBenchmarkArgv({ ...baseConfig, tokenizer: "gpt2" }, "/o.json");
    expect(withTok[withTok.indexOf("--tokenizer") + 1]).toBe(
      "kind=huggingface_auto,model=gpt2",
    );
  });

  it("includes a seed only when one is set", () => {
    const seeded = buildBenchmarkArgv({ ...baseConfig, seed: 42 }, "/o.json");
    expect(seeded[seeded.indexOf("--seed") + 1]).toBe("kind=static,value=42");
  });
});

describe("estimateRunSeconds", () => {
  it("multiplies per-strategy duration by the sweep size", () => {
    expect(estimateRunSeconds(baseConfig)).toBe(10 * 70);
  });

  it("counts a single strategy for non-sweep profiles", () => {
    expect(
      estimateRunSeconds({ ...baseConfig, profile: { kind: "concurrent", streams: 4 } }),
    ).toBe(70);
  });

  it("returns null when the run is unbounded in time", () => {
    expect(
      estimateRunSeconds({ ...baseConfig, constraints: { maxRequests: 100 } }),
    ).toBeNull();
  });
});

describe("parseReport on a real GuideLLM 0.7.3 report", () => {
  const rows = parseReport(REPORT);

  it("reads the producing version", () => {
    expect(reportVersion(REPORT)).toBe("0.7.3");
  });

  it("returns one row per benchmark strategy", () => {
    expect(rows.length).toBe(REPORT.benchmarks.length);
    expect(rows[0].idx).toBe(0);
  });

  it("reads the strategy and its requested load level", () => {
    expect(rows[0].strategy).toBe("concurrent");
    expect(rows[0].rate).toBe(4);
  });

  it("reads request totals", () => {
    expect(rows[0].requestsOk).toBe(66);
    expect(rows[0].requestsErr).toBe(0);
  });

  it("keeps millisecond metrics in milliseconds", () => {
    // The console table for this run reported TTFT median 154.4 ms.
    expect(rows[0].ttftP50Ms).toBeCloseTo(154.394, 2);
    expect(rows[0].itlP50Ms).toBeCloseTo(10.354, 2);
  });

  it("converts request_latency from seconds to milliseconds", () => {
    // Raw mean is 0.485 s; a missed conversion would report 0.485 ms.
    expect(rows[0].e2eMeanMs).toBeGreaterThan(400);
    expect(rows[0].e2eMeanMs).toBeLessThan(600);
  });

  it("reads throughput and concurrency", () => {
    expect(rows[0].reqPerS).toBeCloseTo(8.0, 1);
    expect(rows[0].concurrency).toBeCloseTo(3.94, 1);
    expect(rows[0].outputTokS).toBeGreaterThan(200);
  });

  it("converts epoch seconds to epoch milliseconds", () => {
    expect(rows[0].startedAt).toBeGreaterThan(1_600_000_000_000);
    expect(rows[0].finishedAt! - rows[0].startedAt!).toBeCloseTo(8000, -2);
  });

  it("reads token counts", () => {
    expect(rows[0].outputTokMean).toBeCloseTo(32, 0);
    expect(rows[0].promptTokMean).toBeGreaterThan(100);
  });

  it("survives an empty or malformed report without throwing", () => {
    expect(parseReport({})).toEqual([]);
    expect(parseReport({ benchmarks: [{}] })[0].strategy).toBeNull();
    expect(parseReport(null)).toEqual([]);
  });
});

describe("findSaturationPoint", () => {
  it("finds the knee where throughput stops improving", () => {
    const rows = [
      { concurrency: 1, outputTokS: 100, rate: null },
      { concurrency: 2, outputTokS: 190, rate: null },
      { concurrency: 4, outputTokS: 340, rate: null },
      { concurrency: 8, outputTokS: 480, rate: null },
      { concurrency: 16, outputTokS: 495, rate: null },
      { concurrency: 32, outputTokS: 500, rate: null },
    ];
    const knee = findSaturationPoint(rows);
    // 480 is within 5% of the 500 peak, so 8 is the first saturating level.
    expect(knee?.concurrency).toBe(8);
  });

  it("returns null when there are too few points to see a curve", () => {
    expect(
      findSaturationPoint([{ concurrency: 1, outputTokS: 100, rate: null }]),
    ).toBeNull();
  });

  it("ignores rows with no usable measurement", () => {
    const rows = [
      { concurrency: null, outputTokS: null, rate: null },
      { concurrency: 1, outputTokS: 100, rate: null },
      { concurrency: 2, outputTokS: 150, rate: null },
      { concurrency: 4, outputTokS: 155, rate: null },
    ];
    expect(findSaturationPoint(rows)?.concurrency).toBe(2);
  });
});
