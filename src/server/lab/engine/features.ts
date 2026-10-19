import { TRANSFORMS, type FeatureSpec, type LabDataset, type Transform, type Trend } from "../types.js";

// Feature expansion (LAB.md §3). Every transform at day t reads only values at
// days ≤ t. NaN policy: the output at t is NaN when the raw value at t is
// missing, or when the window holds fewer than half its length in usable
// observations (minimum 2). Windows are direct loops, not running sums: exact,
// no drift, and cheap enough at the 600-feature cap.

export function featureId(spec: FeatureSpec): string {
  return `${spec.metric}|${spec.transform}|${spec.transform === "raw" ? 0 : spec.window}`;
}

export function parseFeatureId(id: string): FeatureSpec {
  const j = id.lastIndexOf("|");
  const i = j > 0 ? id.lastIndexOf("|", j - 1) : -1;
  if (i <= 0) throw new Error(`invalid feature id "${id}" (want metric|transform|window)`);
  const metric = id.slice(0, i);
  const transform = id.slice(i + 1, j) as Transform;
  const window = Number(id.slice(j + 1));
  if (!TRANSFORMS.includes(transform)) throw new Error(`invalid feature id "${id}": unknown transform "${transform}"`);
  if (!Number.isInteger(window) || (transform === "raw" ? window !== 0 : window < 2 || window > 365)) {
    throw new Error(`invalid feature id "${id}": window must be 0 for raw, 2..365 otherwise`);
  }
  return { metric, transform, window };
}

/**
 * Specs in a stable order: metric, then transform, then window. Metrics mapped
 * to false in `stationary` (trending levels) get no `raw` spec.
 */
export function featureSpecs(
  metrics: readonly string[],
  transforms: readonly Transform[],
  windows: readonly number[],
  stationary?: Readonly<Record<string, boolean>>,
): FeatureSpec[] {
  const out: FeatureSpec[] = [];
  const ws = [...new Set(windows)];
  for (const metric of new Set(metrics)) {
    for (const transform of new Set(transforms)) {
      if (transform === "raw") {
        if (stationary?.[metric] !== false) out.push({ metric, transform, window: 0 });
      }
      else for (const window of ws) out.push({ metric, transform, window });
    }
  }
  return out;
}

const minObs = (w: number) => Math.max(2, Math.ceil(w / 2));

export function transformSeries(x: ArrayLike<number>, transform: Transform, window: number): Float64Array {
  const n = x.length;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    v[i] = typeof xi === "number" && Number.isFinite(xi) ? xi : NaN;
  }
  if (transform === "raw") return v;
  const w = window;
  if (!Number.isInteger(w) || w < 2) throw new Error(`transform ${transform} needs an integer window ≥ 2, got ${w}`);
  const need = minObs(w);
  const out = new Float64Array(n).fill(NaN);

  switch (transform) {
    case "z":
    case "ma_ratio":
      for (let t = 0; t < n; t++) {
        if (Number.isNaN(v[t]!)) continue;
        let c = 0;
        let s = 0;
        for (let k = Math.max(0, t - w + 1); k <= t; k++) {
          const y = v[k]!;
          if (y === y) {
            c++;
            s += y;
          }
        }
        if (c < need) continue;
        const m = s / c;
        if (transform === "ma_ratio") {
          if (m !== 0) out[t] = (v[t]! - m) / Math.abs(m);
          continue;
        }
        let ss = 0;
        for (let k = Math.max(0, t - w + 1); k <= t; k++) {
          const y = v[k]!;
          if (y === y) ss += (y - m) * (y - m);
        }
        const sd = Math.sqrt(ss / (c - 1));
        // A flat window has no scale; tiny sd is float noise around a constant.
        if (sd > 1e-12 * Math.abs(m) && sd > 0) out[t] = (v[t]! - m) / sd;
      }
      return out;

    case "roc":
      for (let t = w; t < n; t++) {
        const a = v[t - w]!;
        if (a === a && a !== 0 && v[t] === v[t]) out[t] = (v[t]! - a) / Math.abs(a);
      }
      return out;

    case "vol":
    case "rsi": {
      // Daily changes: log changes for vol (both values > 0, else missing),
      // plain differences for rsi.
      const d = new Float64Array(n).fill(NaN);
      for (let t = 1; t < n; t++) {
        const a = v[t - 1]!;
        const b = v[t]!;
        if (transform === "vol") {
          if (a > 0 && b > 0) d[t] = Math.log(b / a);
        } else if (a === a && b === b) d[t] = b - a;
      }
      for (let t = 1; t < n; t++) {
        if (Number.isNaN(v[t]!)) continue;
        let c = 0;
        let s = 0;
        let up = 0;
        let dn = 0;
        for (let k = Math.max(1, t - w + 1); k <= t; k++) {
          const y = d[k]!;
          if (y !== y) continue;
          c++;
          s += y;
          if (y > 0) up += y;
          else dn -= y;
        }
        if (c < need) continue;
        if (transform === "rsi") {
          out[t] = up + dn === 0 ? 50 : (100 * up) / (up + dn);
          continue;
        }
        const m = s / c;
        let ss = 0;
        for (let k = Math.max(1, t - w + 1); k <= t; k++) {
          const y = d[k]!;
          if (y === y) ss += (y - m) * (y - m);
        }
        out[t] = Math.sqrt(ss / (c - 1));
      }
      return out;
    }

    case "pctile":
      for (let t = 0; t < n; t++) {
        const x0 = v[t]!;
        if (x0 !== x0) continue;
        let c = 0;
        let below = 0;
        let eq = 0;
        for (let k = Math.max(0, t - w + 1); k < t; k++) {
          const y = v[k]!;
          if (y !== y) continue;
          c++;
          if (y < x0) below++;
          else if (y === x0) eq++;
        }
        // c counts the other values in the window; rank among them, ties halved.
        if (c + 1 < need) continue;
        out[t] = (below + 0.5 * eq) / c;
      }
      return out;
  }
  throw new Error(`unknown transform ${transform as string}`);
}

export interface FeatureSet {
  ids: string[];
  specs: FeatureSpec[];
  columns: Float64Array[];
}

/** Expands every metric in the dataset (or the listed ones) into transformed columns aligned to data.t. */
export function buildFeatures(
  data: LabDataset,
  transforms: readonly Transform[],
  windows: readonly number[],
  metrics: readonly string[] = Object.keys(data.metrics),
): FeatureSet {
  const specs = featureSpecs(metrics, transforms, windows, data.stationary);
  const columns = specs.map((s) => {
    const vals = data.metrics[s.metric];
    if (!vals) throw new Error(`metric ${s.metric} is not in the dataset`);
    if (vals.length !== data.t.length) throw new Error(`metric ${s.metric} has ${vals.length} values for ${data.t.length} days`);
    return transformSeries(vals, s.transform, s.window);
  });
  return { ids: specs.map(featureId), specs, columns };
}

/** Metric part of a regime feature id: `regime:trend=<sorted values>`; built from the price, not a dataset metric. */
export const REGIME_PREFIX = "regime:trend=";
const TREND_PERSIST = 3;

const smaAt = (x: ArrayLike<number>, w: number, i: number): number => {
  if (i + 1 < w) return NaN;
  let s = 0;
  for (let k = i - w + 1; k <= i; k++) s += x[k]!;
  return s / w; // NaN when any close is missing
};

/**
 * Daily trend per day, ported from perpsignal regime.ts: raw "up" when
 * close > MA50, MA20 > MA50 and the 20-day ROC > 0, "down" when all three
 * point down, else "range"; a new value counts only after holding 3
 * consecutive days. Null until the first classifiable day. Day t reads closes ≤ t.
 */
export function trendSeries(close: ArrayLike<number>): (Trend | null)[] {
  const out: (Trend | null)[] = [];
  let state: Trend | null = null;
  let cand: Trend | null = null;
  let bars = 0;
  for (let i = 0; i < close.length; i++) {
    const ma50 = smaAt(close, 50, i);
    if (Number.isFinite(ma50)) {
      const c = close[i]!;
      const ma20 = smaAt(close, 20, i);
      const roc = c / close[i - 20]! - 1;
      const raw: Trend = c > ma50 && ma20 > ma50 && roc > 0 ? "up" : c < ma50 && ma20 < ma50 && roc < 0 ? "down" : "range";
      if (!state || raw === state) (state ??= raw), (cand = null), (bars = 0);
      else {
        bars = cand === raw ? bars + 1 : 1;
        cand = raw;
        if (bars >= TREND_PERSIST) (state = raw), (cand = null), (bars = 0);
      }
    }
    out.push(state);
  }
  return out;
}

/** In-set indicator for a regime metric: 1 when the day's trend is in the set, 0 when not, NaN when unknown. */
export function regimeColumn(metric: string, close: ArrayLike<number>): Float64Array {
  const set = new Set(metric.slice(REGIME_PREFIX.length).split(","));
  return Float64Array.from(trendSeries(close), (v) => (v == null ? NaN : set.has(v) ? 1 : 0));
}
