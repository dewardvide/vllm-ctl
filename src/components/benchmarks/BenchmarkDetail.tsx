"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/client/api";
import { useSse } from "@/lib/client/use-sse";
import { compact, dateTime, duration, fixed, int, msFixed, timeOfDay } from "@/lib/format";
import { seriesColor, THERMAL } from "@/lib/thermal";
import type { BenchmarkResultRow, BenchmarkRun } from "@/lib/types";
import { XYChart, type Series } from "@/components/charts/XYChart";
import {
  Button,
  Empty,
  Meter,
  Panel,
  Problem,
  Readout,
  StatusLabel,
} from "@/components/ui/primitives";

interface TelemetryRow {
  ts: number;
  util_gpu: number;
  mem_used_mib: number;
  power_w: number;
  temp_c: number;
  clock_sm_mhz: number;
}

interface Payload {
  run: BenchmarkRun;
  results: BenchmarkResultRow[];
  saturation: { concurrency: number; outputTokS: number } | null;
  telemetry: TelemetryRow[];
}

/**
 * A finished benchmark, read as a story: what the card can serve, what latency
 * that costs, and what the GPU was doing while it happened.
 */
export function BenchmarkDetail({ id }: { id: number }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Payload>(`/api/benchmarks/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  // Refresh the whole payload when this run's state changes.
  useSse("/api/stream/benchmarks", {
    state: (d) => {
      const s = d as { runs: BenchmarkRun[] };
      const mine = s.runs?.find((r) => r.id === id);
      if (!mine) return;
      if (mine.status !== data?.run.status || mine.progress !== data?.run.progress) {
        void load();
      }
    },
  });

  useSse(`/api/stream/benchmarks/${id}/logs`, {
    lines: (d) => {
      const batch = d as string[];
      setLines((prev) => {
        const merged = prev.length === 0 ? batch : [...prev, ...batch];
        return merged.length > 3000 ? merged.slice(-3000) : merged;
      });
    },
  });

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, showLog]);

  const rows = useMemo(
    () =>
      (data?.results ?? [])
        .slice()
        .sort((a, b) => (a.concurrency ?? a.rate ?? 0) - (b.concurrency ?? b.rate ?? 0)),
    [data],
  );

  const load1 = (r: BenchmarkResultRow) => r.concurrency ?? r.rate ?? 0;

  const throughputSeries = useMemo<Series[]>(() => {
    if (rows.length === 0) return [];
    return [
      {
        id: "out",
        label: "output tok/s",
        color: THERMAL.t2,
        points: rows.map((r) => ({ x: load1(r), y: r.outputTokS ?? 0 })),
      },
      {
        id: "req",
        label: "requests/s ×10",
        color: seriesColor(2),
        dashed: true,
        points: rows.map((r) => ({ x: load1(r), y: (r.reqPerS ?? 0) * 10 })),
      },
    ];
  }, [rows]);

  const latencySeries = useMemo<Series[]>(() => {
    if (rows.length === 0) return [];
    return [
      {
        id: "ttft50",
        label: "ttft p50",
        color: THERMAL.t1,
        points: rows.map((r) => ({ x: load1(r), y: r.ttftP50Ms ?? 0 })),
      },
      {
        id: "ttft99",
        label: "ttft p99",
        color: THERMAL.t4,
        points: rows.map((r) => ({ x: load1(r), y: r.ttftP99Ms ?? 0 })),
      },
      {
        id: "itl50",
        label: "itl p50",
        color: THERMAL.t3,
        dashed: true,
        points: rows.map((r) => ({ x: load1(r), y: r.itlP50Ms ?? 0 })),
      },
    ];
  }, [rows]);

  const telemetrySeries = useMemo<Series[]>(() => {
    const t = data?.telemetry ?? [];
    if (t.length === 0) return [];
    const t0 = t[0].ts;
    const secs = (r: TelemetryRow) => (r.ts - t0) / 1000;
    return [
      {
        id: "util",
        label: "gpu util %",
        color: THERMAL.t2,
        points: t.map((r) => ({ x: secs(r), y: r.util_gpu })),
      },
      {
        id: "power",
        label: "power % of cap",
        color: THERMAL.t3,
        points: t.map((r) => ({ x: secs(r), y: (r.power_w / 390) * 100 })),
      },
      {
        id: "temp",
        label: "temp °c",
        color: THERMAL.t4,
        dashed: true,
        points: t.map((r) => ({ x: secs(r), y: r.temp_c })),
      },
    ];
  }, [data]);

  if (error) return <Problem>{error}</Problem>;
  if (!data) return <p className="px-3 py-4 plate">loading</p>;

  const { run, saturation } = data;
  const running = run.status === "running";

  return (
    <div className="flex flex-col">
      <Panel
        label="benchmark"
        ticked
        actions={
          <span className="flex gap-1">
            {running && (
              <Button
                tone="danger"
                onClick={() => void api.post(`/api/benchmarks/${id}/cancel`)}
              >
                cancel
              </Button>
            )}
            <Button onClick={() => setShowLog((v) => !v)}>
              {showLog ? "hide log" : "show log"}
            </Button>
            <Link href="/benchmarks/new">
              <Button tone="primary">new run</Button>
            </Link>
          </span>
        }
      >
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 px-3 py-2 hairline-t">
          <div className="flex flex-col gap-0.5">
            <StatusLabel
              status={
                run.status === "completed"
                  ? "healthy"
                  : run.status === "running"
                    ? "loading"
                    : run.status === "failed"
                      ? "failed"
                      : "stopped"
              }
            />
            <span className="text-[14px] font-medium">
              {run.name || run.model || `run ${run.id}`}
            </span>
          </div>
          <Readout label="model" value={run.model ?? "—"} size="sm" />
          <Readout label="profile" value={run.config?.profile?.kind ?? "—"} size="sm" />
          <Readout label="target" value={run.target} size="sm" />
          <Readout label="started" value={dateTime(run.startedAt)} size="sm" />
          <Readout
            label="took"
            value={run.finishedAt ? duration((run.finishedAt - run.startedAt) / 1000) : "—"}
            size="sm"
          />
        </div>

        {running && (
          <div className="px-3 pb-2">
            <Meter value={run.progress} color={THERMAL.t2} />
          </div>
        )}
        {run.error && <Problem>{run.error}</Problem>}
      </Panel>

      {showLog && (
        <Panel label="guidellm output">
          <div
            ref={logRef}
            className="overflow-auto hairline-t num text-[11px] leading-[1.45]"
            style={{ height: "min(40vh, 420px)" }}
          >
            {lines.length === 0 ? (
              <p className="px-3 py-3 plate">no output captured</p>
            ) : (
              lines.map((l, i) => (
                <p key={i} className="px-3 whitespace-pre-wrap break-all text-ink-dim">
                  {l}
                </p>
              ))
            )}
          </div>
        </Panel>
      )}

      {rows.length === 0 ? (
        <Empty
          title={running ? "Measuring." : "This run produced no results."}
          hint={
            running
              ? "Charts appear once GuideLLM finishes and writes its report."
              : "Check the run log — the benchmark may have failed before completing a strategy."
          }
        />
      ) : (
        <>
          {saturation && (
            <Panel label="saturation point">
              <div className="px-3 py-2.5 hairline-t flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <Readout
                  label="serves best at"
                  value={fixed(saturation.concurrency, 1)}
                  unit="concurrent"
                  size="lg"
                  color={THERMAL.t2}
                />
                <Readout
                  label="output throughput there"
                  value={fixed(saturation.outputTokS, 0)}
                  unit="tok/s"
                  size="lg"
                />
                <p className="text-[12px] text-ink-faint max-w-md leading-snug">
                  Past this level throughput stops improving, so extra concurrency buys
                  queueing delay rather than tokens.
                </p>
              </div>
            </Panel>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2">
            <Panel label="throughput against load" ticked>
              <XYChart
                series={throughputSeries}
                xLabel="concurrency"
                yLabel="tokens/s"
                markers={
                  saturation
                    ? [{ x: saturation.concurrency, label: "saturation" }]
                    : []
                }
              />
            </Panel>

            <Panel label="latency against load" className="xl:hairline-l" ticked>
              <XYChart
                series={latencySeries}
                xLabel="concurrency"
                yLabel="ms"
                markers={
                  saturation
                    ? [{ x: saturation.concurrency, label: "saturation" }]
                    : []
                }
              />
            </Panel>
          </div>

          {telemetrySeries.length > 0 && (
            <Panel label="what the gpu was doing" ticked>
              <XYChart
                series={telemetrySeries}
                xLabel="seconds into run"
                yLabel="%"
                viewWidth={1800}
                height={210}
              />
              <p className="px-3 pb-2 text-[11px] text-ink-faint">
                Sampled by this app at 1 Hz across the run window. If temperature climbs
                past 83 °C the card is clock-throttling, and the later load levels above
                are measuring a slower GPU than the earlier ones.
              </p>
            </Panel>
          )}

          <Panel label={`per-level results · ${rows.length}`}>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] min-w-[900px]">
                <thead>
                  <tr className="plate">
                    <th className="text-left font-normal px-3 py-1.5">strategy</th>
                    <th className="text-right font-normal px-3 py-1.5">conc.</th>
                    <th className="text-right font-normal px-3 py-1.5">req/s</th>
                    <th className="text-right font-normal px-3 py-1.5">out tok/s</th>
                    <th className="text-right font-normal px-3 py-1.5">ttft p50</th>
                    <th className="text-right font-normal px-3 py-1.5">ttft p99</th>
                    <th className="text-right font-normal px-3 py-1.5">itl p50</th>
                    <th className="text-right font-normal px-3 py-1.5">e2e p95</th>
                    <th className="text-right font-normal px-3 py-1.5">ok</th>
                    <th className="text-right font-normal px-3 py-1.5">err</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isKnee =
                      saturation != null &&
                      Math.abs(load1(r) - saturation.concurrency) < 1e-6;
                    return (
                      <tr
                        key={r.id}
                        className="hairline-t"
                        style={
                          isKnee
                            ? { boxShadow: "inset 2px 0 0 0 var(--color-signal)" }
                            : undefined
                        }
                      >
                        <td className="px-3 py-1.5 plate">{r.strategy ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right num">{fixed(r.concurrency, 1)}</td>
                        <td className="px-3 py-1.5 text-right num">{fixed(r.reqPerS, 2)}</td>
                        <td
                          className="px-3 py-1.5 text-right num"
                          style={isKnee ? { color: THERMAL.t2 } : undefined}
                        >
                          {fixed(r.outputTokS, 0)}
                        </td>
                        <td className="px-3 py-1.5 text-right num text-ink-dim">{msFixed(r.ttftP50Ms)}</td>
                        <td className="px-3 py-1.5 text-right num text-ink-dim">{msFixed(r.ttftP99Ms)}</td>
                        <td className="px-3 py-1.5 text-right num text-ink-dim">{msFixed(r.itlP50Ms)}</td>
                        <td className="px-3 py-1.5 text-right num text-ink-dim">{msFixed(r.e2eP95Ms)}</td>
                        <td className="px-3 py-1.5 text-right num text-ink-faint">
                          {int(r.requestsOk)}
                        </td>
                        <td
                          className="px-3 py-1.5 text-right num"
                          style={{
                            color: (r.requestsErr ?? 0) > 0 ? THERMAL.t4 : "var(--color-ink-faint)",
                          }}
                        >
                          {int(r.requestsErr)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-3 py-2 plate">
              latencies in ms · {compact(rows.reduce((a, r) => a + (r.requestsOk ?? 0), 0))}{" "}
              requests total · captured {timeOfDay(run.startedAt)}
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}
