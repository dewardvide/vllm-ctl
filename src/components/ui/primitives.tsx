"use client";

import type { CSSProperties, ReactNode } from "react";

import { TRANSITIONAL_STATUSES, type DeploymentStatus } from "@/lib/types";

/* ==========================================================================
   Rack Instrument primitives.

   Panels are regions delimited by hairlines, not cards with radius and shadow.
   Emphasis comes from corner registration ticks — the marks on an engineering
   drawing — rather than from elevation.
   ========================================================================== */

/** A labelled region. `ticked` reserves the corner marks for live panels. */
export function Panel({
  label,
  actions,
  children,
  ticked = false,
  className = "",
  bodyClassName = "",
}: {
  label?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  ticked?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`flex flex-col min-h-0 ${ticked ? "ticked" : ""} ${className}`}>
      {(label || actions) && (
        <header className="flex items-center gap-3 px-3 h-7 shrink-0">
          {label ? <span className="plate">{label}</span> : <span />}
          <span className="flex-1 h-px bg-rule" />
          {actions}
        </header>
      )}
      <div className={`flex-1 min-h-0 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/**
 * A number and its unit, typographically separated: the value is data, the
 * unit is a label. Figures are tabular so a changing value never shifts width.
 */
export function Readout({
  value,
  unit,
  label,
  color,
  size = "md",
  title,
}: {
  value: ReactNode;
  unit?: string;
  label?: string;
  color?: string;
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const scale = {
    sm: "text-[11px]",
    md: "text-[15px]",
    lg: "text-[22px]",
  }[size];

  return (
    <div className="flex flex-col gap-0.5 min-w-0" title={title}>
      {label && <span className="plate truncate">{label}</span>}
      <span className="flex items-baseline gap-1 min-w-0">
        <span
          className={`num font-medium tracking-tight ${scale}`}
          style={color ? { color } : undefined}
        >
          {value}
        </span>
        {unit && <span className="plate shrink-0">{unit}</span>}
      </span>
    </div>
  );
}

/**
 * A status light. It only animates in transitional states — in this UI,
 * movement means the system wants your attention, so a healthy server is
 * perfectly still.
 */
export function StatusDot({
  status,
  size = 6,
}: {
  status: DeploymentStatus | "idle";
  size?: number;
}) {
  const color =
    status === "healthy"
      ? "var(--status-healthy)"
      : status === "failed" || status === "crashed"
        ? "var(--status-failed)"
        : status === "starting" || status === "loading" || status === "stopping"
          ? "var(--status-pending)"
          : "var(--status-idle)";

  const transitional = TRANSITIONAL_STATUSES.includes(status as DeploymentStatus);

  return (
    <span
      aria-hidden
      className={`inline-block rounded-full shrink-0 ${transitional ? "is-transitional" : ""}`}
      style={{ width: size, height: size, background: color }}
    />
  );
}

export function StatusLabel({ status }: { status: DeploymentStatus | "idle" }) {
  return (
    <span className="plate flex items-center gap-1.5">
      <StatusDot status={status} />
      {status}
    </span>
  );
}

/* -------------------------------------------------------------------------- */

type ButtonTone = "default" | "primary" | "danger";

export function Button({
  children,
  onClick,
  tone = "default",
  disabled,
  type = "button",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
}) {
  const tones: Record<ButtonTone, string> = {
    default: "border-rule hover:border-rule-hi hover:bg-panel-hi text-ink-dim hover:text-ink",
    primary:
      "border-signal-dim text-signal hover:bg-signal/10 hover:border-signal",
    danger: "border-rule hover:border-t4 text-ink-faint hover:text-t4",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        "plate px-2.5 h-6 border rounded-[2px] transition-colors shrink-0",
        "disabled:opacity-35 disabled:pointer-events-none",
        tones[tone],
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */

/** A horizontal magnitude bar. Colour comes from the thermal ramp by default. */
export function Meter({
  value,
  max = 100,
  color,
  height = 3,
  threshold,
}: {
  value: number;
  max?: number;
  color?: string;
  height?: number;
  threshold?: number;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const style: CSSProperties = {
    width: `${pct}%`,
    background: color ?? "var(--color-t2)",
  };
  return (
    <div className="relative w-full bg-rule/60" style={{ height }}>
      <div className="h-full transition-[width] duration-300" style={style} />
      {threshold != null && (
        <span
          className="absolute top-0 bottom-0 w-px bg-ink-faint"
          style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * An empty state. Says what the screen is for and what to do next — an empty
 * screen is an invitation to act, not an apology.
 */
export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
      <p className="text-ink-dim text-[13px]">{title}</p>
      {hint && <p className="text-ink-faint text-[12px] max-w-md">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** An error state, in the interface's voice: what happened, and what to do. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="px-3 py-2 text-[12px] leading-relaxed"
      style={{
        borderLeft: "2px solid var(--color-t4)",
        background: "rgb(224 91 73 / 0.07)",
        color: "var(--color-ink-dim)",
      }}
    >
      {children}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div
      className="px-3 py-2 text-[12px] leading-relaxed"
      style={{
        borderLeft: "2px solid var(--color-t3)",
        background: "rgb(232 163 61 / 0.06)",
        color: "var(--color-ink-dim)",
      }}
    >
      {children}
    </div>
  );
}
