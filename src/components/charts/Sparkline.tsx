"use client";

import { useEffect, useRef } from "react";

import { INK, ramp, THERMAL } from "@/lib/thermal";

/**
 * A canvas time-series trace.
 *
 * Canvas rather than SVG or a charting library on purpose: at 1 Hz with a
 * dozen of these on the dashboard, a DOM-based chart re-reconciles thousands of
 * nodes per tick. Here each update is one `drawImage`-free repaint of a few
 * hundred line segments, and it never touches React's render path.
 */

export interface SparklineProps {
  /** Newest-last values. Length may change between frames. */
  values: number[];
  /** Fixed scale. Omit `max` to autoscale to the window's peak. */
  min?: number;
  max?: number;
  /**
   * Colour by magnitude of the *latest* value against the scale, using the
   * thermal ramp. Pass an explicit colour to opt out (categorical series).
   */
  color?: string;
  height?: number;
  /** Fill under the trace. Off for dense grids, on for the hero panels. */
  fill?: boolean;
  /** Draws a dotted rule at this value — used for power/thermal caps. */
  threshold?: number;
  className?: string;
  ariaLabel?: string;
}

export function Sparkline({
  values,
  min = 0,
  max,
  color,
  height = 28,
  fill = true,
  threshold,
  className,
  ariaLabel,
}: SparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Draw inputs live in a ref so the ResizeObserver's repaint always sees the
  // current values without the observer being torn down on every prop change.
  const stateRef = useRef({ values, min, max, color, fill, threshold });

  useEffect(() => {
    stateRef.current = { values, min, max, color, fill, threshold };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    const draw = () => {
      const s = stateRef.current;
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW === 0 || cssH === 0) return;

      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const vals = s.values;
      if (vals.length === 0) return;

      const hi =
        s.max ?? Math.max(1e-9, ...vals.filter((v) => Number.isFinite(v)));
      const lo = s.min;
      const span = hi - lo || 1;

      // 1px inset top and bottom so a full-scale trace isn't clipped.
      const pad = 1;
      const plotH = cssH - pad * 2;
      const x = (i: number) =>
        vals.length === 1 ? cssW : (i / (vals.length - 1)) * cssW;
      const y = (v: number) => {
        const t = (v - lo) / span;
        return pad + (1 - Math.max(0, Math.min(1, t))) * plotH;
      };

      const latest = vals[vals.length - 1];
      // The thermal ramp encodes magnitude against a *known* scale. On an
      // autoscaled series the newest value is by definition near the top of its
      // own window, which would paint an idle throughput trace saturation-red
      // and say nothing. Ramp only when a real ceiling was given.
      const stroke =
        s.color ?? (s.max != null ? ramp((latest - lo) / span) : THERMAL.t2);

      // Baseline rule. Without it an idle trace sitting at zero looks like a
      // rendering failure rather than a reading of zero.
      ctx.strokeStyle = INK.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, cssH - 0.5);
      ctx.lineTo(cssW, cssH - 0.5);
      ctx.stroke();

      if (s.threshold != null && s.threshold > lo && s.threshold < hi) {
        ctx.save();
        ctx.strokeStyle = INK.ruleHi;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        const ty = Math.round(y(s.threshold)) + 0.5;
        ctx.moveTo(0, ty);
        ctx.lineTo(cssW, ty);
        ctx.stroke();
        ctx.restore();
      }

      if (s.fill) {
        const grad = ctx.createLinearGradient(0, 0, 0, cssH);
        grad.addColorStop(0, withAlpha(stroke, 0.16));
        grad.addColorStop(1, withAlpha(stroke, 0.01));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(x(0), cssH);
        for (let i = 0; i < vals.length; i++) ctx.lineTo(x(i), y(vals[i]));
        ctx.lineTo(x(vals.length - 1), cssH);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i < vals.length; i++) {
        const px = x(i);
        const py = y(vals[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Leading-edge dot: the "now" marker on an instrument trace.
      ctx.fillStyle = stroke;
      ctx.beginPath();
      ctx.arc(x(vals.length - 1), y(latest), 1.6, 0, Math.PI * 2);
      ctx.fill();
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };

    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [values, min, max, color, fill, threshold]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height, display: "block" }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}

/** Adds alpha to a `#rrggbb` or `rgb(...)` colour. */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    const h = color.slice(1);
    const full =
      h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgb(${r} ${g} ${b} / ${alpha})`;
  }
  if (color.startsWith("rgb(")) {
    return color.replace(/^rgb\(/, "rgb(").replace(/\)$/, ` / ${alpha})`);
  }
  return color;
}
