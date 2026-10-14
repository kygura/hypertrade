import { FixedWindowSchema, HEATMAP_METRICS, type FixedWindow, type FlowFlag, type FlowRow, type HeatmapMetric, type SnapshotRow } from "../../shared/intel.js";
import { metricValue } from "./diff.js";
import type { Point } from "./normalize.js";
import { median } from "./util.js";

// Fixed windows, regime flips and threshold crossings (SPEC.md § Flow F0.2,
// F0.3). Pure. Runs alongside the I0.4 last-review baseline, not instead of it.
//   Δ per window: log change (price, OI, volume24h, depth, spread), plain
//   difference (funding, basis, premium, long/short ratio), or the window total
//   for per-interval flows (liquidations, perp and spot volume; z on
//   log(1 + total), delta = the total in USD).
//   z = (Δ − median) / σ against the trailing non-overlapping Δs of the same
//   length (stride = window, so samples are independent); σ = MAD × 1.4826,
//   floored per metric (METRIC_RULES) so a flat series cannot explode z.
//   An endpoint counts when a sample sits within ±20 min of the grid point.
//   Lookback 30 d for 1 h / 6 h (≥ 48 / 20 Δs), 90 d for 24 h (≥ 30); fewer → z null.
// Flips and crossings fire on the transition only: state at the window's
// start vs now, both known.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export const FIXED_WINDOWS = FixedWindowSchema.options;
export const WINDOW_HOURS: Record<FixedWindow, number> = { "1h": 1, "6h": 6, "24h": 24 };
export const ENDPOINT_TOLERANCE_MS = 20 * MIN_MS;
export const LOOKBACK: Record<FixedWindow, { days: number; min: number }> = {
  "1h": { days: 30, min: 48 },
  "6h": { days: 30, min: 20 },
  "24h": { days: 90, min: 30 },
};
/** Robust σ = MAD × this (σ of a normal distribution). */
export const MAD_SCALE = 1.4826;

export type DeltaKind = "log" | "diff" | "sum";
/** How each metric's Δ is taken and the floor on its σ, in Δ units (log points, raw units, or log(1 + USD)). */
export const METRIC_RULES: Record<HeatmapMetric, { kind: DeltaKind; floor: number }> = {
  price: { kind: "log", floor: 1e-4 }, // 0.01%
  oi_usd: { kind: "log", floor: 1e-4 },
  funding: { kind: "diff", floor: 1e-6 }, // hourly rate (SPEC F0.2)
  basis: { kind: "diff", floor: 1e-5 }, // 0.1 bp
  premium: { kind: "diff", floor: 1e-5 },
  vol24h: { kind: "log", floor: 1e-3 },
  depth_2: { kind: "log", floor: 1e-3 },
  spread_bps: { kind: "log", floor: 1e-2 },
  long_short_ratio: { kind: "diff", floor: 1e-3 },
  liq_usd: { kind: "sum", floor: 0.1 },
  perp_volume_usd: { kind: "sum", floor: 0.05 },
  spot_volume_usd: { kind: "sum", floor: 0.05 },
};

export type Series = Partial<Record<HeatmapMetric, Point[]>>;

export type WindowResult = {
  metric: HeatmapMetric;
  window: FixedWindow;
  /** pct change (log kind), raw difference (diff), window total (sum); null without both endpoints. */
  delta: number | null;
  z: number | null;
};

/**
 * Heatmap series from stored rows. oi_usd and funding are HL's (snapshots);
 * depth_2 = bid + ask within ±2%; liq_usd = long + short per ts. Flow OI,
 * funding and buy volume are not heatmap columns and are left out.
 */
export function seriesFromRows(snapshots: SnapshotRow[], flow: FlowRow[]): Series {
  const out: Record<string, Point[]> = {};
  const add = (m: HeatmapMetric, t: number, v: number | null) => {
    if (v != null && Number.isFinite(v) && Number.isFinite(t)) (out[m] ??= []).push({ t, v });
  };
  for (const r of snapshots) {
    const t = Date.parse(r.ts);
    for (const m of ["price", "oi_usd", "funding", "basis", "premium", "vol24h", "spread_bps"] as const) add(m, t, metricValue(r, m));
    add("depth_2", t, r.depthBid2 != null && r.depthAsk2 != null ? r.depthBid2 + r.depthAsk2 : null);
  }
  const liq = new Map<number, number>();
  for (const r of flow) {
    const t = Date.parse(r.ts);
    if (r.metric === "liq_long_usd" || r.metric === "liq_short_usd") liq.set(t, (liq.get(t) ?? 0) + r.value);
    else if (r.metric === "long_short_ratio" || r.metric === "perp_volume_usd" || r.metric === "spot_volume_usd") add(r.metric, t, r.value);
  }
  for (const [t, v] of liq) add("liq_usd", t, v);
  for (const k of Object.keys(out)) out[k]!.sort((a, b) => a.t - b.t);
  return out;
}

/** Index of the first point with p.t > t (points ascending). */
function upper(points: Point[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The sample nearest `t` within ±20 min, else null. `points` ascending. */
export function valueAt(points: Point[], t: number): number | null {
  const i = upper(points, t);
  let best: Point | null = null;
  for (const p of [points[i - 1], points[i]]) if (p && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
  return best && Math.abs(best.t - t) <= ENDPOINT_TOLERANCE_MS ? best.v : null;
}

export function robustSigma(xs: number[], floor: number): number {
  const m = median(xs);
  return Math.max(floor, median(xs.map((x) => Math.abs(x - m))) * MAD_SCALE);
}

/** Δ over (end − ms, end]: `stat` is what z is taken on, `delta` what is shown. */
function windowStat(metric: HeatmapMetric, points: Point[], prefix: number[], end: number, ms: number): { stat: number; delta: number } | null {
  const a = valueAt(points, end - ms);
  const b = valueAt(points, end);
  if (a == null || b == null) return null;
  const kind = METRIC_RULES[metric].kind;
  if (kind === "diff") return { stat: b - a, delta: b - a };
  if (kind === "log") return a > 0 && b > 0 ? { stat: Math.log(b / a), delta: (b / a - 1) * 100 } : null;
  const total = prefix[upper(points, end)]! - prefix[upper(points, end - ms)]!;
  return { stat: Math.log1p(Math.max(0, total)), delta: total };
}

/** Δ and z of one metric over one window ending at `now`. */
export function windowResult(metric: HeatmapMetric, points: Point[] | undefined, now: number, window: FixedWindow): WindowResult {
  return { metric, window, ...spanResult(metric, points, now, WINDOW_HOURS[window] * HOUR_MS, LOOKBACK[window]) };
}

/**
 * Δ and z over an arbitrary span (the heatmap's "since review" column): the
 * same non-overlapping-Δ z, with the lookback of the smallest fixed window
 * at least that long (24 h's beyond a day).
 */
export function spanResult(
  metric: HeatmapMetric,
  points: Point[] | undefined,
  now: number,
  ms: number,
  lookback = LOOKBACK[FIXED_WINDOWS.find((w) => WINDOW_HOURS[w] * HOUR_MS >= ms) ?? "24h"],
): { delta: number | null; z: number | null } {
  const out: { delta: number | null; z: number | null } = { delta: null, z: null };
  if (!points?.length) return out;
  const prefix = [0];
  for (const p of points) prefix.push(prefix.at(-1)! + p.v);
  const cur = windowStat(metric, points, prefix, now, ms);
  if (!cur) return out;
  out.delta = cur.delta;
  const { days, min } = lookback;
  const hist: number[] = [];
  for (let end = now - ms; end - ms >= now - days * DAY_MS; end -= ms) {
    const s = windowStat(metric, points, prefix, end, ms);
    if (s) hist.push(s.stat);
  }
  if (hist.length >= min) out.z = (cur.stat - median(hist)) / robustSigma(hist, METRIC_RULES[metric].floor);
  return out;
}

/** Every heatmap metric × fixed window; a metric with no series reads null. */
export function computeWindows(series: Series, now: number): WindowResult[] {
  return HEATMAP_METRICS.flatMap((m) => FIXED_WINDOWS.map((w) => windowResult(m, series[m], now, w)));
}

export function pickWindow(results: WindowResult[], metric: HeatmapMetric, window: FixedWindow): WindowResult | undefined {
  return results.find((r) => r.metric === metric && r.window === window);
}

/** Level z of the value at `now` vs the trailing 30-day samples (median, robust σ); ≥ 48 samples. */
export function robustLevelZ(metric: HeatmapMetric, points: Point[] | undefined, now: number): number | null {
  if (!points?.length) return null;
  const v = valueAt(points, now);
  if (v == null) return null;
  const xs = points.filter((p) => p.t <= now && p.t >= now - LOOKBACK["1h"].days * DAY_MS).map((p) => p.v);
  if (xs.length < LOOKBACK["1h"].min) return null;
  return (v - median(xs)) / robustSigma(xs, METRIC_RULES[metric].floor);
}

// ---------------------------------------------------------------- flips and crossings

export type Threshold = { metric: HeatmapMetric; op: ">" | "<"; value: number };
/** 0.05% per 8 h, expressed hourly (SPEC F0.3). */
export const DEFAULT_THRESHOLDS = "funding>0.0000625";

/** INTEL_THRESHOLDS: comma list of `metric>value` / `metric<value` over heatmap metrics; bad entries are skipped. */
export function parseThresholds(raw: string | undefined): Threshold[] {
  const out: Threshold[] = [];
  for (const part of (raw?.trim() ? raw : DEFAULT_THRESHOLDS).split(",")) {
    const m = /^\s*([a-z0-9_]+)\s*([<>])\s*(\S+)\s*$/.exec(part);
    const value = Number(m?.[3]);
    if (m && (HEATMAP_METRICS as readonly string[]).includes(m[1]!) && Number.isFinite(value)) out.push({ metric: m[1] as HeatmapMetric, op: m[2] as ">" | "<", value });
  }
  return out;
}

export function flowFlag(f: Omit<FlowFlag, "id" | "ts" | "researchId"> & { now: number }): FlowFlag {
  const { now, ...rest } = f;
  const ts = new Date(now).toISOString();
  return { id: `${f.kind}:${f.name}:${f.asset}:${f.window}:${ts}`, ...rest, ts, researchId: null };
}

const absOr0 = (z: number | null | undefined) => (z == null ? 0 : Math.abs(z));
const oiUpPriceDown = (oi: WindowResult, price: WindowResult): boolean | null =>
  oi.z == null || price.z == null ? null : oi.z >= 1 && price.z <= -1;

/**
 * Per window: funding and basis sign flips (start vs now), OI up while price
 * down (both |z| ≥ 1; now vs the previous window), and threshold crossings
 * into the `metric op value` state. Score = |z| of the metric's window Δ (0 when null).
 */
export function regimeFlags(asset: string, series: Series, now: number, thresholds: Threshold[]): FlowFlag[] {
  const flags: FlowFlag[] = [];
  for (const window of FIXED_WINDOWS) {
    const start = now - WINDOW_HOURS[window] * HOUR_MS;
    const zOf = (m: HeatmapMetric) => windowResult(m, series[m], now, window).z;
    for (const metric of ["funding", "basis"] as const) {
      const a = valueAt(series[metric] ?? [], start);
      const b = valueAt(series[metric] ?? [], now);
      if (a == null || b == null || a === 0 || b === 0 || Math.sign(a) === Math.sign(b)) continue;
      flags.push(flowFlag({ asset, kind: "flip", name: `${metric}_flip`, window, numbers: { from: a, to: b }, score: absOr0(zOf(metric)), degraded: false, now }));
    }
    const oi = windowResult("oi_usd", series.oi_usd, now, window);
    const price = windowResult("price", series.price, now, window);
    const before = oiUpPriceDown(windowResult("oi_usd", series.oi_usd, start, window), windowResult("price", series.price, start, window));
    if (oiUpPriceDown(oi, price) && before === false) {
      flags.push(
        flowFlag({
          asset, kind: "flip", name: "oi_up_price_down", window,
          numbers: { oi_z: oi.z!, price_z: price.z!, oi_pct: oi.delta!, price_pct: price.delta! },
          score: Math.max(Math.abs(oi.z!), Math.abs(price.z!)), degraded: false, now,
        }),
      );
    }
    for (const t of thresholds) {
      const inState = (v: number | null) => (v == null ? null : t.op === ">" ? v > t.value : v < t.value);
      const a = valueAt(series[t.metric] ?? [], start);
      const b = valueAt(series[t.metric] ?? [], now);
      if (inState(b) !== true || inState(a) !== false) continue;
      flags.push(
        flowFlag({ asset, kind: "crossing", name: `${t.metric}${t.op}${t.value}`, window, numbers: { from: a!, to: b!, threshold: t.value }, score: absOr0(zOf(t.metric)), degraded: false, now }),
      );
    }
  }
  return flags;
}
