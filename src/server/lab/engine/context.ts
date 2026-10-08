import type { Condition, LabDataset } from "../types.js";
import { priceReturns } from "./backtest.js";
import { parseFeatureId, transformSeries } from "./features.js";
import { conditionSignal } from "./rules.js";
import { parseDay, sortedFinite } from "./util.js";

// Evaluation context over a [lo, hi] slice of a dataset. Feature columns are
// computed on the full history (so rolling windows warm up on data before
// `lo`, which is still causal) and sliced; built on demand and cached, so a
// rule evaluation only builds the features its conditions name.

export interface EvalCtx {
  asset: string;
  n: number;
  t: number[];
  price: Float64Array;
  pr: Float64Array;
  col(id: string): Float64Array;
  /** Sorted finite values of a feature over days [0, end). */
  sorted(id: string, end: number): Float64Array;
  signal(conds: Condition[], from?: number, to?: number): Uint8Array;
}

export function checkDataset(data: LabDataset): void {
  const n = data.t.length;
  if (data.price.length !== n) throw new Error(`dataset has ${n} days but ${data.price.length} prices`);
  for (let i = 1; i < n; i++) {
    if (!(data.t[i]! > data.t[i - 1]!)) throw new Error("dataset days must be strictly ascending");
  }
  for (const [id, v] of Object.entries(data.metrics)) {
    if (v.length !== n) throw new Error(`metric ${id} has ${v.length} values for ${n} days`);
  }
}

/** Inclusive index range of days within [from, to] (YYYY-MM-DD, both optional). */
export function rangeIndices(t: number[], from?: string, to?: string): [number, number] {
  const a = from ? parseDay(from) : -Infinity;
  const b = to ? parseDay(to) : Infinity;
  let lo = 0;
  while (lo < t.length && t[lo]! < a) lo++;
  let hi = t.length - 1;
  while (hi >= lo && t[hi]! > b) hi--;
  if (hi < lo) throw new Error(`no data between ${from ?? "start"} and ${to ?? "end"}`);
  return [lo, hi];
}

export function makeCtx(data: LabDataset, lo = 0, hi = data.t.length - 1): EvalCtx {
  const cols = new Map<string, Float64Array>();
  const sorts = new Map<string, Float64Array>();
  const price = Float64Array.from(data.price.slice(lo, hi + 1), (x) => (Number.isFinite(x) ? x : NaN));
  const n = price.length;
  const col = (id: string): Float64Array => {
    let c = cols.get(id);
    if (!c) {
      const spec = parseFeatureId(id);
      const vals = data.metrics[spec.metric];
      if (!vals) throw new Error(`metric ${spec.metric} is not in the dataset`);
      c = transformSeries(vals, spec.transform, spec.window).slice(lo, hi + 1);
      cols.set(id, c);
    }
    return c;
  };
  return {
    asset: data.asset,
    n,
    t: data.t.slice(lo, hi + 1),
    price,
    pr: priceReturns(price),
    col,
    sorted(id, end) {
      const k = `${id}@${end}`;
      let s = sorts.get(k);
      if (!s) {
        s = sortedFinite(col(id), 0, end);
        sorts.set(k, s);
      }
      return s;
    },
    signal(conds, from = 0, to = n) {
      return conditionSignal(
        conds.map((c) => col(c.feature)),
        conds,
        n,
        from,
        to,
      );
    },
  };
}
