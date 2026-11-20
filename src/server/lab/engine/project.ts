import type { Projection, ProjectionTimeline } from "../types.js";
import { maxDrawdownOf } from "./fitness.js";
import { mulberry32 } from "./rng.js";
import { meanSd } from "./stats.js";

// Hypothetical future timelines (docs/AUTORESEARCH.md "Projection"): a block
// bootstrap of the asset's own daily returns, conditioned on the state today is
// in. A path starts on a past day that was in today's state and replays what
// followed; each next block starts on a day in the state the last block ended
// in, so regimes change at the rate they changed in history. It can only replay
// what the history contains.

export const MIN_PROJECT_DAYS = 120;
/** Fewest past days in a state before blocks are drawn from it; under this the draw is unconditional. */
export const MIN_ANALOG_DAYS = 20;
export const MAX_PROJECT_PATHS = 2000;

export interface ProjectOptions {
  horizonDays: number;
  paths?: number;
  blockDays?: number;
  seed?: number;
}

const BANDS: Array<{ label: ProjectionTimeline["label"]; lo: number; hi: number }> = [
  { label: "sharp drop", lo: -Infinity, hi: -1 },
  { label: "drift lower", lo: -1, hi: -1 / 3 },
  { label: "sideways", lo: -1 / 3, hi: 1 / 3 },
  { label: "drift higher", lo: 1 / 3, hi: 1 },
  { label: "sharp rally", lo: 1, hi: Infinity },
];

const q = (sorted: ArrayLike<number>, p: number) => sorted[Math.floor(p * (sorted.length - 1))]!;

/**
 * pr[i] is the return of day i (pr[0] unused); state[i] is the state known at
 * the close of day i (null = unknown). Values are multiples of today's price.
 */
export function project(pr: ArrayLike<number>, state: ArrayLike<string | null>, o: ProjectOptions): Projection {
  const n = pr.length;
  if (n - 1 < MIN_PROJECT_DAYS) throw new Error(`projection needs at least ${MIN_PROJECT_DAYS} days of returns, got ${Math.max(0, n - 1)}`);
  const h = o.horizonDays;
  const paths = Math.min(o.paths ?? 1000, MAX_PROJECT_PATHS);
  const block = Math.max(1, Math.min(o.blockDays ?? 10, h, n - 1));
  const rand = mulberry32(o.seed ?? 42);

  // Block starts j (first return pr[j]) filed under the state at the close before them.
  const all: number[] = [];
  const by = new Map<string, number[]>();
  for (let j = 1; j + block <= n; j++) {
    all.push(j);
    const s = state[j - 1];
    if (s == null) continue;
    let list = by.get(s);
    if (!list) by.set(s, (list = []));
    list.push(j);
  }
  const current = state[n - 1] ?? null;
  const analogs = current == null ? 0 : (by.get(current)?.length ?? 0);
  const conditioned = analogs >= MIN_ANALOG_DAYS;
  const startsFor = (s: string | null) => {
    const list = conditioned && s != null ? by.get(s) : undefined;
    return list && list.length >= MIN_ANALOG_DAYS ? list : all;
  };

  const values: Float64Array[] = [];
  for (let p = 0; p < paths; p++) {
    const v = new Float64Array(h + 1);
    v[0] = 1;
    let s = current;
    let d = 1;
    while (d <= h) {
      const starts = startsFor(s);
      const j = starts[Math.floor(rand() * starts.length)]!;
      for (let k = 0; k < block && d <= h; k++, d++) v[d] = v[d - 1]! * (1 + pr[j + k]!);
      s = state[j + block - 1] ?? null;
    }
    values.push(v);
  }

  const fan: Projection["fan"] = [];
  const col = new Float64Array(paths);
  for (let d = 0; d <= h; d++) {
    for (let p = 0; p < paths; p++) col[p] = values[p]![d]!;
    const sorted = Float64Array.from(col).sort();
    fan.push({ day: d, p10: q(sorted, 0.1), p25: q(sorted, 0.25), p50: q(sorted, 0.5), p75: q(sorted, 0.75), p90: q(sorted, 0.9) });
  }

  // Outcome bands in sigmas of the horizon move, from the whole history's daily volatility.
  const hist = Array.from({ length: n - 1 }, (_, i) => pr[i + 1]!);
  const sigma = meanSd(hist).sd * Math.sqrt(h);
  const finals = values.map((v) => v[h]! - 1);
  const drawdowns = values.map((v) => {
    const r = new Float64Array(h);
    for (let d = 1; d <= h; d++) r[d - 1] = v[d]! / v[d - 1]! - 1;
    return maxDrawdownOf(r);
  });
  const timelines: ProjectionTimeline[] = BANDS.map((b) => {
    const idx = finals.map((f, p) => ({ f, p })).filter(({ f }) => f / sigma >= b.lo && f / sigma < b.hi);
    idx.sort((x, y) => x.f - y.f);
    const mid = idx[Math.floor((idx.length - 1) / 2)];
    return {
      label: b.label,
      fromReturn: Number.isFinite(b.lo) ? b.lo * sigma : null,
      toReturn: Number.isFinite(b.hi) ? b.hi * sigma : null,
      likelihood: idx.length / paths,
      medianReturn: mid ? mid.f : null,
      path: mid ? Array.from(values[mid.p]!) : [],
    };
  });
  const sortedFinals = Float64Array.from(finals).sort();
  return {
    horizonDays: h,
    paths,
    blockDays: block,
    state: current,
    analogDays: analogs,
    conditioned,
    historyDays: n - 1,
    fan,
    timelines,
    pUp: finals.filter((f) => f > 0).length / paths,
    medianReturn: q(sortedFinals, 0.5),
    medianMaxDrawdown: q(Float64Array.from(drawdowns).sort(), 0.5),
  };
}
