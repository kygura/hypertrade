// Pure forward Monte Carlo projection — no I/O. See SPEC.md "Branch model".
import type { BranchConfig } from "../../shared/types.js";
import type { EquityPoint } from "./engine.js";

export interface MonteCarloResult {
  median: EquityPoint[];
  p10: EquityPoint[];
  p90: EquityPoint[];
}

const DAY_MS = 86400000;
const MAX_PATHS = 500;

/** mulberry32 seeded PRNG — deterministic, ~10 lines, no dependency. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller standard normal sample from a uniform(0,1) generator. */
function nextGaussian(rand: () => number): number {
  const u1 = Math.max(rand(), Number.EPSILON);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx]!;
}

/**
 * GBM Monte Carlo, run at the *portfolio* level: per-coin {return, vol}
 * assumptions are weight-blended into one synthetic asset (return: weighted
 * sum; vol: weighted sum-of-squares, i.e. assuming zero cross-asset
 * correlation) rather than simulating each coin's path and re-applying the
 * branch's rebalance rule every step.
 * ponytail: documented simplification — real per-coin paths + rebalance if
 * scenario accuracy across correlated assets ever matters.
 */
export function runMonteCarlo(
  scenario: NonNullable<BranchConfig["scenario"]>,
  allocations: BranchConfig["allocations"],
  initialValueUsd: number,
  startTs: number,
  seed = 1,
): MonteCarloResult {
  const byCoin = new Map(scenario.assumptions.map((a) => [a.coin, a]));
  let annualReturnPct = 0;
  let varianceSum = 0;
  for (const a of allocations) {
    const w = a.weightPct / 100;
    const assumption = byCoin.get(a.coin);
    if (!assumption) continue; // stablecoins / unmodeled coins contribute 0 return & vol
    annualReturnPct += w * assumption.annualReturnPct;
    varianceSum += (w * assumption.annualVolPct) ** 2;
  }
  const mu = annualReturnPct / 100;
  const sigma = Math.sqrt(varianceSum) / 100;
  const dt = 1 / 365;
  const paths = Math.min(scenario.paths, MAX_PATHS);
  const rand = mulberry32(seed);

  // values[day][path]
  const values: number[][] = [Array(paths).fill(initialValueUsd)];
  for (let d = 1; d <= scenario.horizonDays; d++) {
    const prev = values[d - 1]!;
    const day = new Array<number>(paths);
    for (let p = 0; p < paths; p++) {
      const z = nextGaussian(rand);
      day[p] = prev[p]! * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z);
    }
    values.push(day);
  }

  const median: EquityPoint[] = [];
  const p10: EquityPoint[] = [];
  const p90: EquityPoint[] = [];
  for (let d = 0; d <= scenario.horizonDays; d++) {
    const ts = startTs + d * DAY_MS;
    const sorted = [...values[d]!].sort((a, b) => a - b);
    median.push({ ts, value: percentile(sorted, 0.5) });
    p10.push({ ts, value: percentile(sorted, 0.1) });
    p90.push({ ts, value: percentile(sorted, 0.9) });
  }
  return { median, p10, p90 };
}
