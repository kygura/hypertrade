// Pure forward Monte Carlo projection — no I/O. See docs/SPEC.md "Branch model".
import type { BranchConfig } from "../../shared/types.js";
import { shouldRebalance, type EquityPoint } from "./engine.js";

export interface ProjectionSummary {
  method: "gbm" | "bootstrap";
  /** Value now plus every projected cash flow: what has been put in by the horizon. */
  investedUsd: number;
  finalP10: number;
  finalMedian: number;
  finalP90: number;
  /** Share of paths ending below investedUsd. */
  lossPct: number;
  /** Share of paths ending at or above the scenario's targetUsd (absent without a target). */
  targetPct?: number;
  /** Share of paths that ran out of money (only with withdrawals). */
  depletedPct?: number;
}

export interface MonteCarloResult {
  median: EquityPoint[];
  p10: EquityPoint[];
  p90: EquityPoint[];
  p25?: EquityPoint[];
  p75?: EquityPoint[];
  summary?: ProjectionSummary;
}

export interface MonteCarloOptions {
  /** Daily returns to resample when scenario.method is "bootstrap". */
  history?: number[];
  /** External cash continued past today on the same schedule (fees are not modelled forward). */
  cashflow?: BranchConfig["cashflow"];
}

/** Fewest historical daily returns a bootstrap projection accepts. */
export const MIN_BOOTSTRAP_DAYS = 60;

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
 * Forward Monte Carlo of the portfolio value, two ways:
 * - "gbm" (default): per-coin {return, vol} assumptions are weight-blended into one synthetic asset
 *   (return: weighted sum; vol: weighted sum-of-squares, i.e. zero cross-asset correlation) rather
 *   than simulating each coin's path and re-applying the rebalance rule every step.
 *   ponytail: documented simplification — real per-coin paths + rebalance if scenario accuracy
 *   across correlated assets ever matters.
 * - "bootstrap": each path strings together random blocks of `blockDays` consecutive daily returns
 *   from the branch's own simulated history, so fat tails, volatility clustering, perp legs, fees and
 *   funding carry over as they happened. It can only replay what the history contains.
 * A cashflow keeps adding (or withdrawing) on the same weekly/monthly boundaries; a path that hits 0
 * stays at 0.
 */
export function runMonteCarlo(
  scenario: NonNullable<BranchConfig["scenario"]>,
  allocations: BranchConfig["allocations"],
  initialValueUsd: number,
  startTs: number,
  seed = 1,
  opts: MonteCarloOptions = {},
): MonteCarloResult {
  const method = scenario.method ?? "gbm";
  const paths = Math.min(scenario.paths, MAX_PATHS);
  const rand = mulberry32(seed);
  const history = opts.history ?? [];
  if (method === "bootstrap" && history.length < MIN_BOOTSTRAP_DAYS) {
    throw new Error(`bootstrap needs at least ${MIN_BOOTSTRAP_DAYS} days of history, got ${history.length}`);
  }

  // One growth-factor generator per path, so a bootstrap block never straddles two paths.
  let newPath: () => () => number;
  if (method === "bootstrap") {
    const block = Math.min(scenario.blockDays ?? 10, history.length);
    newPath = () => {
      let pos = 0;
      let left = 0;
      return () => {
        if (left === 0) {
          pos = Math.floor(rand() * (history.length - block + 1));
          left = block;
        }
        left--;
        return 1 + history[pos++]!;
      };
    };
  } else {
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
    const gbm = () => Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * nextGaussian(rand));
    newPath = () => gbm;
  }

  // Cash flow per day index (same for every path).
  const flows = new Array<number>(scenario.horizonDays + 1).fill(0);
  if (opts.cashflow) {
    for (let d = 1; d <= scenario.horizonDays; d++) {
      if (shouldRebalance(opts.cashflow.every, startTs + (d - 1) * DAY_MS, startTs + d * DAY_MS)) flows[d] = opts.cashflow.amountUsd;
    }
  }
  const investedUsd = initialValueUsd + flows.reduce((s, f) => s + f, 0);

  // values[day][path]; paths are generated one at a time so a bootstrap block stays within one path.
  const values: number[][] = Array.from({ length: scenario.horizonDays + 1 }, () => new Array<number>(paths));
  let depleted = 0;
  for (let p = 0; p < paths; p++) {
    let v = initialValueUsd;
    let broke = false;
    values[0]![p] = v;
    const step = newPath();
    for (let d = 1; d <= scenario.horizonDays; d++) {
      v = Math.max(0, v * step() + flows[d]!);
      if (v === 0 && flows[d]! < 0) broke = true;
      values[d]![p] = v;
    }
    if (broke) depleted++;
  }

  const median: EquityPoint[] = [], p10: EquityPoint[] = [], p90: EquityPoint[] = [], p25: EquityPoint[] = [], p75: EquityPoint[] = [];
  for (let d = 0; d <= scenario.horizonDays; d++) {
    const ts = startTs + d * DAY_MS;
    const sorted = values[d]!.sort((a, b) => a - b);
    median.push({ ts, value: percentile(sorted, 0.5) });
    p10.push({ ts, value: percentile(sorted, 0.1) });
    p90.push({ ts, value: percentile(sorted, 0.9) });
    p25.push({ ts, value: percentile(sorted, 0.25) });
    p75.push({ ts, value: percentile(sorted, 0.75) });
  }
  const finals = values.at(-1)!;
  const share = (pred: (v: number) => boolean) => (finals.filter(pred).length / paths) * 100;
  return {
    median,
    p10,
    p90,
    p25,
    p75,
    summary: {
      method,
      investedUsd,
      finalP10: percentile(finals, 0.1),
      finalMedian: percentile(finals, 0.5),
      finalP90: percentile(finals, 0.9),
      lossPct: share((v) => v < investedUsd),
      ...(scenario.targetUsd !== undefined && { targetPct: share((v) => v >= scenario.targetUsd!) }),
      ...(opts.cashflow && opts.cashflow.amountUsd < 0 && { depletedPct: (depleted / paths) * 100 }),
    },
  };
}
