"use client";

import { useMemo } from "react";

import { useTelemetry } from "@/lib/client/telemetry-store";
import { mibToGiB } from "@/lib/format";
import { INK, rampPct, seriesColor } from "@/lib/thermal";

/**
 * The headroom rail — this app's signature instrument.
 *
 * A 24 GB wall governs every decision here: which model you can run, at what
 * context length, alongside what else. So the allocation of that wall is
 * pinned under the nav on every screen, segmented by which process owns which
 * slice. When you configure a deployment, its projected footprint appears as a
 * ghost segment on this same rail — the guard rail is not a separate widget,
 * it is the instrument you have been reading all along.
 */

export interface RailSegment {
  /** Stable key; also selects the categorical colour. */
  id: string;
  label: string;
  mib: number;
  /** Projected rather than actual — drawn hatched and breathing. */
  ghost?: boolean;
}

export function HeadroomRail({
  segments = [],
  gpuIndex = 0,
}: {
  segments?: RailSegment[];
  gpuIndex?: number;
}) {
  const { latest } = useTelemetry();
  const gpu = latest?.gpus.find((g) => g.index === gpuIndex) ?? latest?.gpus[0];

  const model = useMemo(() => {
    const totalMiB = gpu?.memTotalMiB ?? 0;
    const usedMiB = gpu?.memUsedMiB ?? 0;

    const attributed = segments.filter((s) => !s.ghost);
    const attributedMiB = attributed.reduce((a, s) => a + s.mib, 0);
    const ghosts = segments.filter((s) => s.ghost);
    const ghostMiB = ghosts.reduce((a, s) => a + s.mib, 0);

    // Whatever the driver reports as used but no known deployment claims:
    // the desktop compositor, other people's CUDA jobs, driver overhead.
    const otherMiB = Math.max(0, usedMiB - attributedMiB);
    const freeMiB = Math.max(0, totalMiB - usedMiB);
    const overcommitMiB = Math.max(0, ghostMiB - freeMiB);

    return {
      totalMiB,
      usedMiB,
      freeMiB,
      attributed,
      ghosts,
      otherMiB,
      overcommit: overcommitMiB > 0,
      usedPct: totalMiB > 0 ? (usedMiB / totalMiB) * 100 : 0,
    };
  }, [gpu, segments]);

  if (!gpu) {
    return (
      <div className="hairline-b h-[26px] flex items-center px-3 text-ink-faint plate">
        awaiting gpu telemetry
      </div>
    );
  }

  const w = (mib: number) =>
    model.totalMiB > 0 ? `${Math.max(0, (mib / model.totalMiB) * 100)}%` : "0%";

  return (
    <div
      className="hairline-b flex items-stretch h-[26px] select-none"
      title={`GPU ${gpu.index} · ${gpu.name}`}
    >
      <div className="plate flex items-center pl-3 pr-2.5 shrink-0 hairline-r">
        vram·{gpu.index}
      </div>

      {/* the rail itself */}
      <div className="flex-1 flex items-center px-2.5 min-w-0">
        <div className="relative flex-1 h-[9px] bg-void hairline-t hairline-b flex overflow-hidden">
          {model.attributed.map((s, i) => (
            <div
              key={s.id}
              style={{ width: w(s.mib), background: seriesColor(i) }}
              className="h-full"
              title={`${s.label} — ${mibToGiB(s.mib).toFixed(2)} GiB`}
            />
          ))}

          {model.otherMiB > 0 && (
            <div
              style={{ width: w(model.otherMiB), background: INK.ruleHi }}
              className="h-full"
              title={`Unattributed — ${mibToGiB(model.otherMiB).toFixed(2)} GiB (desktop, driver, other processes)`}
            />
          )}

          {model.ghosts.map((s) => (
            <div
              key={s.id}
              style={{
                width: w(s.mib),
                backgroundImage: `repeating-linear-gradient(135deg, ${
                  model.overcommit ? INK.ink : INK.signal
                } 0 2px, transparent 2px 5px)`,
                backgroundColor: model.overcommit
                  ? "rgb(224 91 73 / 0.35)"
                  : "rgb(94 200 216 / 0.14)",
              }}
              className="h-full ghost-seg"
              title={`Projected: ${s.label} — ${mibToGiB(s.mib).toFixed(2)} GiB`}
            />
          ))}

          {/* remaining free space is simply the unpainted track */}
        </div>
      </div>

      {/* readout */}
      <div className="flex items-center gap-2 pr-3 pl-2 shrink-0 hairline-l">
        <span
          className="num text-[11px] font-medium"
          style={{ color: rampPct(model.usedPct) }}
        >
          {mibToGiB(model.usedMiB).toFixed(1)}
        </span>
        <span className="num text-[11px] text-ink-faint">
          / {mibToGiB(model.totalMiB).toFixed(1)}
        </span>
        <span className="plate">gib</span>
        {model.overcommit && (
          <span
            className="plate is-transitional"
            style={{ color: "var(--color-t4)" }}
          >
            over budget
          </span>
        )}
      </div>
    </div>
  );
}
