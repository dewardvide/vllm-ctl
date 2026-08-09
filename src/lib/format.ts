/**
 * Display formatting. Shared by server and client, so no Node imports.
 *
 * Rule for this UI: a value and its unit are typographically distinct — the
 * number is the data, the unit is a label. These helpers therefore return the
 * pieces separately wherever the caller renders them apart.
 */

export function fixed(n: number | null | undefined, dp = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}

export function int(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** Bytes → the largest unit that keeps the mantissa under 1024. */
export function bytes(b: number | null | undefined): { value: string; unit: string } {
  if (b == null || !Number.isFinite(b)) return { value: "—", unit: "" };
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = Math.abs(b);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const dp = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return { value: (b < 0 ? -v : v).toFixed(i === 0 ? 0 : dp), unit: units[i] };
}

export function bytesStr(b: number | null | undefined): string {
  const { value, unit } = bytes(b);
  return unit ? `${value} ${unit}` : value;
}

/** Milliseconds → a compact latency string that stays readable across decades. */
export function ms(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1) return v.toFixed(2);
  if (v < 10) return v.toFixed(2);
  if (v < 1000) return v.toFixed(0);
  return (v / 1000).toFixed(2);
}

export function msUnit(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  return v < 1000 ? "ms" : "s";
}

/**
 * Milliseconds, always in milliseconds.
 *
 * `ms()` rescales past a second and must be paired with `msUnit()`. In a table
 * whose caption already declares the unit, that rescaling silently mixes
 * seconds and milliseconds in one column — 943 next to 1.03 reads as the wrong
 * ordering. Use this wherever the unit is stated once for the whole column.
 */
export function msFixed(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 10000) return Math.round(v).toLocaleString("en-US");
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/** Elapsed seconds → `1d 04h`, `4h 12m`, `14m 22s`, `47s`. */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function sinceStr(tsMs: number | null | undefined): string {
  if (!tsMs) return "—";
  return duration((Date.now() - tsMs) / 1000);
}

/** Large counts → `847`, `12.4k`, `3.1M`. Used where column width is tight. */
export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a < 1000) return n.toFixed(a < 10 && !Number.isInteger(n) ? 1 : 0);
  if (a < 1e6) return `${(n / 1e3).toFixed(a < 1e4 ? 1 : 0)}k`;
  if (a < 1e9) return `${(n / 1e6).toFixed(a < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function pct(n: number | null | undefined, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}

export function timeOfDay(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function dateTime(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const MIB_PER_GIB = 1024;
export const mibToGiB = (m: number) => m / MIB_PER_GIB;
