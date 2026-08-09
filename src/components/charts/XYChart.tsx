"use client";

import { useId, useMemo, useState } from "react";

import { INK } from "@/lib/thermal";

/**
 * A small analytical XY chart in SVG.
 *
 * Benchmark results are static once a run finishes, so unlike the live
 * telemetry traces there is nothing to gain from canvas here — SVG gives
 * crisp text, real hover targets, and accessible markup for free.
 */

export interface Series {
  id: string;
  label: string;
  color: string;
  points: Array<{ x: number; y: number }>;
  /** Drawn as a dashed line, for a secondary axis series like latency. */
  dashed?: boolean;
}

export interface Marker {
  x: number;
  label: string;
  color?: string;
}

export function XYChart({
  series,
  xLabel,
  yLabel,
  height = 220,
  viewWidth = 760,
  markers = [],
  formatX = (v: number) => String(Math.round(v)),
  formatY = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1)),
  logX = false,
}: {
  series: Series[];
  xLabel: string;
  yLabel: string;
  height?: number;
  /**
   * viewBox width. The SVG fills its container and scales proportionally, so
   * this sets the aspect ratio — and therefore both the rendered height and the
   * apparent text size. A wide panel needs a wide viewBox, or the chart scales
   * up 3x and the axis labels become headlines.
   */
  viewWidth?: number;
  markers?: Marker[];
  formatX?: (v: number) => string;
  formatY?: (v: number) => string;
  logX?: boolean;
}) {
  const uid = useId();
  const [hover, setHover] = useState<{ sx: number; sy: number; text: string } | null>(null);

  const pad = { top: 10, right: 12, bottom: 26, left: 46 };
  const W = viewWidth;
  const H = height;
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const bounds = useMemo(() => {
    const xs = series.flatMap((s) => s.points.map((p) => p.x));
    const ys = series.flatMap((s) => s.points.map((p) => p.y));
    if (xs.length === 0) return null;
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMax = Math.max(...ys, 0);
    return {
      xMin: logX ? Math.max(xMin, 0.01) : xMin,
      xMax: xMax === xMin ? xMin + 1 : xMax,
      yMin: 0,
      // Headroom so the top point is not welded to the frame.
      yMax: yMax === 0 ? 1 : yMax * 1.12,
    };
  }, [series, logX]);

  if (!bounds) {
    return <p className="px-3 py-4 plate">no data</p>;
  }

  const tx = (v: number) => {
    if (logX) {
      const lo = Math.log10(bounds.xMin);
      const hi = Math.log10(bounds.xMax);
      return pad.left + ((Math.log10(Math.max(v, bounds.xMin)) - lo) / (hi - lo || 1)) * plotW;
    }
    return pad.left + ((v - bounds.xMin) / (bounds.xMax - bounds.xMin || 1)) * plotW;
  };
  const ty = (v: number) =>
    pad.top + plotH - ((v - bounds.yMin) / (bounds.yMax - bounds.yMin || 1)) * plotH;

  const yTicks = niceTicks(bounds.yMin, bounds.yMax, 4);
  const xTicks = series[0]?.points.map((p) => p.x) ?? [];

  return (
    <div className="relative px-3 py-2">
      {/* No height attribute: with one, the default preserveAspectRatio
          letterboxes the chart and leaves it floating in the middle of a wide
          panel. Letting the viewBox drive the aspect makes it fill the width. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${yLabel} against ${xLabel}`}
        style={{ display: "block", width: "100%", height: "auto", overflow: "visible" }}
      >
        {/* horizontal grid */}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={ty(t)}
              y2={ty(t)}
              stroke={INK.rule}
              strokeWidth={1}
            />
            <text
              x={pad.left - 6}
              y={ty(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fill={INK.faint}
              fontSize={9}
              fontFamily="var(--font-data)"
            >
              {formatY(t)}
            </text>
          </g>
        ))}

        {/* x ticks */}
        {thin(dedupe(xTicks), 12).map((t) => (
          <text
            key={`x${t}`}
            x={tx(t)}
            y={H - pad.bottom + 12}
            textAnchor="middle"
            fill={INK.faint}
            fontSize={9}
            fontFamily="var(--font-data)"
          >
            {formatX(t)}
          </text>
        ))}

        {/* saturation and other callouts */}
        {markers.map((m) => (
          <g key={m.label}>
            <line
              x1={tx(m.x)}
              x2={tx(m.x)}
              y1={pad.top}
              y2={pad.top + plotH}
              stroke={m.color ?? INK.signal}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <text
              x={tx(m.x) + (tx(m.x) > W - pad.right - 60 ? -4 : 4)}
              y={pad.top + 9}
              textAnchor={tx(m.x) > W - pad.right - 60 ? "end" : "start"}
              fill={m.color ?? INK.signal}
              fontSize={9}
              fontFamily="var(--font-data)"
            >
              {m.label}
            </text>
          </g>
        ))}

        {series.map((s) => (
          <g key={s.id}>
            <path
              d={linePath(s.points.map((p) => [tx(p.x), ty(p.y)]))}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeDasharray={s.dashed ? "4 3" : undefined}
              strokeLinejoin="round"
            />
            {s.points.map((p, i) => (
              <circle
                key={`${uid}-${s.id}-${i}`}
                cx={tx(p.x)}
                cy={ty(p.y)}
                r={3}
                fill={INK.void}
                stroke={s.color}
                strokeWidth={1.5}
                onMouseEnter={() =>
                  setHover({
                    sx: (tx(p.x) / W) * 100,
                    sy: ty(p.y),
                    text: `${s.label} · ${formatX(p.x)} ${xLabel} → ${formatY(p.y)}`,
                  })
                }
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "crosshair" }}
              />
            ))}
          </g>
        ))}

        {/* frame */}
        <line
          x1={pad.left}
          x2={pad.left}
          y1={pad.top}
          y2={pad.top + plotH}
          stroke={INK.ruleHi}
        />
        <line
          x1={pad.left}
          x2={W - pad.right}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          stroke={INK.ruleHi}
        />
      </svg>

      <div className="flex items-center gap-3 flex-wrap mt-1">
        <span className="plate">{xLabel} →</span>
        {series.map((s) => (
          <span key={s.id} className="plate flex items-center gap-1.5">
            <span
              aria-hidden
              style={{
                width: 8,
                height: 2,
                background: s.color,
                display: "inline-block",
              }}
            />
            {s.label}
          </span>
        ))}
      </div>

      {hover && (
        <div
          className="absolute pointer-events-none num text-[10px] px-1.5 py-0.5 bg-panel border border-rule-hi whitespace-nowrap"
          style={{ left: `${hover.sx}%`, top: hover.sy, transform: "translate(-50%, -140%)" }}
        >
          {hover.text}
        </div>
      )}
    </div>
  );
}

function linePath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return "";
  return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

function dedupe(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** Keeps at most `max` evenly-spaced labels, always including the last. */
function thin(xs: number[], max: number): number[] {
  if (xs.length <= max) return xs;
  const step = Math.ceil(xs.length / max);
  const out = xs.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== xs[xs.length - 1]) out.push(xs[xs.length - 1]);
  return out;
}

/** Round tick values to something a person would choose. */
function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (span <= 0) return [min];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}
