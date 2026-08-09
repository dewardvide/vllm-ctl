"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { api } from "@/lib/client/api";
import { useDeployments } from "@/lib/client/deployments-store";
import { duration } from "@/lib/format";
import type { BenchmarkConfig, DataKind, ProfileKind } from "@/lib/types";
import { buildBenchmarkArgv, estimateRunSeconds } from "@/lib/guidellm/argv";
import { formatCommand } from "@/lib/vllm/argv";
import { baseUrl } from "@/lib/vllm/host";
import { Button, Empty, Note, Panel, Problem } from "@/components/ui/primitives";

/**
 * The GuideLLM run builder.
 *
 * Profiles are described by what they answer, not by their GuideLLM name — the
 * point of picking "sweep" is that you want to find the saturation point, and
 * the form should say so.
 */
const PROFILES: Array<{ kind: ProfileKind; title: string; answers: string }> = [
  {
    kind: "sweep",
    title: "sweep",
    answers: "Ramps load across several levels to find where throughput stops improving.",
  },
  {
    kind: "synchronous",
    title: "synchronous",
    answers: "One request at a time. Measures best-case latency with no queueing.",
  },
  {
    kind: "concurrent",
    title: "concurrent",
    answers: "A fixed number of simultaneous streams. Measures a specific load level.",
  },
  {
    kind: "throughput",
    title: "throughput",
    answers: "Pushes as hard as the server accepts. Measures peak capacity.",
  },
  {
    kind: "constant",
    title: "constant rate",
    answers: "A steady requests-per-second arrival rate.",
  },
  {
    kind: "poisson",
    title: "poisson",
    answers: "Random arrivals at an average rate, closer to real traffic.",
  },
];

export function BenchmarkForm() {
  const router = useRouter();
  const { live } = useDeployments();
  const healthy = live.filter((d) => d.status === "healthy");

  const [runId, setRunId] = useState<number | null>(healthy[0]?.runId ?? null);
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<ProfileKind>("sweep");
  const [sweepSize, setSweepSize] = useState(10);
  const [streams, setStreams] = useState(8);
  const [rate, setRate] = useState(10);
  const [maxConcurrency, setMaxConcurrency] = useState<number | "">("");
  const [dataKind, setDataKind] = useState<DataKind>("synthetic_text");
  const [promptTokens, setPromptTokens] = useState(256);
  const [outputTokens, setOutputTokens] = useState(128);
  const [source, setSource] = useState("");
  const [maxSeconds, setMaxSeconds] = useState<number | "">(30);
  const [maxRequests, setMaxRequests] = useState<number | "">("");
  const [tokenizer, setTokenizer] = useState("");
  const [seed, setSeed] = useState<number | "">(42);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = healthy.find((d) => d.runId === runId) ?? null;

  // Plain object rather than a manual useMemo: the dependency list was long
  // enough that the React Compiler bailed out of the whole component. It
  // auto-memoizes this correctly.
  const config: BenchmarkConfig = {
    name: name.trim(),
    deploymentRunId: runId,
    target: selected ? baseUrl(selected.host, selected.port) : "",
    model: selected ? (selected.servedName ?? selected.model) : null,
    profile: {
      kind: profile,
      sweepSize: profile === "sweep" ? sweepSize : undefined,
      streams: profile === "concurrent" ? streams : undefined,
      rate: profile === "constant" || profile === "poisson" ? rate : undefined,
      maxConcurrency:
        profile === "throughput" && maxConcurrency !== "" ? maxConcurrency : undefined,
    },
    data:
      dataKind === "synthetic_text"
        ? { kind: dataKind, promptTokens, outputTokens }
        : { kind: dataKind, source: source.trim() },
    constraints: {
      maxSeconds: maxSeconds === "" ? undefined : maxSeconds,
      maxRequests: maxRequests === "" ? undefined : maxRequests,
    },
    tokenizer: tokenizer.trim() || null,
    seed: seed === "" ? null : seed,
  };

  const preview = formatCommand(
    "guidellm",
    buildBenchmarkArgv(config, "<run-dir>/benchmark.json"),
  );

  const eta = estimateRunSeconds(config);

  /**
   * GuideLLM tokenizes synthetic prompts locally and resolves the tokenizer
   * from the model name, which is a served alias here, not a Hugging Face
   * repo. Warn before the run fails several seconds in.
   */
  const needsTokenizer =
    dataKind === "synthetic_text" &&
    !tokenizer.trim() &&
    !(selected?.model ?? "").includes("/");

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ run: { id: number } }>("/api/benchmarks", config);
      router.push(`/benchmarks/${r.run.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (healthy.length === 0) {
    return (
      <Empty
        title="Nothing is serving, so there is nothing to benchmark."
        hint="Start a deployment first. GuideLLM drives load against a live OpenAI-compatible endpoint."
        action={
          <Link href="/deployments/new">
            <Button tone="primary">start a deployment</Button>
          </Link>
        }
      />
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] min-h-full">
      <div className="min-w-0 flex flex-col">
        {error && <Problem>{error}</Problem>}

        <Panel label="target" ticked>
          <div className="grid grid-cols-2 gap-3 px-3 py-2.5 hairline-t">
            <label className="flex flex-col gap-1">
              <span className="plate">deployment</span>
              <select
                value={runId ?? ""}
                onChange={(e) => setRunId(Number(e.target.value))}
              >
                {healthy.map((d) => (
                  <option key={d.runId} value={d.runId}>
                    {d.servedName ?? d.name} — :{d.port}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="plate">run name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`${selected?.name ?? "run"} ${profile}`}
              />
            </label>
          </div>
        </Panel>

        <Panel label="load profile">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {PROFILES.map((p) => (
              <button
                key={p.kind}
                onClick={() => setProfile(p.kind)}
                aria-pressed={profile === p.kind}
                className={[
                  "text-left px-3 py-2 hairline-t xl:hairline-r transition-colors",
                  profile === p.kind ? "bg-panel-hi" : "hover:bg-panel",
                ].join(" ")}
                style={
                  profile === p.kind
                    ? { boxShadow: "inset 2px 0 0 0 var(--color-signal)" }
                    : undefined
                }
              >
                <span className="plate" style={profile === p.kind ? { color: "var(--color-signal)" } : undefined}>
                  {p.title}
                </span>
                <p className="text-[11px] text-ink-faint leading-snug mt-0.5">
                  {p.answers}
                </p>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-3 py-2.5 hairline-t">
            {profile === "sweep" && (
              <label className="flex flex-col gap-1">
                <span className="plate">load levels</span>
                <input
                  type="number"
                  min={2}
                  max={30}
                  value={sweepSize}
                  onChange={(e) => setSweepSize(Number(e.target.value) || 10)}
                />
              </label>
            )}
            {profile === "concurrent" && (
              <label className="flex flex-col gap-1">
                <span className="plate">streams</span>
                <input
                  type="number"
                  min={1}
                  value={streams}
                  onChange={(e) => setStreams(Number(e.target.value) || 1)}
                />
              </label>
            )}
            {(profile === "constant" || profile === "poisson") && (
              <label className="flex flex-col gap-1">
                <span className="plate">requests / second</span>
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={rate}
                  onChange={(e) => setRate(Number(e.target.value) || 1)}
                />
              </label>
            )}
            {profile === "throughput" && (
              <label className="flex flex-col gap-1">
                <span className="plate">max concurrency</span>
                <input
                  type="number"
                  min={1}
                  value={maxConcurrency}
                  onChange={(e) =>
                    setMaxConcurrency(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  placeholder="unbounded"
                />
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="plate">seconds per level</span>
              <input
                type="number"
                min={5}
                value={maxSeconds}
                onChange={(e) =>
                  setMaxSeconds(e.target.value === "" ? "" : Number(e.target.value))
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="plate">max requests</span>
              <input
                type="number"
                min={1}
                value={maxRequests}
                onChange={(e) =>
                  setMaxRequests(e.target.value === "" ? "" : Number(e.target.value))
                }
                placeholder="no limit"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="plate">seed</span>
              <input
                type="number"
                value={seed}
                onChange={(e) => setSeed(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="random"
              />
            </label>
          </div>
        </Panel>

        <Panel label="workload">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-3 py-2.5 hairline-t">
            <label className="flex flex-col gap-1">
              <span className="plate">data</span>
              <select
                value={dataKind}
                onChange={(e) => setDataKind(e.target.value as DataKind)}
              >
                <option value="synthetic_text">synthetic text</option>
                <option value="huggingface">hugging face dataset</option>
                <option value="json_file">json file</option>
                <option value="csv_file">csv file</option>
              </select>
            </label>

            {dataKind === "synthetic_text" ? (
              <>
                <label className="flex flex-col gap-1">
                  <span className="plate">prompt tokens</span>
                  <input
                    type="number"
                    min={1}
                    value={promptTokens}
                    onChange={(e) => setPromptTokens(Number(e.target.value) || 256)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="plate">output tokens</span>
                  <input
                    type="number"
                    min={1}
                    value={outputTokens}
                    onChange={(e) => setOutputTokens(Number(e.target.value) || 128)}
                  />
                </label>
              </>
            ) : (
              <label className="flex flex-col gap-1 col-span-2">
                <span className="plate">
                  {dataKind === "huggingface" ? "dataset id" : "file path"}
                </span>
                <input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder={dataKind === "huggingface" ? "openai/gsm8k" : "/path/to/data.json"}
                />
              </label>
            )}

            <label className="flex flex-col gap-1">
              <span className="plate">tokenizer</span>
              <input
                value={tokenizer}
                onChange={(e) => setTokenizer(e.target.value)}
                placeholder={selected?.model?.includes("/") ? selected.model : "required"}
              />
            </label>
          </div>

          {needsTokenizer && (
            <Note>
              Synthetic prompts are tokenized before they are sent, and GuideLLM resolves
              the tokenizer from the model name. This deployment&apos;s name is not a Hugging
              Face repository, so name a tokenizer above — usually the model you are serving.
            </Note>
          )}
        </Panel>
      </div>

      <aside className="xl:hairline-l min-w-0">
        <div className="xl:sticky xl:top-0 flex flex-col">
          <Panel label="command" ticked>
            <pre className="num text-[11px] leading-relaxed px-3 py-2 whitespace-pre-wrap break-all text-ink-dim overflow-auto max-h-80">
              {preview}
            </pre>
          </Panel>

          {eta != null && (
            <div className="px-3 py-2 hairline-t">
              <span className="plate">
                about {duration(eta)} of load, plus model warm-up
              </span>
            </div>
          )}

          {eta != null && eta > 900 && (
            <Note>
              This will drive the GPU for over {duration(eta)}. Nothing else should be
              using the card while it runs, or the numbers will be wrong.
            </Note>
          )}

          <div className="flex gap-1 p-3 hairline-t">
            <Button tone="primary" onClick={submit} disabled={busy || !selected || needsTokenizer}>
              {busy ? "starting" : "run benchmark"}
            </Button>
            <Link href="/benchmarks">
              <Button>cancel</Button>
            </Link>
          </div>
        </div>
      </aside>
    </div>
  );
}
