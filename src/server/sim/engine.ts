// Pure branch simulation engine — no I/O. See SPEC.md "Branch model".
import type { BranchConfig } from "../../shared/types.js";

export interface DailyClose {
  ts: number; // ms epoch
  c: number;
}

export interface EquityPoint {
  ts: number;
  value: number;
}

export interface BranchStats {
  finalValue: number;
  cagrPct: number;
  maxDrawdownPct: number;
  vsBtcPct: number;
  vsUsdcPct: number;
}

export interface BranchResult {
  equity: EquityPoint[];
  benchmarks: { btc: EquityPoint[]; usdc: EquityPoint[] };
  stats: BranchStats;
}

const STABLES = new Set(["USDC", "USDT"]);
const DAY_MS = 86400000;

/** Thrown by simulate() when an allocation coin has no candle data at all —
 * priceAt() would fall back to 0 for it, and dividing initial capital by that
 * 0 poisons the whole equity curve with Infinity/NaN. Fail fast instead. */
export class NoPriceDataError extends Error {
  constructor(public readonly coin: string) {
    super(`no price data for ${coin}`);
    this.name = "NoPriceDataError";
  }
}

/**
 * Price of `coin` at-or-before `ts`, carrying the last known close forward
 * over gaps. Stablecoins are a constant $1 and need no candle data at all.
 * Before the first available candle, falls back to that first close (flat
 * backward extrapolation) rather than failing the whole simulation.
 */
function priceAt(coin: string, ts: number, series: DailyClose[] | undefined): number {
  if (STABLES.has(coin)) return 1;
  if (!series || series.length === 0) return 0;
  let ans = series[0]!;
  for (const c of series) {
    if (c.ts > ts) break;
    ans = c;
  }
  return ans.c;
}

/** Builds the daily grid the simulation runs on: BTC's own candle timestamps
 * (BTC is always fetched for the benchmark) filtered to >= startDate. */
function buildGrid(candlesByCoin: Record<string, DailyClose[]>, startMs: number): number[] {
  const btc = candlesByCoin.BTC ?? [];
  return btc.map((c) => c.ts).filter((ts) => ts >= startMs);
}

function shouldRebalance(mode: BranchConfig["rebalance"], prevTs: number, ts: number): boolean {
  if (mode === "monthly") {
    const a = new Date(prevTs), b = new Date(ts);
    return a.getUTCFullYear() !== b.getUTCFullYear() || a.getUTCMonth() !== b.getUTCMonth();
  }
  if (mode === "weekly") {
    // Epoch-anchored weeks (bucket = floor(ts / 7 days)), not ISO/calendar
    // weeks: the Unix epoch (1970-01-01) was a Thursday, so the boundary
    // falls on every Thursday 00:00 UTC rather than Monday. Documented
    // behavior, not "fixed" — matches the grid's UTC daily buckets and is
    // stable/deterministic, just not calendar-week-anchored.
    return Math.floor(prevTs / (7 * DAY_MS)) !== Math.floor(ts / (7 * DAY_MS));
  }
  return false; // "none" and "threshold5pct" are handled by their own triggers
}

/**
 * Runs one portfolio (a set of weighted coin allocations) forward over the
 * grid, applying `rebalance`. Reused for both the branch's own allocations
 * and single-asset benchmark curves (weight 100%, rebalance "none").
 */
function runPortfolio(
  allocations: { coin: string; weightPct: number }[],
  rebalance: BranchConfig["rebalance"],
  initialCapitalUsd: number,
  grid: number[],
  candlesByCoin: Record<string, DailyClose[]>,
): EquityPoint[] {
  if (grid.length === 0) return [];
  const price = (coin: string, ts: number) => priceAt(coin, ts, candlesByCoin[coin]);

  // qty[coin] in units of the asset; USD is tracked as a "coin" priced at 1.
  const qty = new Map(
    allocations.map((a) => [a.coin, ((a.weightPct / 100) * initialCapitalUsd) / price(a.coin, grid[0]!)]),
  );

  const equity: EquityPoint[] = [];
  let prevTs = grid[0]!;
  for (const ts of grid) {
    let value = 0;
    for (const a of allocations) value += qty.get(a.coin)! * price(a.coin, ts);

    const drifted = shouldRebalance(rebalance, prevTs, ts);
    const thresholdBreached =
      rebalance === "threshold5pct" &&
      allocations.some((a) => Math.abs((qty.get(a.coin)! * price(a.coin, ts)) / value - a.weightPct / 100) > 0.05);

    if (drifted || thresholdBreached) {
      for (const a of allocations) qty.set(a.coin, ((a.weightPct / 100) * value) / price(a.coin, ts));
    }

    equity.push({ ts, value });
    prevTs = ts;
  }
  return equity;
}

function maxDrawdownPct(equity: EquityPoint[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const p of equity) {
    if (p.value > peak) peak = p.value;
    if (peak > 0) worst = Math.max(worst, (peak - p.value) / peak);
  }
  return worst * 100;
}

function cagrPct(initial: number, final: number, firstTs: number, lastTs: number): number {
  const days = (lastTs - firstTs) / DAY_MS;
  if (days <= 0 || initial <= 0) return 0;
  return ((final / initial) ** (365 / days) - 1) * 100;
}

export function simulate(config: BranchConfig, candlesByCoin: Record<string, DailyClose[]>): BranchResult {
  for (const a of config.allocations) {
    if (STABLES.has(a.coin)) continue;
    if (!candlesByCoin[a.coin] || candlesByCoin[a.coin]!.length === 0) throw new NoPriceDataError(a.coin);
  }

  const startMs = Date.parse(config.startDate);
  const grid = buildGrid(candlesByCoin, startMs);

  const equity = runPortfolio(config.allocations, config.rebalance, config.initialCapitalUsd, grid, candlesByCoin);
  const btc = runPortfolio([{ coin: "BTC", weightPct: 100 }], "none", config.initialCapitalUsd, grid, candlesByCoin);
  const usdc = runPortfolio([{ coin: "USDC", weightPct: 100 }], "none", config.initialCapitalUsd, grid, candlesByCoin);

  const finalValue = equity.at(-1)?.value ?? config.initialCapitalUsd;
  const btcFinal = btc.at(-1)?.value ?? config.initialCapitalUsd;
  const usdcFinal = usdc.at(-1)?.value ?? config.initialCapitalUsd;

  return {
    equity,
    benchmarks: { btc, usdc },
    stats: {
      finalValue,
      cagrPct: grid.length > 1 ? cagrPct(config.initialCapitalUsd, finalValue, grid[0]!, grid.at(-1)!) : 0,
      maxDrawdownPct: maxDrawdownPct(equity),
      vsBtcPct: btcFinal > 0 ? (finalValue / btcFinal - 1) * 100 : 0,
      vsUsdcPct: usdcFinal > 0 ? (finalValue / usdcFinal - 1) * 100 : 0,
    },
  };
}
