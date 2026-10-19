// Next-bull-run estimate on top of the cycle model (cycles.ts). A bull run is
// an episode of committed `euphoria` phase; runs closer than a year apart
// merge into one (2013's April and November legs, 2024's March and November
// legs). Euphoria sets in Mar 2013, Mar 2017, Dec 2020 and Mar 2024.
//
// A run can be dated from two points (OnsetKind). `euphoria` is that first
// euphoric day. `breakout` is where the final doubling into it began: the
// first close of the closing stretch that stays above half the euphoria-onset
// price. It lands on 20 Oct 2016, 19 Oct 2020 and 23 Oct 2023, the "October
// of the year before" start.
//
// Four timing methods each project the next onset from a different anchor,
// using every past cycle's offset from that anchor; the estimate is the pooled
// distribution of those candidate dates. Descriptive, not a prediction: four
// cycles is a small sample, and the method spread is the honest error bar.

import { DAY_MS, HALVINGS, NEXT_HALVING_ESTIMATE, type CyclePhase, type CyclePoint } from "./cycles.js";

/** Euphoria runs closer than this belong to one bull run. */
export const MERGE_GAP_DAYS = 365;
/** Drawdown from the running high that marks a bear market (every past bear reached -77% or worse). */
export const BEAR_BREAK = -0.55;
/** A run's breakout is where closes last rose through this fraction of its euphoria-onset price. */
export const BREAKOUT_RATIO = 0.5;
/** History needed before the first onset to read a meaningful prior low. */
const MIN_PRE_HISTORY_DAYS = 365;

export interface PricePoint {
  t: number;
  price: number;
}

export type OnsetKind = "breakout" | "euphoria";

export interface BullEpisode {
  /** Start of the final doubling into euphoria: first close of the run-up that stays above BREAKOUT_RATIO × onset price. */
  breakout: PricePoint;
  /** First day of committed euphoria. */
  start: number;
  /** Last day of committed euphoria in the merged run. */
  end: number;
  startPrice: number;
  /** Highest close from the onset until the next run's onset (or today). */
  top: PricePoint;
  /** Lowest close after the top, before the next run (or today). */
  low: PricePoint | null;
  /** False for the latest run: its low can still be undercut. */
  lowConfirmed: boolean;
}

export type MethodKey = "rhythm" | "halving" | "low" | "top";

export interface EstimateMethod {
  key: MethodKey;
  label: string;
  /** What the offsets are measured from, and its date for the next run. */
  anchor: { label: string; t: number; estimated: boolean };
  /** Past offsets (days) from anchor to onset, oldest cycle first, with the cycle each came from. */
  samples: { cycle: number; days: number; date: number }[];
  median: number;
  from: number;
  to: number;
}

export interface DateRange {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

export interface Readiness {
  phase: CyclePhase | null;
  phaseSince: number | null;
  price: number;
  ath: PricePoint;
  /** Fraction price must rise to reclaim the ATH; past onsets sat within ~10% of it. */
  toAth: number;
  daysSinceTop: number;
  drawdown: number;
  /** Lowest close since the last top (provisional until the next run starts). */
  low: PricePoint | null;
  lowDepth: number | null;
  bounce: number | null;
  /** Depth of each completed bear market (top to low), oldest first. */
  priorBearDepths: number[];
  /** Days since top as a fraction of the median top-to-next-onset gap. */
  elapsed: number | null;
}

export interface CycleForecast {
  asOf: number;
  /** Which point of each run the methods date it from. */
  kind: OnsetKind;
  /** "in_run" while the latest run is still live; the estimate then points past it. */
  status: "in_run" | "between_runs";
  episodes: BullEpisode[];
  methods: EstimateMethod[];
  onset: DateRange | null;
  /** Onset median + past onset-to-top durations. */
  top: DateRange | null;
  readiness: Readiness | null;
  nextHalving: number;
}

export interface CycleAnalog {
  /** Calendar year of the cycle top. */
  label: string;
  topT: number;
  topPrice: number;
  current: boolean;
  /** Days from top to the next run's euphoria onset and breakout; null for the current cycle. */
  onsetDay: number | null;
  breakoutDay: number | null;
  lowDay: number | null;
  /** Weekly samples: d = days since top, r = close / top close. */
  points: { d: number; r: number }[];
}

const days = (ms: number) => Math.round(ms / DAY_MS);

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function range(values: number[]): DateRange | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => Math.round(quantile(s, p) / DAY_MS) * DAY_MS;
  return { min: s[0]!, p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1]! };
}

function argExtreme(points: CyclePoint[], from: number, to: number, pick: (a: number, b: number) => boolean): number {
  let best = -1;
  for (let i = from; i < to; i++) if (best < 0 || pick(points[i]!.c, points[best]!.c)) best = i;
  return best;
}

/** Merged euphoria runs with their cycle top and the low after it. */
export function bullEpisodes(points: CyclePoint[]): BullEpisode[] {
  const runs: { s: number; e: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.phase !== "euphoria") continue;
    let e = i;
    while (e + 1 < points.length && points[e + 1]!.phase === "euphoria") e++;
    const last = runs[runs.length - 1];
    if (last && points[i]!.t - points[last.e]!.t <= MERGE_GAP_DAYS * DAY_MS) last.e = e;
    else runs.push({ s: i, e });
    i = e;
  }
  const spans = runs.map((r, k) => {
    const next = runs[k + 1]?.s ?? points.length;
    // The top is the high before the bear market breaks it: the first close,
    // after the run ends, at BEAR_BREAK below the running high. 2021's April
    // high and July dip (-53%) stay inside the run; November is the top.
    let peak = points[r.s]!.c;
    let brk = next;
    for (let i = r.s; i < next; i++) {
      peak = Math.max(peak, points[i]!.c);
      if (i > r.e && points[i]!.c <= peak * (1 + BEAR_BREAK)) {
        brk = i;
        break;
      }
    }
    const top = argExtreme(points, r.s, brk, (a, b) => a > b);
    const low = top + 1 < next ? argExtreme(points, top + 1, next, (a, b) => a < b) : -1;
    return { r, top, low };
  });
  return spans.map(({ r, top, low }, k) => {
    // Breakout: walk back from the onset while closes stay above BREAKOUT_RATIO
    // of its price, no further than the previous run's low.
    const floor = k > 0 ? Math.max(spans[k - 1]!.low, 0) : 0;
    const level = points[r.s]!.c * BREAKOUT_RATIO;
    let b = r.s;
    while (b > floor && points[b - 1]!.c > level) b--;
    return {
      breakout: { t: points[b]!.t, price: points[b]!.c },
      start: points[r.s]!.t,
      end: points[r.e]!.t,
      startPrice: points[r.s]!.c,
      top: { t: points[top]!.t, price: points[top]!.c },
      low: low < 0 ? null : { t: points[low]!.t, price: points[low]!.c },
      lowConfirmed: k + 1 < runs.length,
    };
  });
}

function nearestHalving(t: number): number {
  return HALVINGS.reduce((best, h) => (Math.abs(h - t) < Math.abs(best - t) ? h : best), HALVINGS[0]);
}

function method(key: MethodKey, label: string, anchor: EstimateMethod["anchor"], samples: { cycle: number; days: number }[]): EstimateMethod | null {
  if (samples.length === 0) return null;
  const full = samples.map((s) => ({ ...s, date: anchor.t + s.days * DAY_MS }));
  const r = range(full.map((s) => s.date))!;
  return { key, label, anchor, samples: full, median: r.median, from: r.min, to: r.max };
}

/**
 * The estimate. `points` are daily cycle points (computeCycle), ascending.
 * Needs at least two bull runs in history; with fewer the methods are empty
 * and `onset` is null.
 */
export function forecastNextRun(
  points: CyclePoint[],
  opts: { kind?: OnsetKind; nextHalving?: number } = {},
): CycleForecast {
  const { kind = "breakout", nextHalving = NEXT_HALVING_ESTIMATE } = opts;
  const last = points[points.length - 1];
  const episodes = bullEpisodes(points);
  const latest = episodes[episodes.length - 1];
  const on = (e: BullEpisode) => (kind === "breakout" ? e.breakout.t : e.start);
  const base: CycleForecast = { asOf: last?.t ?? 0, kind, status: "between_runs", episodes, methods: [], onset: null, top: null, readiness: null, nextHalving };
  if (!last || !latest) return base;

  const year = (t: number) => new Date(t).getUTCFullYear();
  // Still live while euphoria is recent and price hasn't broken 35% below the top.
  const inRun = last.t - latest.end <= 90 * DAY_MS && last.c / latest.top.price - 1 > -0.35;

  // Low before the first run, when enough history precedes it.
  const firstIdx = points.findIndex((p) => p.t === on(episodes[0]!));
  const preLow =
    firstIdx >= MIN_PRE_HISTORY_DAYS ? (() => {
      const i = argExtreme(points, 0, firstIdx, (a, b) => a < b);
      return { t: points[i]!.t, price: points[i]!.c };
    })() : null;

  const methods: EstimateMethod[] = [];
  if (!inRun && episodes.length >= 2) {
    const later = episodes.slice(1);
    const m1 = method(
      "rhythm",
      "Run-to-run rhythm",
      { label: `${year(on(latest))} ${kind}`, t: on(latest), estimated: false },
      later.map((e, i) => ({ cycle: year(on(e)), days: days(on(e) - on(episodes[i]!)) })),
    );
    const m2 = method(
      "halving",
      "Halving offset",
      { label: "next halving", t: nextHalving, estimated: true },
      episodes.map((e) => ({ cycle: year(on(e)), days: days(on(e) - nearestHalving(on(e))) })),
    );
    const lows = episodes.map((e, i) => (i === 0 ? preLow : episodes[i - 1]!.low));
    const m3 = latest.low
      ? method(
          "low",
          "Bear-market low",
          { label: "low since top", t: latest.low.t, estimated: true },
          episodes.flatMap((e, i) => (lows[i] ? [{ cycle: year(on(e)), days: days(on(e) - lows[i]!.t) }] : [])),
        )
      : null;
    const m4 = method(
      "top",
      "Previous cycle top",
      { label: `${year(latest.top.t)} top`, t: latest.top.t, estimated: false },
      later.map((e, i) => ({ cycle: year(on(e)), days: days(on(e) - episodes[i]!.top.t) })),
    );
    for (const m of [m1, m2, m3, m4]) if (m) methods.push(m);
  }

  const onsetDates = methods.flatMap((m) => m.samples.map((s) => s.date));
  const onset = range(onsetDates);
  // Every candidate onset plus every completed run's onset-to-top length.
  const runLengths = episodes.filter((e) => e.lowConfirmed).map((e) => e.top.t - on(e));
  const top = range(onsetDates.flatMap((o) => runLengths.map((d) => o + d)));

  // Readiness: where today sits between the last top and the next run.
  let phaseSince: number | null = null;
  for (let i = points.length - 1; i >= 0 && points[i]!.phase === last.phase; i--) phaseSince = points[i]!.t;
  let ath = points[0]!;
  for (const p of points) if (p.c > ath.c) ath = p;
  const gaps = episodes.slice(1).map((e, i) => on(e) - episodes[i]!.top.t).sort((a, b) => a - b);
  const sinceTop = last.t - latest.top.t;
  const readiness: Readiness = {
    phase: last.phase,
    phaseSince,
    price: last.c,
    ath: { t: ath.t, price: ath.c },
    toAth: ath.c / last.c - 1,
    daysSinceTop: days(sinceTop),
    drawdown: last.c / latest.top.price - 1,
    low: latest.low,
    lowDepth: latest.low ? latest.low.price / latest.top.price - 1 : null,
    bounce: latest.low ? last.c / latest.low.price - 1 : null,
    priorBearDepths: episodes.filter((e) => e.lowConfirmed && e.low).map((e) => e.low!.price / e.top.price - 1),
    elapsed: gaps.length && !inRun ? sinceTop / quantile(gaps, 0.5) : null,
  };

  return { ...base, status: inRun ? "in_run" : "between_runs", methods, onset, top, readiness };
}

/** Each cycle's path from its top, indexed to the top close, sampled every `step` days. */
export function cycleAnalogs(points: CyclePoint[], episodes: BullEpisode[], horizonDays = 1600, step = 7): CycleAnalog[] {
  const index = new Map(points.map((p, i) => [p.t, i]));
  return episodes.map((e, k) => {
    const next = episodes[k + 1];
    const from = index.get(e.top.t)!;
    const out: { d: number; r: number }[] = [];
    for (let i = from; i < points.length; i += step) {
      const d = days(points[i]!.t - e.top.t);
      if (d > horizonDays) break;
      out.push({ d, r: points[i]!.c / e.top.price });
    }
    // Always end on the latest bar for the live cycle.
    const tail = points[points.length - 1]!;
    if (!next && out[out.length - 1]?.d !== days(tail.t - e.top.t)) out.push({ d: days(tail.t - e.top.t), r: tail.c / e.top.price });
    return {
      label: String(new Date(e.top.t).getUTCFullYear()),
      topT: e.top.t,
      topPrice: e.top.price,
      current: !next,
      onsetDay: next ? days(next.start - e.top.t) : null,
      breakoutDay: next ? days(next.breakout.t - e.top.t) : null,
      lowDay: e.low ? days(e.low.t - e.top.t) : null,
      points: out,
    };
  });
}
