import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractEntries,
  inferType,
  parseHelpText,
  parseSignature,
  splitDefault,
  coerceFlagValue,
} from "./parse-help";
import type { FlagSpec } from "@/lib/types";

/**
 * The fixture is the verbatim `vllm serve --help=all` output from vLLM 0.26.0.
 * These tests are the contract that keeps the settings form honest: if the
 * parser silently drops or mistypes flags, the form quietly stops being
 * exhaustive, which is exactly the failure this suite exists to catch.
 */
const FIXTURE = fs.readFileSync(
  path.join(__dirname, "__fixtures__", "vllm-0.26-help-all.txt"),
  "utf8",
);

describe("parseSignature", () => {
  it("reads a bare boolean", () => {
    const s = parseSignature("--headless");
    expect(s.names).toEqual(["headless"]);
    expect(s.hasValue).toBe(false);
    expect(s.negatable).toBe(false);
  });

  it("reads a negatable boolean pair", () => {
    const s = parseSignature("--allow-credentials, --no-allow-credentials");
    expect(s.names).toEqual(["allow-credentials"]);
    expect(s.negatable).toBe(true);
    expect(s.hasValue).toBe(false);
  });

  it("reads an enum with choices", () => {
    const s = parseSignature("--chat-template-content-format {auto,openai,string}");
    expect(s.names).toEqual(["chat-template-content-format"]);
    expect(s.choices).toEqual(["auto", "openai", "string"]);
    expect(s.hasValue).toBe(true);
  });

  it("reads a variadic value", () => {
    const s = parseSignature("--api-key API_KEY [API_KEY ...]");
    expect(s.names).toEqual(["api-key"]);
    expect(s.variadic).toBe(true);
    expect(s.hasValue).toBe(true);
  });

  it("reads a short alias alongside the long form", () => {
    const s = parseSignature("--data-parallel-address DATA_PARALLEL_ADDRESS, -dpa DATA_PARALLEL_ADDRESS");
    expect(s.names).toEqual(["data-parallel-address"]);
    expect(s.shorts).toEqual(["dpa"]);
  });

  it("reads a negatable boolean that also has a short alias", () => {
    const s = parseSignature(
      "--data-parallel-external-lb, --no-data-parallel-external-lb, -dpe",
    );
    expect(s.names).toEqual(["data-parallel-external-lb"]);
    expect(s.negatable).toBe(true);
    expect(s.shorts).toEqual(["dpe"]);
    expect(s.hasValue).toBe(false);
  });
});

describe("splitDefault", () => {
  it("pulls a trailing default off the help text", () => {
    const r = splitDefault("Shutdown timeout in seconds. (default: 0)");
    expect(r.help).toBe("Shutdown timeout in seconds.");
    expect(r.default).toBe("0");
  });

  it("treats None as no default", () => {
    expect(splitDefault("Some help. (default: None)").default).toBeNull();
  });

  it("handles a default split across wrapped help lines", () => {
    // argparse wraps at column 72; the joined text can read "(default:\n  X)".
    const r = splitDefault("Use flashinfer kernels (default: allgather_reducescatter)");
    expect(r.default).toBe("allgather_reducescatter");
  });

  it("leaves help alone when there is no default", () => {
    expect(splitDefault("show this help message").default).toBeNull();
  });
});

describe("inferType", () => {
  const sig = (over: Partial<ReturnType<typeof parseSignature>> = {}) => ({
    names: ["x"],
    shorts: [],
    negatable: false,
    choices: null,
    variadic: false,
    hasValue: true,
    ...over,
  });

  it("types a value-less flag as boolean", () => {
    expect(inferType(sig({ hasValue: false }), null, "", "headless")).toBe("boolean");
  });

  it("types a flag with choices as enum", () => {
    expect(inferType(sig({ choices: ["a", "b"] }), "a", "", "backend")).toBe("enum");
  });

  it("types an integer default as int", () => {
    expect(inferType(sig(), "8192", "", "max-model-len")).toBe("int");
  });

  it("types a fractional default as float", () => {
    expect(inferType(sig(), "0.9", "", "gpu-memory-utilization")).toBe("float");
  });

  it("falls back to name hints when there is no default", () => {
    expect(inferType(sig(), null, "", "gpu-memory-utilization")).toBe("float");
    expect(inferType(sig(), null, "", "max-num-seqs")).toBe("int");
  });

  it("detects JSON-valued options from the help text", () => {
    expect(
      inferType(sig(), null, "Should either be a valid JSON string or JSON keys", "x"),
    ).toBe("json");
  });

  it("types a variadic flag as list", () => {
    expect(inferType(sig({ variadic: true }), null, "", "api-key")).toBe("list");
  });
});

describe("parseHelpText on the real vLLM 0.26 dump", () => {
  const schema = parseHelpText(FIXTURE, "0.26.0");
  const byName = new Map(schema.flags.map((f) => [f.name, f]));

  it("finds essentially all of the advertised options", () => {
    // The dump contains 274 option lines; --help is excluded by design.
    expect(schema.flags.length).toBeGreaterThanOrEqual(265);
  });

  it("recovers every config group", () => {
    for (const g of [
      "Frontend",
      "ModelConfig",
      "LoadConfig",
      "AttentionConfig",
      "MambaConfig",
      "StructuredOutputsConfig",
      "ParallelConfig",
      "CacheConfig",
      "OffloadConfig",
      "MultiModalConfig",
      "LoRAConfig",
      "ObservabilityConfig",
      "SchedulerConfig",
      "CompilationConfig",
    ]) {
      expect(schema.groups, `missing group ${g}`).toContain(g);
    }
  });

  it("never emits a --no- prefixed flag as its own entry", () => {
    for (const f of schema.flags) {
      expect(f.name.startsWith("no-"), `leaked negative form: ${f.name}`).toBe(false);
    }
  });

  it("types the flags an operator actually reaches for", () => {
    expect(byName.get("max-model-len")?.type).toBe("int");
    expect(byName.get("gpu-memory-utilization")?.type).toBe("float");
    expect(byName.get("max-num-seqs")?.type).toBe("int");
    expect(byName.get("trust-remote-code")?.type).toBe("boolean");
    expect(byName.get("api-key")?.type).toBe("list");
  });

  it("captures enum choices verbatim", () => {
    const f = byName.get("chat-template-content-format");
    expect(f?.type).toBe("enum");
    expect(f?.choices).toEqual(["auto", "openai", "string"]);
  });

  it("marks negatable booleans", () => {
    expect(byName.get("allow-credentials")?.negatable).toBe(true);
    expect(byName.get("allow-credentials")?.type).toBe("boolean");
  });

  it("records short aliases", () => {
    expect(byName.get("data-parallel-address")?.aliases).toContain("dpa");
  });

  it("keeps help text and strips the default out of it", () => {
    const f = byName.get("shutdown-timeout");
    expect(f?.default).toBe("0");
    expect(f?.help).not.toContain("default:");
    expect(f?.help.length).toBeGreaterThan(5);
  });

  it("flags the essentials tier", () => {
    expect(byName.get("max-model-len")?.essential).toBe(true);
    expect(byName.get("shutdown-timeout")?.essential).toBe(false);
  });

  it("gives every flag a non-empty name and known group", () => {
    for (const f of schema.flags) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(schema.groups).toContain(f.group);
    }
  });
});

describe("extractEntries", () => {
  it("attaches wrapped help lines to their entry", () => {
    const text = [
      "Frontend:",
      "  Arguments for the frontend.",
      "",
      "  --thing THING",
      "                        First line of help that",
      "                        continues here. (default: 3)",
      "  --other, --no-other   Short help. (default: False)",
    ].join("\n");
    const entries = extractEntries(text);
    const thing = entries.find((e) => e.signature.startsWith("--thing"));
    expect(thing?.helpLines.join(" ")).toContain("continues here");
    expect(thing?.group).toBe("Frontend");
    const other = entries.find((e) => e.signature.startsWith("--other"));
    expect(other?.helpLines.join(" ")).toBe("Short help. (default: False)");
  });
});

describe("coerceFlagValue", () => {
  const spec = (over: Partial<FlagSpec>): FlagSpec => ({
    name: "x",
    aliases: [],
    group: "g",
    type: "string",
    choices: null,
    default: null,
    help: "",
    negatable: false,
    variadic: false,
    essential: false,
    ...over,
  });

  it("rejects a non-integer for an int flag", () => {
    const r = coerceFlagValue(spec({ type: "int" }), "8k");
    expect(r.ok).toBe(false);
  });

  it("accepts a valid integer", () => {
    const r = coerceFlagValue(spec({ type: "int" }), "16384");
    expect(r).toEqual({ ok: true, value: 16384 });
  });

  it("rejects a value outside an enum's choices", () => {
    const r = coerceFlagValue(spec({ type: "enum", choices: ["a", "b"] }), "c");
    expect(r.ok).toBe(false);
  });

  it("splits a list on commas and whitespace", () => {
    const r = coerceFlagValue(spec({ type: "list" }), "a, b  c");
    expect(r).toEqual({ ok: true, value: ["a", "b", "c"] });
  });

  it("rejects malformed JSON", () => {
    expect(coerceFlagValue(spec({ type: "json" }), "{nope").ok).toBe(false);
    expect(coerceFlagValue(spec({ type: "json" }), '{"a":1}').ok).toBe(true);
  });
});
