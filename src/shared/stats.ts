import type { Observation } from "./types";

/**
 * Directional percent change: the denominator uses |past| so that an
 * increase is always a positive percentage even when the base is negative.
 * This is intentional — consumers vote on direction, not sign-relative change.
 */
export function pctChange(current: number, past: number): number | null {
  if (past === 0) return null;
  return ((current - past) / Math.abs(past)) * 100;
}

export function sma(values: number[], window: number): number | null {
  if (values.length < window) return null;
  const tail = values.slice(-window);
  return tail.reduce((a, b) => a + b, 0) / window;
}

export function zscore(value: number, sample: number[], minSample = 20): number | null {
  if (sample.length < minSample) return null;
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length;
  const std = Math.sqrt(variance);
  // use small epsilon to handle floating-point precision in near-constant data
  if (std < 1e-10) return null;
  return (value - mean) / std;
}

export function obsAtOrBefore(obs: Observation[], ts: number): Observation | null {
  // obs sorted ascending; binary search for the last observation with ts' <= ts
  let lo = 0, hi = obs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid]!.ts <= ts) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans === -1 ? null : obs[ans]!;
}

export function valueAtOrBefore(obs: Observation[], ts: number): number | null {
  return obsAtOrBefore(obs, ts)?.value ?? null;
}

export function rocSeries(obs: Observation[], lagSeconds: number): Observation[] {
  const out: Observation[] = [];
  for (const o of obs) {
    const past = valueAtOrBefore(obs, o.ts - lagSeconds);
    if (past === null) continue;
    const pct = pctChange(o.value, past);
    if (pct === null) continue;
    out.push({ ts: o.ts, value: pct });
  }
  return out;
}

export function rollingZ(obs: Observation[], windowSeconds: number, minSample = 20): Observation[] {
  const out: Observation[] = [];
  let start = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i]!;
    while (obs[start]!.ts < o.ts - windowSeconds) start++;
    const sample = obs.slice(start, i + 1).map((x) => x.value);
    const z = zscore(o.value, sample, minSample);
    if (z !== null) out.push({ ts: o.ts, value: z });
  }
  return out;
}

export function smaSeries(obs: Observation[], window: number): Observation[] {
  const out: Observation[] = [];
  for (let i = window - 1; i < obs.length; i++) {
    const slice = obs.slice(i - window + 1, i + 1).map((x) => x.value);
    out.push({ ts: obs[i]!.ts, value: slice.reduce((a, b) => a + b, 0) / window });
  }
  return out;
}

export function rollingSum(obs: Observation[], windowSeconds: number): Observation[] {
  const out: Observation[] = [];
  let start = 0, sum = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i]!;
    sum += o.value;
    while (obs[start]!.ts <= o.ts - windowSeconds) { sum -= obs[start]!.value; start++; }
    out.push({ ts: o.ts, value: sum });
  }
  return out;
}

/** Absolute change (not %) vs the value at-or-before `ts - lagSeconds`. */
export function deltaSeries(obs: Observation[], lagSeconds: number): Observation[] {
  const out: Observation[] = [];
  for (const o of obs) {
    const past = valueAtOrBefore(obs, o.ts - lagSeconds);
    if (past === null) continue;
    out.push({ ts: o.ts, value: o.value - past });
  }
  return out;
}

/** Running maximum (all-time-high), one point per input point. */
export function runningMaxSeries(obs: Observation[]): Observation[] {
  const out: Observation[] = [];
  let max = -Infinity;
  for (const o of obs) {
    if (o.value > max) max = o.value;
    out.push({ ts: o.ts, value: max });
  }
  return out;
}

/**
 * Rolling population stdev of daily log returns over the last `window` returns.
 * Emitted at each price point once `window` returns are available. Non-positive
 * prices are skipped (log undefined).
 */
export function logReturnStdevSeries(obs: Observation[], window: number): Observation[] {
  const rets: Observation[] = [];
  for (let i = 1; i < obs.length; i++) {
    const p0 = obs[i - 1]!.value, p1 = obs[i]!.value;
    if (p0 <= 0 || p1 <= 0) continue;
    rets.push({ ts: obs[i]!.ts, value: Math.log(p1 / p0) });
  }
  const out: Observation[] = [];
  for (let i = window - 1; i < rets.length; i++) {
    const sample = rets.slice(i - window + 1, i + 1).map((x) => x.value);
    const mean = sample.reduce((a, b) => a + b, 0) / window;
    const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / window;
    out.push({ ts: rets[i]!.ts, value: Math.sqrt(variance) });
  }
  return out;
}

/**
 * Percentile rank (0–100) of each value against its own trailing window:
 * fraction of window observations ≤ the current value, so the window max reads
 * 100. Emitted once at least `minSample` points sit in the window.
 * ponytail: O(n·w) rescan per point, fine at daily resolution.
 */
export function rollingPercentileSeries(
  obs: Observation[], windowSeconds: number, minSample = 2,
): Observation[] {
  const out: Observation[] = [];
  let start = 0;
  for (let i = 0; i < obs.length; i++) {
    const o = obs[i]!;
    while (obs[start]!.ts < o.ts - windowSeconds) start++;
    const n = i - start + 1;
    if (n < minSample) continue;
    let leq = 0;
    for (let j = start; j <= i; j++) if (obs[j]!.value <= o.value) leq++;
    out.push({ ts: o.ts, value: (leq / n) * 100 });
  }
  return out;
}
