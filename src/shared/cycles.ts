// BTC cycle model: daily HTF phase engine, ported from hl-cycles
// (backend/src/model/htf.ts + indicators.ts, docs/MODEL.md §1). Pure
// functions only; the server runs it on stored 1d candles (routes/cycles.ts)
// and the next-bull-run estimate builds on its phases (cycleForecast.ts).

import type { CycleAnalog, CycleForecast } from "./cycleForecast.js";

export const DAY_MS = 86_400_000;

export type CyclePhase = "accumulation" | "expansion" | "euphoria" | "distribution" | "markdown" | "capitulation";

/** Lowest to highest heat; the order legends and colour tokens follow. */
export const CYCLE_PHASES: readonly CyclePhase[] = ["accumulation", "expansion", "euphoria", "distribution", "markdown", "capitulation"];

export interface DailyBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  src: string;
}

export type CyclePoint = DailyBar & {
  sma200: number | null;
  sma50: number | null;
  mayer: number | null;
  mayerPct: number | null;
  drawdown: number;
  sma200Slope30: number | null;
  roc30: number | null;
  roc365: number | null;
  rv30: number | null;
  daysSinceLow365: number;
  trend: number | null; // T in [-1, 1]
  heat: number | null; // H in [-1, 1]
  rawPhase: CyclePhase | null;
  phase: CyclePhase | null; // committed (hysteresis)
};

export const HALVINGS = [Date.UTC(2012, 10, 28), Date.UTC(2016, 6, 9), Date.UTC(2020, 4, 11), Date.UTC(2024, 3, 20)] as const;

/** Block-time estimate for the fifth halving; label it an estimate wherever it shows. */
export const NEXT_HALVING_ESTIMATE = Date.UTC(2028, 3, 15);

// ─── indicators ───

export function clamp(x: number, a = -1, b = 1): number {
  return Math.min(b, Math.max(a, x));
}

export function sma(c: number[], k: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    sum += c[i]!;
    if (i >= k) sum -= c[i - k]!;
    out.push(i >= k - 1 ? sum / k : null);
  }
  return out;
}

export function roc(c: number[], k: number): (number | null)[] {
  return c.map((x, i) => (i >= k ? x / c[i - k]! - 1 : null));
}

/** Sample stdev (n-1) of the trailing `window` log returns, annualized by sqrt(annFactor). */
export function realizedVol(c: number[], window: number, annFactor: number): (number | null)[] {
  const lr = c.map((x, i) => (i > 0 ? Math.log(x / c[i - 1]!) : 0));
  return c.map((_, i) => {
    if (i < window) return null;
    const w = lr.slice(i - window + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / window;
    const varSum = w.reduce((a, b) => a + (b - m) ** 2, 0);
    return Math.sqrt((varSum / (window - 1)) * annFactor);
  });
}

/**
 * Percentile rank of x[i] within the trailing window (itself included), over
 * non-null values; null when x[i] is null or the window holds fewer than `min`.
 */
export function percentileRank(x: (number | null)[], windowSize: number, min: number): (number | null)[] {
  return x.map((v, i) => {
    if (v == null) return null;
    let lt = 0;
    let eq = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - windowSize + 1); j <= i; j++) {
      const y = x[j];
      if (y == null) continue;
      cnt++;
      if (y < v) lt++;
      else if (y === v) eq++;
    }
    return cnt < min ? null : (lt + 0.5 * eq) / cnt;
  });
}

/**
 * Label hysteresis: the committed value switches once a candidate has run for
 * `needFor(candidate)` bars, or after `maxAway` bars away from it regardless.
 * null passes through (warm-up) without disturbing state.
 */
export function commitWithHysteresis<T extends string>(raw: (T | null)[], needFor: (candidate: T) => number, maxAway?: number): (T | null)[] {
  const committed: (T | null)[] = [];
  let cur: T | null = null;
  let cand: T | null = null;
  let run = 0;
  let away = 0;
  for (const r of raw) {
    if (r == null) {
      committed.push(null);
      continue;
    }
    if (cur == null) {
      cur = r;
      committed.push(cur);
      continue;
    }
    if (r === cur) {
      cand = null;
      run = 0;
      away = 0;
    } else {
      away++;
      if (r === cand) run++;
      else {
        cand = r;
        run = 1;
      }
      if (run >= needFor(r) || (maxAway != null && away >= maxAway)) {
        cur = r;
        cand = null;
        run = 0;
        away = 0;
      }
    }
    committed.push(cur);
  }
  return committed;
}

// ─── model ───

/** Floor to UTC day, keep the last bar per day, forward-fill missing days. */
export function fillGaps(bars: DailyBar[]): DailyBar[] {
  const out: DailyBar[] = [];
  for (const raw of [...bars].sort((a, b) => a.t - b.t)) {
    const cur = { ...raw, t: Math.floor(raw.t / DAY_MS) * DAY_MS };
    const prev = out[out.length - 1];
    if (prev && prev.t === cur.t) {
      out[out.length - 1] = cur;
      continue;
    }
    let p = prev;
    while (p && p.t + DAY_MS < cur.t) {
      p = { t: p.t + DAY_MS, o: p.c, h: p.c, l: p.c, c: p.c, v: 0, src: p.src };
      out.push(p);
    }
    out.push(cur);
  }
  return out;
}

function rawPhaseOf(p: {
  T: number | null;
  H: number | null;
  c: number;
  sma50: number | null;
  drawdown: number;
  roc30: number | null;
  daysSinceLow365: number;
}): CyclePhase | null {
  const { T, H, c, sma50, drawdown, roc30, daysSinceLow365 } = p;
  if (T == null || H == null) return null;
  if ((H <= -0.6 && daysSinceLow365 <= 30) || (roc30 != null && roc30 <= -0.3 && drawdown <= -0.5 && T < 0)) return "capitulation";
  if (H >= 0.75 && T >= 0.3) return "euphoria";
  if (H <= -0.35 && daysSinceLow365 > 30) return "accumulation";
  if (H >= 0.2 && sma50 != null && c < sma50 && T > -0.25) return "distribution";
  if (T >= 0.25) return "expansion";
  if (T <= -0.25) return "markdown";
  return H > 0 ? "distribution" : "accumulation";
}

/**
 * Daily cycle points over closed bars only (t + 1d <= now). Trend T blends
 * Mayer multiple, SMA200 slope and the 50/200 cross; heat H blends the
 * Mayer percentile (4y window), drawdown from ATH and 365d return.
 */
export function computeCycle(daily: DailyBar[], now: number): CyclePoint[] {
  const filled = fillGaps(daily.filter((x) => x.t + DAY_MS <= now));
  const c = filled.map((x) => x.c);

  const sma50 = sma(c, 50);
  const sma200 = sma(c, 200);
  const mayer = c.map((x, i) => (sma200[i] == null ? null : x / sma200[i]!));
  const mayerPct = percentileRank(mayer, 1460, 365);

  let ath = -Infinity;
  const drawdown = c.map((x) => {
    ath = Math.max(ath, x);
    return x / ath - 1;
  });

  const sma200Slope30 = sma200.map((v, i) => (i >= 30 && v != null && sma200[i - 30] != null ? v / sma200[i - 30]! - 1 : null));
  const roc30 = roc(c, 30);
  const roc365 = roc(c, 365);
  const rv30 = realizedVol(c, 30, 365);

  const daysSinceLow365 = c.map((_, i) => {
    let b = i;
    for (let j = Math.max(0, i - 364); j <= i; j++) if (c[j]! <= c[b]!) b = j;
    return i - b;
  });

  const T = c.map((_, i) => {
    const m = mayer[i];
    const s = sma200Slope30[i];
    const x = sma50[i] == null || sma200[i] == null ? null : sma50[i]! / sma200[i]!;
    if (m == null || s == null || x == null) return null;
    return 0.35 * Math.tanh(Math.log(m) / 0.15) + 0.35 * Math.tanh(s / 0.04) + 0.3 * Math.tanh(Math.log(x) / 0.1);
  });
  const H = c.map((_, i) => {
    const p = mayerPct[i];
    const r = roc365[i];
    if (p == null || r == null) return null;
    return 0.5 * (2 * p - 1) + 0.25 * clamp(1 + drawdown[i]! / 0.4) + 0.25 * Math.tanh(Math.log(1 + r));
  });

  const rawPhase = c.map((x, i) =>
    rawPhaseOf({ T: T[i]!, H: H[i]!, c: x, sma50: sma50[i]!, drawdown: drawdown[i]!, roc30: roc30[i]!, daysSinceLow365: daysSinceLow365[i]! }),
  );
  const phase = commitWithHysteresis(rawPhase, (r) => (r === "euphoria" || r === "capitulation" ? 5 : 14), 28);

  return filled.map((bar, i) => ({
    ...bar,
    sma200: sma200[i]!,
    sma50: sma50[i]!,
    mayer: mayer[i]!,
    mayerPct: mayerPct[i]!,
    drawdown: drawdown[i]!,
    sma200Slope30: sma200Slope30[i]!,
    roc30: roc30[i]!,
    roc365: roc365[i]!,
    rv30: rv30[i]!,
    daysSinceLow365: daysSinceLow365[i]!,
    trend: T[i]!,
    heat: H[i]!,
    rawPhase: rawPhase[i]!,
    phase: phase[i]!,
  }));
}

/** Monday 00:00 UTC of the week containing t. */
export function weekStart(t: number): number {
  const MON = 4 * DAY_MS; // 1970-01-05 was a Monday
  return Math.floor((t - MON) / (7 * DAY_MS)) * 7 * DAY_MS + MON;
}

/** Weekly bars from daily points; indicator fields copy the week's last day. */
export function resampleWeekly(points: CyclePoint[]): CyclePoint[] {
  const out: CyclePoint[] = [];
  let group: CyclePoint[] = [];
  const flush = () => {
    const last = group[group.length - 1];
    if (!last) return;
    out.push({
      ...last,
      t: weekStart(last.t),
      o: group[0]!.o,
      h: Math.max(...group.map((p) => p.h)),
      l: Math.min(...group.map((p) => p.l)),
      v: group.reduce((a, p) => a + p.v, 0),
    });
  };
  for (const p of points) {
    if (group.length && weekStart(p.t) !== weekStart(group[0]!.t)) {
      flush();
      group = [];
    }
    group.push(p);
  }
  flush();
  return out;
}

// ─── wire types (GET /api/cycles) ───

export interface CyclesResponse {
  asOf: number;
  tf: "1d" | "1w";
  bars: CycleBar[];
  halvings: number[];
  nextHalving: number;
  forecast: CycleForecast;
  analogs: CycleAnalog[];
  /** Bars per source venue, for the footer. */
  sources: Record<string, number>;
}


/** One chart bar of the cycle view; prices to 6 significant figures, scores to 3 decimals. */
export interface CycleBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  src: string;
  sma200: number | null;
  mayer: number | null;
  drawdown: number;
  trend: number | null;
  heat: number | null;
  phase: CyclePhase | null;
}

export function toCycleBar(p: CyclePoint): CycleBar {
  const px = (x: number) => Number(x.toPrecision(6));
  const r3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
  return {
    t: p.t,
    o: px(p.o),
    h: px(p.h),
    l: px(p.l),
    c: px(p.c),
    src: p.src,
    sma200: p.sma200 == null ? null : px(p.sma200),
    mayer: r3(p.mayer),
    drawdown: r3(p.drawdown)!,
    trend: r3(p.trend),
    heat: r3(p.heat),
    phase: p.phase,
  };
}
