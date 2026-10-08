import { TRANSFORMS, type FeatureSpec, type LabDataset, type Transform } from "../types.js";

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

/** Specs in a stable order: metric, then transform, then window. */
export function featureSpecs(metrics: readonly string[], transforms: readonly Transform[], windows: readonly number[]): FeatureSpec[] {
  const out: FeatureSpec[] = [];
  const ws = [...new Set(windows)];
  for (const metric of new Set(metrics)) {
    for (const transform of new Set(transforms)) {
      if (transform === "raw") out.push({ metric, transform, window: 0 });
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
  const specs = featureSpecs(metrics, transforms, windows);
  const columns = specs.map((s) => {
    const vals = data.metrics[s.metric];
    if (!vals) throw new Error(`metric ${s.metric} is not in the dataset`);
    if (vals.length !== data.t.length) throw new Error(`metric ${s.metric} has ${vals.length} values for ${data.t.length} days`);
    return transformSeries(vals, s.transform, s.window);
  });
  return { ids: specs.map(featureId), specs, columns };
}
