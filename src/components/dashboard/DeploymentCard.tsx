"use client";

import Link from "next/link";

import { compact, duration, fixed, ms, msUnit } from "@/lib/format";
import { useNow } from "@/lib/client/use-now";
import { rampPct, THERMAL } from "@/lib/thermal";
import type { LiveDeployment } from "@/lib/types";
import { Meter, Readout, StatusDot } from "@/components/ui/primitives";

/**
 * One running deployment, dense enough that several fit above the fold.
 *
 * While a server is still loading, the card shows the engine's own phase
 * ("loading weights", "capturing cuda graphs") instead of a spinner — a
 * ninety-second weight load should look like progress, not like a hang.
 */
export function DeploymentCard({
  d,
  onStop,
  busy,
}: {
  d: LiveDeployment;
  onStop: (runId: number) => void;
  busy?: boolean;
}) {
  const now = useNow();
  const m = d.metrics;
  const ready = d.status === "healthy";
  const uptime = duration((now - (d.readyAt ?? d.startedAt)) / 1000);

  return (
    <article className="hairline-t">
      <header className="flex items-center gap-2.5 px-3 h-8">
        <StatusDot status={d.status} />
        <Link
          href={`/deployments/${d.runId}`}
          className="text-[13px] font-medium truncate hover:text-signal transition-colors"
        >
          {d.servedName ?? d.name}
        </Link>
        <span className="num text-[11px] text-ink-faint shrink-0">:{d.port}</span>
        <span className="plate truncate hidden md:inline">{d.model}</span>
        <span className="flex-1" />
        <span className="plate">{ready ? uptime : d.phase || d.status}</span>
        <button
          onClick={() => onStop(d.runId)}
          disabled={busy || d.status === "stopping"}
          className="plate px-2 h-5 border border-rule rounded-[2px] hover:border-t4 hover:text-t4 transition-colors disabled:opacity-35"
        >
          stop
        </button>
      </header>

      {d.error && (
        <p className="px-3 pb-2 text-[12px]" style={{ color: THERMAL.t4 }}>
          {d.error}
        </p>
      )}

      {ready && m ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-x-4 gap-y-2 px-3 pb-2.5">
          <Readout
            label="gen tok/s"
            value={fixed(m.genTokS, 1)}
            color={m.genTokS > 0 ? THERMAL.t2 : undefined}
          />
          <Readout
            label="ttft p99"
            value={ms(m.ttftP99Ms)}
            unit={msUnit(m.ttftP99Ms)}
            title="Estimated from vLLM's histogram buckets over the last scrape"
          />
          <Readout
            label="itl p50"
            value={ms(m.itlP50Ms)}
            unit={msUnit(m.itlP50Ms)}
            title="Inter-token latency"
          />
          <Readout
            label="running / queued"
            value={`${fixed(m.requestsRunning, 0)} / ${fixed(m.requestsWaiting, 0)}`}
            color={m.requestsWaiting > 0 ? THERMAL.t3 : undefined}
          />
          <div className="flex flex-col gap-1 justify-center min-w-0">
            <span className="plate">kv cache {fixed(m.kvCachePct, 0)}%</span>
            <Meter value={m.kvCachePct} color={rampPct(m.kvCachePct)} />
            <span className="plate truncate">
              {compact(m.totalGenTokens)} tokens generated
            </span>
          </div>
        </div>
      ) : (
        <div className="px-3 pb-2.5">
          <p className="plate">
            {d.phase ? `${d.phase} · ${duration((now - d.startedAt) / 1000)}` : "starting"}
          </p>
        </div>
      )}
    </article>
  );
}
