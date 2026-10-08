// Daily grid alignment and causal feature transforms. Pure, no I/O.
// Every transform at index t reads only indices <= t, and alignDaily applies
// each base's publication lag, so a feature at t is something a trader could
// have known at the close of day t.
import { featureId, labBase, labTransform, transformsFor, type LabBase, type LabTransform } from "../../shared/lab.js";

export const DAY_MS = 86_400_000;
/** Gaps up to this many days carry the last value forward; longer gaps stay NaN. */
export const MAX_FILL_DAYS = 7;

export const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Places observations on the daily grid `days` (UTC day starts, ascending,
 * contiguous). The value at day i is the last observation dated day i - lag,
 * forward-filled over gaps of at most MAX_FILL_DAYS. Intraday points collapse
 * to the day's last one.
 */
export function alignDaily(points: { ts: number; value: number }[], days: number[], lagDays = 0): Float64Array {
  const out = new Float64Array(days.length).fill(NaN);
  if (days.length === 0 || points.length === 0) return out;
  const byDay = new Map<number, number>();
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  for (const p of sorted) if (Number.isFinite(p.value)) byDay.set(dayStart(p.ts), p.value);

  let last = NaN;
  let lastDay = -Infinity;
  for (let i = 0; i < days.length; i++) {
    const src = days[i]! - lagDays * DAY_MS;
    const v = byDay.get(src);
    if (v !== undefined) {
      last = v;
      lastDay = src;
    }
    if (Number.isFinite(last) && (src - lastDay) / DAY_MS <= MAX_FILL_DAYS) out[i] = last;
  }
  return out;
}

/** Contiguous UTC day starts from `from` to `to` inclusive. */
export function dayGrid(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = dayStart(from); d <= dayStart(to); d += DAY_MS) out.push(d);
  return out;
}

// ─── rolling helpers (finite-aware) ───

/** Rolling mean over `w` days; NaN until at least 80% of the window is finite. */
export function rollingMean(x: Float64Array, w: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const need = Math.ceil(w * 0.8);
  let sum = 0;
  let cnt = 0;
  for (let t = 0; t < x.length; t++) {
    const v = x[t]!;
    if (Number.isFinite(v)) {
      sum += v;
      cnt++;
    }
    if (t >= w) {
      const old = x[t - w]!;
      if (Number.isFinite(old)) {
        sum -= old;
        cnt--;
      }
    }
    if (t >= w - 1 && cnt >= need && Number.isFinite(v)) out[t] = sum / cnt;
  }
  return out;
}

/** Rolling z-score of x[t] against the trailing `w`-day window (inclusive). */
export function rollingZ(x: Float64Array, w: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const need = Math.ceil(w * 0.8);
  for (let t = w - 1; t < x.length; t++) {
    const v = x[t]!;
    if (!Number.isFinite(v)) continue;
    // Two-pass per window: exact and still cheap at daily resolution.
    let sum = 0;
    let cnt = 0;
    for (let k = t - w + 1; k <= t; k++) {
      const u = x[k]!;
      if (Number.isFinite(u)) {
        sum += u;
        cnt++;
      }
    }
    if (cnt < need) continue;
    const mean = sum / cnt;
    let ss = 0;
    for (let k = t - w + 1; k <= t; k++) {
      const u = x[k]!;
      if (Number.isFinite(u)) ss += (u - mean) ** 2;
    }
    const sd = Math.sqrt(ss / (cnt - 1));
    if (sd > 0) out[t] = (v - mean) / sd;
  }
  return out;
}

/** Percentile rank (0-100) of x[t] within its trailing `w`-day window. */
export function rollingPercentile(x: Float64Array, w: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const need = Math.ceil(w * 0.8);
  for (let t = w - 1; t < x.length; t++) {
    const v = x[t]!;
    if (!Number.isFinite(v)) continue;
    let le = 0;
    let cnt = 0;
    for (let k = t - w + 1; k <= t; k++) {
      const u = x[k]!;
      if (!Number.isFinite(u)) continue;
      cnt++;
      if (u <= v) le++;
    }
    if (cnt >= need) out[t] = (le / cnt) * 100;
  }
  return out;
}

export function rateOfChange(x: Float64Array, k: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  for (let t = k; t < x.length; t++) {
    const a = x[t - k]!;
    const b = x[t]!;
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0) out[t] = b / a - 1;
  }
  return out;
}

const ratio = (num: Float64Array, den: Float64Array): Float64Array => {
  const out = new Float64Array(num.length).fill(NaN);
  for (let t = 0; t < num.length; t++) {
    const a = num[t]!;
    const b = den[t]!;
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) out[t] = a / b - 1;
  }
  return out;
};

/** Wilder RSI on the series' own day-over-day changes; restarts after a gap. */
export function rsi(x: Float64Array, n = 14): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  let seen = 0;
  for (let t = 1; t < x.length; t++) {
    const a = x[t - 1]!;
    const b = x[t]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      gain = loss = seen = 0;
      continue;
    }
    const d = b - a;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    seen++;
    if (seen <= n) {
      gain += g / n;
      loss += l / n;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    if (seen >= n) out[t] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function applyTransform(x: Float64Array, t: LabTransform): Float64Array {
  switch (t.id) {
    case "raw":
      return Float64Array.from(x);
    case "z90":
      return rollingZ(x, 90);
    case "z365":
      return rollingZ(x, 365);
    case "pct365":
      return rollingPercentile(x, 365);
    case "roc7":
      return rateOfChange(x, 7);
    case "roc30":
      return rateOfChange(x, 30);
    case "roc90":
      return rateOfChange(x, 90);
    case "ma30r":
      return ratio(x, rollingMean(x, 30));
    case "ma200r":
      return ratio(x, rollingMean(x, 200));
    case "ma365r":
      return ratio(x, rollingMean(x, 365));
    case "x30_90":
      return ratio(rollingMean(x, 30), rollingMean(x, 90));
    case "rsi14":
      return rsi(x, 14);
    default:
      throw new Error(`unknown transform ${t.id}`);
  }
}

// ─── dataset ───

/** Aligned daily data the engine runs on. `bases` values are already lagged. */
export interface LabDataset {
  days: number[];
  close: Float64Array;
  bases: Record<string, Float64Array>;
}

export interface FeatureMatrix {
  ids: string[];
  values: Float64Array[];
}

/** Every (base, transform) pair requested, skipping all-NaN features. */
export function buildFeatures(ds: LabDataset, baseIds: string[], transformIds?: string[]): FeatureMatrix {
  const ids: string[] = [];
  const values: Float64Array[] = [];
  for (const id of baseIds) {
    const base = labBase(id);
    const x = ds.bases[id];
    if (!base || !x) continue;
    for (const t of transformsFor(base)) {
      if (transformIds && !transformIds.includes(t.id)) continue;
      const v = applyTransform(x, t);
      if (v.some(Number.isFinite)) {
        ids.push(featureId(id, t.id));
        values.push(v);
      }
    }
  }
  return { ids, values };
}

/** One feature by id, computed on demand (rule evaluation outside a search). */
export function computeFeature(ds: LabDataset, id: string): Float64Array | null {
  const i = id.lastIndexOf("|");
  const base: LabBase | undefined = labBase(id.slice(0, i));
  const t = labTransform(id.slice(i + 1));
  const x = base ? ds.bases[base.id] : undefined;
  if (!base || !t || !x) return null;
  return applyTransform(x, t);
}
