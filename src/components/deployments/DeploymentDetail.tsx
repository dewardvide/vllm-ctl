"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/client/api";
import { useDeployments } from "@/lib/client/deployments-store";
import { useSse } from "@/lib/client/use-sse";
import { compact, fixed, ms, msUnit, sinceStr, timeOfDay } from "@/lib/format";
import { THERMAL } from "@/lib/thermal";
import type { EngineMetrics } from "@/lib/types";
import { Sparkline } from "@/components/charts/Sparkline";
import {
  Button,
  Empty,
  Meter,
  Panel,
  Problem,
  Readout,
  StatusLabel,
} from "@/components/ui/primitives";

interface LogLine {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr";
  text: string;
}

/** One deployment: its logs, its engine metrics, and a way to poke it. */
export function DeploymentDetail({ runId }: { runId: number }) {
  const router = useRouter();
  const { live, refresh } = useDeployments();
  const d = live.find((x) => x.runId === runId) ?? null;

  const [lines, setLines] = useState<LogLine[]>([]);
  const [follow, setFollow] = useState(true);
  const [history, setHistory] = useState<EngineMetrics[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useSse(`/api/stream/deployments/${runId}/logs`, {
    lines: (data) => {
      const batch = data as LogLine[];
      setLines((prev) => {
        const merged = prev.length === 0 ? batch : [...prev, ...batch];
        // Match the server's bound so a long-lived page cannot grow forever.
        return merged.length > 5000 ? merged.slice(-5000) : merged;
      });
    },
  });

  // Keep a local metric history for the charts; the stream only sends the
  // latest sample, so accumulating it here is the only way to plot a trend.
  // This is a genuine external-to-React sync, and the extra render it causes is
  // exactly one per 2 s scrape.
  useEffect(() => {
    if (!d?.metrics) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory((h) => {
      if (h.length > 0 && h[h.length - 1].ts === d.metrics!.ts) return h;
      const next = [...h, d.metrics!];
      return next.length > 300 ? next.slice(-300) : next;
    });
  }, [d?.metrics]);

  useEffect(() => {
    if (!follow) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const series = useMemo(
    () => ({
      tok: history.map((m) => m.genTokS),
      running: history.map((m) => m.requestsRunning),
      kv: history.map((m) => m.kvCachePct),
      ttft: history.map((m) => m.ttftP95Ms ?? 0),
    }),
    [history],
  );

  const stop = async () => {
    try {
      await api.post("/api/deployments/stop", { runId });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restart = async () => {
    try {
      const r = await api.post<{ runId: number }>("/api/deployments/restart", { runId });
      refresh();
      router.replace(`/deployments/${r.runId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!d) {
    return (
      <Empty
        title="This deployment is not running."
        hint="It may have been stopped, or the app restarted. Its log is kept on disk."
        action={
          <Link href="/deployments">
            <Button tone="primary">back to deployments</Button>
          </Link>
        }
      />
    );
  }

  const m = d.metrics;

  return (
    <div className="flex flex-col min-h-full">
      {error && <Problem>{error}</Problem>}

      <Panel
        label="deployment"
        ticked
        actions={
          <span className="flex gap-1">
            <Button onClick={restart}>restart</Button>
            <Button tone="danger" onClick={stop}>
              stop
            </Button>
          </span>
        }
      >
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 px-3 py-2 hairline-t">
          <div className="flex flex-col gap-0.5">
            <StatusLabel status={d.status} />
            <span className="text-[14px] font-medium">{d.servedName ?? d.name}</span>
          </div>
          <Readout label="model" value={d.model} size="sm" />
          <Readout label="endpoint" value={`127.0.0.1:${d.port}`} size="sm" />
          <Readout label="pid" value={d.pid ?? "—"} size="sm" />
          <Readout
            label="uptime"
            value={sinceStr(d.readyAt ?? d.startedAt)}
            size="sm"
          />
          <Readout
            label="vram held"
            value={d.vramMiB != null ? fixed(d.vramMiB / 1024, 2) : "—"}
            unit="gib"
            size="sm"
          />
          {d.phase && <Readout label="phase" value={d.phase} size="sm" />}
        </div>
        {d.error && <Problem>{d.error}</Problem>}
      </Panel>

      {m && (
        <Panel label="engine">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6">
            <MetricCell
              label="gen tok/s"
              value={fixed(m.genTokS, 1)}
              series={series.tok}
            />
            <MetricCell
              label="prompt tok/s"
              value={fixed(m.promptTokS, 1)}
              series={[]}
            />
            <MetricCell
              label="running"
              value={fixed(m.requestsRunning, 0)}
              series={series.running}
            />
            <MetricCell
              label="queued"
              value={fixed(m.requestsWaiting, 0)}
              series={[]}
              warn={m.requestsWaiting > 0}
            />
            <MetricCell
              label="ttft p95"
              value={ms(m.ttftP95Ms)}
              unit={msUnit(m.ttftP95Ms)}
              series={series.ttft}
            />
            <MetricCell
              label="kv cache"
              value={fixed(m.kvCachePct, 0)}
              unit="%"
              series={series.kv}
              last
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-5 gap-y-2 px-3 py-2 hairline-t">
            <Readout label="ttft p50" value={ms(m.ttftP50Ms)} unit={msUnit(m.ttftP50Ms)} size="sm" />
            <Readout label="ttft p99" value={ms(m.ttftP99Ms)} unit={msUnit(m.ttftP99Ms)} size="sm" />
            <Readout label="itl p50" value={ms(m.itlP50Ms)} unit={msUnit(m.itlP50Ms)} size="sm" />
            <Readout label="itl p95" value={ms(m.itlP95Ms)} unit={msUnit(m.itlP95Ms)} size="sm" />
            <Readout
              label="prefix cache hits"
              value={m.prefixHitPct != null ? fixed(m.prefixHitPct, 0) : "—"}
              unit={m.prefixHitPct != null ? "%" : undefined}
              size="sm"
            />
            <Readout label="preemptions" value={fixed(m.preemptions, 0)} size="sm" />
            <Readout label="tokens generated" value={compact(m.totalGenTokens)} size="sm" />
            <Readout label="requests served" value={compact(m.totalRequests)} size="sm" />
          </div>
          <p className="px-3 pb-2 text-[11px] text-ink-faint">
            Latency percentiles are interpolated from vLLM&apos;s histogram buckets over the
            last scrape window, so they are close but not exact. A benchmark measures them
            directly.
          </p>
        </Panel>
      )}

      <Panel
        label={`log · ${lines.length} lines`}
        className="flex-1 min-h-0"
        actions={
          <span className="flex gap-1 items-center">
            <Button onClick={() => setFollow((f) => !f)} tone={follow ? "primary" : "default"}>
              {follow ? "following" : "follow"}
            </Button>
            <Button onClick={() => setLines([])}>clear view</Button>
          </span>
        }
        bodyClassName="min-h-0"
      >
        <div
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (!atBottom && follow) setFollow(false);
          }}
          className="overflow-auto hairline-t"
          style={{ height: "min(46vh, 520px)" }}
        >
          {lines.length === 0 ? (
            <p className="px-3 py-4 plate">waiting for output</p>
          ) : (
            <ol className="num text-[11px] leading-[1.45]">
              {lines.map((l) => (
                <li
                  key={l.seq}
                  className="px-3 flex gap-2 hover:bg-panel"
                  style={{ color: l.stream === "stderr" ? "var(--color-ink-dim)" : undefined }}
                >
                  <span className="text-ink-faint shrink-0 select-none">
                    {timeOfDay(l.ts)}
                  </span>
                  <span className="whitespace-pre-wrap break-all">{l.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Panel>
    </div>
  );
}

function MetricCell({
  label,
  value,
  unit,
  series,
  warn,
  last = false,
}: {
  label: string;
  value: string;
  unit?: string;
  series: number[];
  warn?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`px-3 py-2 hairline-t ${last ? "" : "xl:hairline-r"}`}>
      <Readout
        label={label}
        value={value}
        unit={unit}
        color={warn ? THERMAL.t3 : undefined}
      />
      {series.length > 1 && (
        <div className="mt-1">
          <Sparkline values={series} height={20} ariaLabel={label} />
        </div>
      )}
    </div>
  );
}

/** Re-export so the panel's meter stays available to callers. */
export { Meter };
