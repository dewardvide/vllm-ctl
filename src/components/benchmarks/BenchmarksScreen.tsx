"use client";

import Link from "next/link";
import { useState } from "react";

import { api } from "@/lib/client/api";
import { useNow } from "@/lib/client/use-now";
import { useSse } from "@/lib/client/use-sse";
import { dateTime, duration } from "@/lib/format";
import type { BenchmarkRun } from "@/lib/types";
import { Button, Empty, Meter, Panel, Problem, StatusDot } from "@/components/ui/primitives";

/** Benchmark history, with the running one pinned at the top. */
export function BenchmarksScreen() {
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useSse("/api/stream/benchmarks", {
    state: (d) => {
      const s = d as { runs: BenchmarkRun[]; activeId: number | null };
      setRuns(s.runs ?? []);
      setActiveId(s.activeId ?? null);
    },
  });

  const active = runs.find((r) => r.id === activeId);
  const past = runs.filter((r) => r.id !== activeId);

  const cancel = async (id: number) => {
    try {
      await api.post(`/api/benchmarks/${id}/cancel`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.del(`/api/benchmarks/${id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col">
      {error && <Problem>{error}</Problem>}

      {active && (
        <Panel
          label="running now"
          ticked
          actions={
            <Button tone="danger" onClick={() => cancel(active.id)}>
              cancel
            </Button>
          }
        >
          <div className="px-3 py-2 hairline-t flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <StatusDot status="loading" />
              <Link
                href={`/benchmarks/${active.id}`}
                className="text-[13px] hover:text-signal transition-colors"
              >
                {active.name || active.model || `run ${active.id}`}
              </Link>
              <span className="plate">{active.config?.profile?.kind}</span>
              <span className="flex-1" />
              <span className="plate">
                {duration((now - active.startedAt) / 1000)} elapsed
              </span>
            </div>
            <Meter value={active.progress} color="var(--color-t2)" />
          </div>
        </Panel>
      )}

      <Panel
        label={`benchmark runs · ${past.length}`}
        actions={
          <Link href="/benchmarks/new">
            <Button tone="primary">new benchmark</Button>
          </Link>
        }
      >
        {past.length === 0 ? (
          <Empty
            title="No benchmarks yet."
            hint="A sweep ramps concurrency until throughput stops improving, which tells you what this card can actually serve — and what latency you pay for it."
            action={
              <Link href="/benchmarks/new">
                <Button tone="primary">run a sweep</Button>
              </Link>
            }
          />
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="plate">
                <th className="text-left font-normal px-3 py-1.5 w-28">status</th>
                <th className="text-left font-normal px-3 py-1.5">run</th>
                <th className="text-left font-normal px-3 py-1.5 w-28">profile</th>
                <th className="text-right font-normal px-3 py-1.5 w-24">took</th>
                <th className="text-right font-normal px-3 py-1.5 w-36">started</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {past.map((r) => (
                <tr key={r.id} className="hairline-t hover:bg-panel transition-colors">
                  <td className="px-3 py-1.5">
                    <span className="plate flex items-center gap-1.5">
                      <StatusDot
                        status={
                          r.status === "completed"
                            ? "healthy"
                            : r.status === "failed"
                              ? "failed"
                              : "idle"
                        }
                      />
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 truncate max-w-0">
                    <Link
                      href={`/benchmarks/${r.id}`}
                      className="hover:text-signal transition-colors"
                    >
                      {r.name || r.model || `run ${r.id}`}
                    </Link>
                    {r.error && (
                      <span className="plate ml-2" style={{ color: "var(--color-t4)" }}>
                        {r.error}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 plate">{r.config?.profile?.kind ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right num text-ink-faint">
                    {r.finishedAt
                      ? duration((r.finishedAt - r.startedAt) / 1000)
                      : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right plate">{dateTime(r.startedAt)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Button tone="danger" onClick={() => remove(r.id)}>
                      delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
