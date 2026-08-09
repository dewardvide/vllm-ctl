/**
 * The thermal ramp — the app's only source of data colour.
 *
 * Magnitude is encoded as a physical temperature: cold blue at idle through
 * teal at nominal, amber under load, vermilion at saturation. Status colours
 * are literally points on this ramp, so a "healthy" dot and a chart series at
 * 50% load are the same teal. One vocabulary, learned once.
 *
 * Lightness rises monotonically from t0 to t3 then falls slightly into t4,
 * which keeps the endpoints distinguishable without relying on hue alone.
 */

export const RAMP = [
  { t: 0.0, rgb: [0x1f, 0x3a, 0x5f] as const }, // idle
  { t: 0.3, rgb: [0x2e, 0x7b, 0xa6] as const }, // low
  { t: 0.55, rgb: [0x4f, 0xb3, 0xa5] as const }, // nominal
  { t: 0.8, rgb: [0xe8, 0xa3, 0x3d] as const }, // loaded
  { t: 1.0, rgb: [0xe0, 0x5b, 0x49] as const }, // saturated
] as const;

export const THERMAL = {
  t0: "#1f3a5f",
  t1: "#2e7ba6",
  t2: "#4fb3a5",
  t3: "#e8a33d",
  t4: "#e05b49",
} as const;

export const INK = {
  ink: "#e6edf3",
  dim: "#8ca0b3",
  faint: "#536170",
  rule: "#1e262e",
  ruleHi: "#2c3742",
  void: "#0b0e11",
  panel: "#12171c",
  signal: "#5ec8d8",
} as const;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear interpolation through the ramp. `t` is clamped to [0,1]. */
export function rampRgb(t: number): [number, number, number] {
  const x = clamp01(t);
  for (let i = 0; i < RAMP.length - 1; i++) {
    const a = RAMP[i];
    const b = RAMP[i + 1];
    if (x <= b.t) {
      const f = (x - a.t) / (b.t - a.t || 1);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
      ];
    }
  }
  const last = RAMP[RAMP.length - 1].rgb;
  return [last[0], last[1], last[2]];
}

export function ramp(t: number, alpha = 1): string {
  const [r, g, b] = rampRgb(t);
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

/** Convenience for percentage-valued metrics. */
export function rampPct(percent: number, alpha = 1): string {
  return ramp(percent / 100, alpha);
}

/**
 * Distinct hues for categorical series (one per deployment on the headroom
 * rail, one per run in a benchmark comparison). Deliberately drawn from the
 * cool half of the ramp so they never collide with the "saturated" warning
 * reds that mean something specific.
 */
export const SERIES = [
  "#4fb3a5",
  "#5ec8d8",
  "#7f8fd6",
  "#2e7ba6",
  "#69a5c4",
  "#a5c9a1",
  "#c9a6d6",
  "#3f8f7f",
] as const;

export function seriesColor(i: number): string {
  return SERIES[((i % SERIES.length) + SERIES.length) % SERIES.length];
}
