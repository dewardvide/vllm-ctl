"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/client/api";
import { useDeployments } from "@/lib/client/deployments-store";
import { useTelemetry } from "@/lib/client/telemetry-store";
import { dateTime, duration, fixed, mibToGiB } from "@/lib/format";
import { useNow } from "@/lib/client/use-now";
import type { BenchmarkRun } from "@/lib/types";
import { Button, Empty, Note, Panel, Problem, StatusDot } from "@/components/ui/primitives";

import { DeploymentCard } from "./DeploymentCard";
import { HardwareStrip } from "./HardwareStrip";

/**
 * Mission control. Answers three questions without scrolling: is the machine
 * healthy, what is serving, and what did I last measure.
 */
export function Dashboard() {
  const { live, refresh } = useDeployments();
  const { latest } = useTelemetry();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const now = useNow(5000);

  useEffect(() => {
    api
      .get<{ runs: BenchmarkRun[] }>("/api/benchmarks")
      .then((r) => setRuns(r.runs.slice(0, 6)))
      .catch(() => setRuns([]));
  }, []);

  const stop = useCallback(
    async (runId: number) => {
      setBusy(runId);
      setError(null);
      try {
        await api.post("/api/deployments/stop", { runId });
        refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const alerts = buildAlerts(latest, live, now);

  return (
    <div className="flex flex-col">
      <HardwareStrip />

      {alerts.length > 0 && (
        <div className="flex flex-col gap-px">
          {alerts.map((a) => (
            <Note key={a}>{a}</Note>
          ))}
        </div>
      )}
      {error && <Problem>{error}</Problem>}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px]">
        <Panel
          label={`deployments · ${live.length}`}
          className="min-w-0"
          actions={
            <Link href="/deployments/new">
              <Button tone="primary">new deployment</Button>
            </Link>
          }
        >
          {live.length === 0 ? (
            <Empty
              title="Nothing is serving right now."
              hint="Start a model to get an OpenAI-compatible endpoint, live engine metrics, and a target to benchmark against."
              action={
                <Link href="/deployments/new">
                  <Button tone="primary">configure a deployment</Button>
                </Link>
              }
            />
          ) : (
            <div>
              {live.map((d) => (
                <DeploymentCard key={d.runId} d={d} onStop={stop} busy={busy === d.runId} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          label="recent benchmarks"
          className="xl:hairline-l min-w-0"
          actions={
            <Link href="/benchmarks/new">
              <Button>run one</Button>
            </Link>
          }
        >
          {runs.length === 0 ? (
            <Empty
              title="No benchmarks yet."
              hint="A GuideLLM sweep finds the concurrency where this GPU stops getting faster."
            />
          ) : (
            <ul>
              {runs.map((r) => (
                <li key={r.id} className="hairline-t">
                  <Link
                    href={`/benchmarks/${r.id}`}
                    className="flex items-center gap-2 px-3 h-9 hover:bg-panel-hi transition-colors"
                  >
                    <StatusDot
                      status={
                        r.status === "completed"
                          ? "healthy"
                          : r.status === "running"
                            ? "loading"
                            : r.status === "failed"
                              ? "failed"
                              : "idle"
                      }
                    />
                    <span className="text-[12px] truncate flex-1">
                      {r.name || r.model || `run ${r.id}`}
                    </span>
                    <span className="plate shrink-0">
                      {r.config?.profile?.kind ?? "—"}
                    </span>
                    <span className="plate shrink-0">{dateTime(r.startedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * Conditions worth interrupting for. Deliberately few: an alert that fires
 * constantly is one nobody reads.
 */
function buildAlerts(
  latest: ReturnType<typeof useTelemetry>["latest"],
  live: ReturnType<typeof useDeployments>["live"],
  now: number,
): string[] {
  const out: string[] = [];
  const gpu = latest?.gpus[0];

  if (gpu) {
    if (gpu.tempC >= 83) {
      out.push(
        `GPU is at ${fixed(gpu.tempC, 0)} °C and will be clock-throttling. Benchmark numbers taken now will understate this card.`,
      );
    }
    const freeGiB = mibToGiB(gpu.memTotalMiB - gpu.memUsedMiB);
    if (freeGiB < 1 && live.length > 0) {
      out.push(
        `Only ${fixed(freeGiB, 2)} GiB of VRAM is free. Another deployment will not start until something stops.`,
      );
    }
  }

  for (const d of live) {
    if (d.status === "crashed" || d.status === "failed") {
      out.push(`${d.name} ${d.status}: ${d.error ?? "see its log for details."}`);
    }
    if (d.metrics && d.metrics.requestsWaiting > 0 && d.metrics.kvCachePct > 90) {
      out.push(
        `${d.name} is queueing requests with the KV cache ${fixed(d.metrics.kvCachePct, 0)}% full — it is at capacity.`,
      );
    }
    if (d.status === "loading" && now - d.startedAt > 10 * 60_000) {
      out.push(
        `${d.name} has been loading for ${duration((now - d.startedAt) / 1000)}. It may be downloading weights.`,
      );
    }
  }
  return out;
}
