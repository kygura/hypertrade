// Pure branch simulation engine — no I/O. See SPEC.md "Branch model".
import type { Allocation, BranchConfig } from "../../shared/types.js";

export interface DailyClose {
  ts: number; // ms epoch
  c: number;
  l?: number; // intraday low/high, only used for perp liquidation checks
  h?: number;
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
  return candleAt(ts, series)?.c ?? 0;
}

function candleAt(ts: number, series: DailyClose[] | undefined): DailyClose | undefined {
  if (!series || series.length === 0) return undefined;
  let ans = series[0]!;
  for (const c of series) {
    if (c.ts > ts) break;
    ans = c;
  }
  return ans;
}

// ponytail: perp legs are a deliberately thin model — no maintenance margin
// (liquidation only at 100% margin loss), no funding payments, no fees or
// slippage, and liquidation is checked on daily low/high (or close) only, not
// intraday paths. Add these if the simulated paths are ever traded on.
interface PerpLeg {
  margin: number;
  entryPx: number;
  sign: 1 | -1; // +1 long, -1 short
  lev: number;
}

const isPerp = (a: Allocation) => a.side === "short" || (a.leverage ?? 1) > 1;

/** margin + pnl; can go negative (the leg is then liquidated / floored at 0). */
function legEquity(leg: PerpLeg, px: number): number {
  return leg.margin + leg.sign * leg.margin * leg.lev * (px / leg.entryPx - 1);
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
 * grid, applying `rebalance` and `dca`. Reused for both the branch's own
 * allocations and single-asset benchmark curves (weight 100%, rebalance "none").
 */
function runPortfolio(
  allocations: Allocation[],
  rebalance: BranchConfig["rebalance"],
  initialCapitalUsd: number,
  grid: number[],
  candlesByCoin: Record<string, DailyClose[]>,
  dca: NonNullable<BranchConfig["dca"]> = [],
): EquityPoint[] {
  if (grid.length === 0) return [];
  const price = (coin: string, ts: number) => priceAt(coin, ts, candlesByCoin[coin]);
  const t0 = grid[0]!;

  // qty[coin] in units of the asset for spot legs; USD is tracked as a "coin" priced at 1.
  const qty = new Map(
    allocations.filter((a) => !isPerp(a)).map((a) => [a.coin, ((a.weightPct / 100) * initialCapitalUsd) / price(a.coin, t0)]),
  );
  // Perp leg state, parallel to `allocations` (null = spot leg).
  const legs: (PerpLeg | null)[] = allocations.map((a) =>
    isPerp(a)
      ? { margin: (a.weightPct / 100) * initialCapitalUsd, entryPx: price(a.coin, t0), sign: a.side === "short" ? -1 : 1, lev: a.leverage ?? 1 }
      : null,
  );
  // DCA targets not already held as spot: held as spot from their first buy.
  const dcaOnly = [...new Set(dca.map((d) => d.coin))].filter((c) => !qty.has(c));
  for (const c of dcaOnly) qty.set(c, 0);

  const holding = (i: number, ts: number) => {
    const leg = legs[i], coin = allocations[i]!.coin;
    return leg ? Math.max(0, legEquity(leg, price(coin, ts))) : qty.get(coin)! * price(coin, ts);
  };

  const equity: EquityPoint[] = [];
  let prevTs = t0;
  for (const ts of grid) {
    // Liquidation on the day's adverse extreme (low for longs, high for
    // shorts) when the candle has it, else the close. Skipped on day 0: the
    // legs enter at that day's close, after its low/high happened. A zeroed
    // margin keeps the leg at 0 until a rebalance re-funds it.
    if (ts !== t0) {
      legs.forEach((leg, i) => {
        if (!leg) return;
        const c = candleAt(ts, candlesByCoin[allocations[i]!.coin]);
        const extreme = c && c.ts === ts ? (leg.sign > 0 ? c.l : c.h) : undefined;
        if (legEquity(leg, extreme ?? price(allocations[i]!.coin, ts)) <= 0) leg.margin = 0;
      });
    }

    let value = 0;
    for (let i = 0; i < allocations.length; i++) value += holding(i, ts);
    for (const c of dcaOnly) value += qty.get(c)! * price(c, ts);

    const drifted = shouldRebalance(rebalance, prevTs, ts);
    const thresholdBreached =
      rebalance === "threshold5pct" &&
      allocations.some((a, i) => Math.abs(holding(i, ts) / value - a.weightPct / 100) > 0.05);

    if (drifted || thresholdBreached) {
      // Perp legs realize their PnL into the total and re-enter at today's price.
      allocations.forEach((a, i) => {
        const leg = legs[i];
        if (leg) {
          leg.margin = (a.weightPct / 100) * value;
          leg.entryPx = price(a.coin, ts);
        } else qty.set(a.coin, ((a.weightPct / 100) * value) / price(a.coin, ts));
      });
    }

    // Self-financing DCA: on each period boundary move amountUsd from the
    // stable sleeve (USDC, then USDT) into spot at today's close; a short
    // sleeve buys what is left, an empty one buys nothing. The first buy is on
    // the first boundary *after* the start (day 0 is never a boundary, same as
    // rebalancing), so "weekly since Jan" doesn't double-buy on day 0.
    for (const d of dca) {
      if (!shouldRebalance(d.every, prevTs, ts)) continue;
      let spent = 0;
      for (const s of ["USDC", "USDT"]) {
        const take = Math.min(d.amountUsd - spent, qty.get(s) ?? 0);
        if (take <= 0) continue;
        qty.set(s, qty.get(s)! - take);
        spent += take;
      }
      qty.set(d.coin, qty.get(d.coin)! + spent / price(d.coin, ts));
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
  for (const coin of [...config.allocations.map((a) => a.coin), ...(config.dca ?? []).map((d) => d.coin)]) {
    if (STABLES.has(coin)) continue;
    if (!candlesByCoin[coin] || candlesByCoin[coin]!.length === 0) throw new NoPriceDataError(coin);
  }

  const startMs = Date.parse(config.startDate);
  const grid = buildGrid(candlesByCoin, startMs);

  const equity = runPortfolio(config.allocations, config.rebalance, config.initialCapitalUsd, grid, candlesByCoin, config.dca);
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
