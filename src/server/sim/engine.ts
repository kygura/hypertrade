// Pure branch simulation engine — no I/O. See docs/SPEC.md "Branch model".
import type { Allocation, BranchConfig } from "../../shared/types.js";
import { isPerp, STABLES } from "../../shared/schemas.js";

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

interface BranchStats {
  finalValue: number;
  cagrPct: number;
  maxDrawdownPct: number;
  vsBtcPct: number;
  vsUsdcPct: number;
  /** Time-weighted return: growth with external cash flows taken out. */
  twrPct: number;
  /** Annualized (365 d) volatility of daily time-weighted returns. */
  volPct: number;
  /** Annualized mean / stdev of daily returns, zero risk-free rate. */
  sharpe: number;
  sortino: number;
  /** CAGR / max drawdown; 0 when there was no drawdown. */
  calmar: number;
  /** Longest stretch below a previous high, in days (open at the end counts). */
  longestDrawdownDays: number;
  feesUsd: number;
  /** Funding paid by perp legs (negative = received). */
  fundingUsd: number;
  /** External cash in minus cash out over the run. */
  netFlowUsd: number;
}

export interface MonthlyReturn {
  month: string; // YYYY-MM
  returnPct: number;
}

/** The same strategy started on many past dates and held for windowDays each. */
export interface RollingResult {
  windowDays: number;
  stepDays: number;
  points: { ts: number; returnPct: number; vsBtcPct: number; maxDrawdownPct: number }[];
  summary: {
    n: number;
    positivePct: number;
    beatBtcPct: number;
    p10: number;
    median: number;
    p90: number;
    worst: number;
    best: number;
  };
}

export interface BranchResult {
  equity: EquityPoint[];
  benchmarks: { btc: EquityPoint[]; usdc: EquityPoint[] };
  stats: BranchStats;
  /** Growth of the starting capital with cash flows taken out; only present with a cashflow. */
  twr?: EquityPoint[];
  monthly: MonthlyReturn[];
  rolling?: RollingResult;
}

const DAY_MS = 86400000;

/** Thrown by simulate() when an allocation coin has no candle data at all —
 * priceAt() would fall back to 0 for it, and dividing initial capital by that
 * 0 poisons the whole equity curve with Infinity/NaN. Fail fast instead. */
export class NoPriceDataError extends Error {
  constructor(public readonly coin: string, message = `no price data for ${coin}`) {
    super(message);
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
  // Last candle at or before ts (series ascending by ts); the first one when ts precedes them all.
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.ts > ts) hi = mid;
    else lo = mid + 1;
  }
  return series[Math.max(0, lo - 1)]!;
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

/** True when ts starts a new weekly/monthly bucket after prevTs. Shared by rebalancing, DCA,
 * cash flows and the forward projection's cash flows. */
export function shouldRebalance(mode: BranchConfig["rebalance"], prevTs: number, ts: number): boolean {
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

interface RunOptions {
  costs?: BranchConfig["costs"];
  cashflow?: BranchConfig["cashflow"];
}

interface PortfolioRun {
  equity: EquityPoint[];
  /** Time-weighted unit index: 1 at the start (less the entry fee), cash flows taken out. */
  index: number[];
  feesUsd: number;
  fundingUsd: number;
  netFlowUsd: number;
}

/**
 * Runs one portfolio (a set of weighted coin allocations) forward over the
 * grid, applying `rebalance`, `dca`, costs and external cash flows. Reused for
 * the branch's own allocations and single-asset benchmark curves (weight 100%,
 * rebalance "none"). With no costs and no cashflow the arithmetic is exactly
 * the cost-free engine's.
 */
function runPortfolio(
  allocations: Allocation[],
  rebalance: BranchConfig["rebalance"],
  initialCapitalUsd: number,
  grid: number[],
  candlesByCoin: Record<string, DailyClose[]>,
  dca: NonNullable<BranchConfig["dca"]> = [],
  opts: RunOptions = {},
): PortfolioRun {
  const out: PortfolioRun = { equity: [], index: [], feesUsd: 0, fundingUsd: 0, netFlowUsd: 0 };
  if (grid.length === 0) return out;
  const price = (coin: string, ts: number) => priceAt(coin, ts, candlesByCoin[coin]);
  const t0 = grid[0]!;
  const feeRate = (opts.costs?.feeBps ?? 0) / 10000;
  const fundingPerDay = (opts.costs?.fundingAprPct ?? 0) / 100 / 365;
  const cashflow = opts.cashflow;
  // Traded notional per $ of capital put to work at the target weights (stables are cash, not a trade).
  const exposure = allocations.reduce((s, a) => s + (STABLES.has(a.coin) ? 0 : (a.weightPct / 100) * (a.leverage ?? 1)), 0);

  const entryFee = feeRate > 0 ? feeRate * exposure * initialCapitalUsd : 0;
  const capital = initialCapitalUsd - entryFee;
  out.feesUsd += entryFee;

  // qty[coin] in units of the asset for spot legs; USD is tracked as a "coin" priced at 1.
  const qty = new Map(
    allocations.filter((a) => !isPerp(a)).map((a) => [a.coin, ((a.weightPct / 100) * capital) / price(a.coin, t0)]),
  );
  // Perp leg state, parallel to `allocations` (null = spot leg).
  const legs: (PerpLeg | null)[] = allocations.map((a) =>
    isPerp(a)
      ? { margin: (a.weightPct / 100) * capital, entryPx: price(a.coin, t0), sign: a.side === "short" ? -1 : 1, lev: a.leverage ?? 1 }
      : null,
  );
  // DCA targets not already held as spot: held as spot from their first buy.
  const dcaOnly = [...new Set(dca.map((d) => d.coin))].filter((c) => !qty.has(c));
  for (const c of dcaOnly) qty.set(c, 0);

  const holding = (i: number, ts: number) => {
    const leg = legs[i], coin = allocations[i]!.coin;
    return leg ? Math.max(0, legEquity(leg, price(coin, ts))) : qty.get(coin)! * price(coin, ts);
  };
  // Current notional of a leg (what a trade back to target is measured against).
  const notional = (i: number, ts: number) => {
    const leg = legs[i], coin = allocations[i]!.coin;
    if (STABLES.has(coin)) return 0;
    if (!leg) return qty.get(coin)! * price(coin, ts);
    return legEquity(leg, price(coin, ts)) > 0 ? leg.margin * leg.lev * (price(coin, ts) / leg.entryPx) : 0;
  };

  let prevTs = t0;
  let prevValue = 0;
  for (const ts of grid) {
    if (ts !== t0) {
      // Funding accrues on the open notional for the days since the last grid point; it comes out of margin.
      if (fundingPerDay !== 0) {
        const days = (ts - prevTs) / DAY_MS;
        legs.forEach((leg, i) => {
          if (!leg || leg.margin <= 0) return;
          const cost = leg.sign * notional(i, ts) * fundingPerDay * days;
          leg.margin -= cost;
          out.fundingUsd += cost;
        });
      }
      // Liquidation on the day's adverse extreme (low for longs, high for
      // shorts) when the candle has it, else the close. Skipped on day 0: the
      // legs enter at that day's close, after its low/high happened. A zeroed
      // margin keeps the leg at 0 until a rebalance re-funds it.
      legs.forEach((leg, i) => {
        if (!leg) return;
        const c = candleAt(ts, candlesByCoin[allocations[i]!.coin]);
        const extreme = c && c.ts === ts ? (leg.sign > 0 ? c.l : c.h) : undefined;
        if (legEquity(leg, extreme ?? price(allocations[i]!.coin, ts)) <= 0) leg.margin = 0;
      });
    }

    let value = 0;
    for (let i = 0; i < allocations.length; i++) value += holding(i, ts);
    // Coins held only via DCA sit outside the weighted allocations: a rebalance leaves them alone.
    let dcaValue = 0;
    for (const c of dcaOnly) dcaValue += qty.get(c)! * price(c, ts);
    const base = value;
    value += dcaValue;

    const drifted = shouldRebalance(rebalance, prevTs, ts);
    const thresholdBreached =
      rebalance === "threshold5pct" &&
      allocations.some((a, i) => Math.abs(holding(i, ts) / base - a.weightPct / 100) > 0.05);

    if (drifted || thresholdBreached) {
      // Fee on the notional actually traded back to target, then the targets are set on what is left.
      let target = base;
      if (feeRate > 0) {
        let turnover = 0;
        allocations.forEach((a, i) => {
          if (!STABLES.has(a.coin)) turnover += Math.abs((a.weightPct / 100) * base * (a.leverage ?? 1) - notional(i, ts));
        });
        const fee = Math.min(base, feeRate * turnover);
        target = base - fee;
        value -= fee;
        out.feesUsd += fee;
      }
      // Perp legs realize their PnL into the total and re-enter at today's price.
      allocations.forEach((a, i) => {
        const leg = legs[i];
        if (leg) {
          leg.margin = (a.weightPct / 100) * target;
          leg.entryPx = price(a.coin, ts);
        } else qty.set(a.coin, ((a.weightPct / 100) * target) / price(a.coin, ts));
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
      for (const s of STABLES) {
        const take = Math.min(d.amountUsd - spent, qty.get(s) ?? 0);
        if (take <= 0) continue;
        qty.set(s, qty.get(s)! - take);
        spent += take;
      }
      const fee = feeRate * spent;
      if (fee > 0) {
        value -= fee;
        out.feesUsd += fee;
      }
      qty.set(d.coin, qty.get(d.coin)! + (spent - fee) / price(d.coin, ts));
    }

    // External cash: a contribution is invested at the target weights (perp legs realize and re-enter,
    // like a rebalance); a withdrawal sells the same fraction of every holding. Fees come out of the flow.
    let flow = 0;
    if (cashflow && shouldRebalance(cashflow.every, prevTs, ts)) {
      if (cashflow.amountUsd > 0) {
        const fee = feeRate * exposure * cashflow.amountUsd;
        const net = cashflow.amountUsd - fee;
        allocations.forEach((a, i) => {
          const leg = legs[i];
          const add = (a.weightPct / 100) * net;
          if (leg) {
            const px = price(a.coin, ts);
            leg.margin = Math.max(0, legEquity(leg, px)) + add;
            leg.entryPx = px;
          } else qty.set(a.coin, qty.get(a.coin)! + add / price(a.coin, ts));
        });
        flow = cashflow.amountUsd;
        value += net;
        out.feesUsd += fee;
      } else if (value > 0) {
        const gross = Math.min(-cashflow.amountUsd, value);
        const f = gross / value;
        let sold = 0;
        allocations.forEach((_, i) => (sold += notional(i, ts) * f));
        for (const c of dcaOnly) sold += qty.get(c)! * price(c, ts) * f;
        const fee = Math.min(gross, feeRate * sold);
        for (const [c, q] of qty) qty.set(c, q * (1 - f));
        for (const leg of legs) if (leg) leg.margin *= 1 - f;
        flow = -(gross - fee);
        value -= gross;
        out.feesUsd += fee;
      }
      out.netFlowUsd += flow;
    }

    out.equity.push({ ts, value });
    const prevIndex = out.index.at(-1);
    out.index.push(
      prevIndex === undefined ? capital / initialCapitalUsd : prevValue > 0 ? prevIndex * ((value - flow) / prevValue) : prevIndex,
    );
    prevValue = value;
    prevTs = ts;
  }
  return out;
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

/** Simple returns between consecutive index points. */
export function indexReturns(index: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < index.length; i++) out.push(index[i - 1]! > 0 ? index[i]! / index[i - 1]! - 1 : 0);
  return out;
}

/** Annualized vol, Sharpe and Sortino of daily returns (365-day year, zero risk-free rate). */
export function riskStats(returns: number[]): { volPct: number; sharpe: number; sortino: number } {
  const n = returns.length;
  if (n < 2) return { volPct: 0, sharpe: 0, sortino: 0 };
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  const down = Math.sqrt(returns.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / n);
  const ann = Math.sqrt(365);
  return { volPct: sd * ann * 100, sharpe: sd > 0 ? (mean / sd) * ann : 0, sortino: down > 0 ? (mean / down) * ann : 0 };
}

/** Longest run, in days, from a high until the value first gets back to it (or the end). */
export function longestDrawdownDays(points: EquityPoint[]): number {
  let peak = -Infinity;
  let peakTs = points[0]?.ts ?? 0;
  let longest = 0;
  for (const p of points) {
    if (p.value >= peak) {
      peak = p.value;
      peakTs = p.ts;
    } else longest = Math.max(longest, (p.ts - peakTs) / DAY_MS);
  }
  return Math.round(longest);
}

/** Calendar-month returns (UTC) of a value index; the first month runs from the first point. */
export function monthlyReturns(points: EquityPoint[]): MonthlyReturn[] {
  const out: MonthlyReturn[] = [];
  let open = points[0]?.value;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const month = new Date(p.ts).toISOString().slice(0, 7);
    const next = points[i + 1];
    if (next && new Date(next.ts).toISOString().slice(0, 7) === month) continue;
    out.push({ month, returnPct: open && open > 0 ? (p.value / open - 1) * 100 : 0 });
    open = p.value;
  }
  return out;
}

function quantile(sorted: number[], p: number): number {
  return sorted[Math.floor(p * (sorted.length - 1))]!;
}

/** Window length when the config does not set one: the longest of 365/90/30 days that fits twice in the history. */
export function defaultRollingWindow(spanDays: number): number {
  return [365, 90, 30].find((w) => spanDays >= 2 * w) ?? 0;
}

const MAX_ROLLING_STARTS = 260;

/**
 * Re-runs the strategy from every stepDays-th day of the grid, each held windowDays, and reports
 * the time-weighted return of each start against holding BTC over the same window. Windows overlap,
 * so the starts are not independent samples.
 */
function rollingWindows(config: BranchConfig, candlesByCoin: Record<string, DailyClose[]>, grid: number[], windowDays: number): RollingResult | undefined {
  if (windowDays <= 0 || grid.length < 2) return undefined;
  const last = grid.at(-1)!;
  const window = windowDays * DAY_MS;
  const starts = grid.filter((ts) => ts + window <= last);
  if (starts.length < 2) return undefined;
  const step = Math.max(7, Math.ceil(starts.length / MAX_ROLLING_STARTS));
  const btc = (ts: number) => priceAt("BTC", ts, candlesByCoin.BTC);
  const points: RollingResult["points"] = [];
  let end = 0;
  for (let i = 0; i < starts.length; i += step) {
    const from = starts[i]!;
    while (end + 1 < grid.length && grid[end + 1]! <= from + window) end++;
    const slice = grid.slice(i, end + 1); // starts is a prefix of grid, so index i is `from`
    const run = runPortfolio(config.allocations, config.rebalance, config.initialCapitalUsd, slice, candlesByCoin, config.dca, config);
    const growth = run.index.at(-1)!;
    const btcGrowth = btc(slice.at(-1)!) / btc(from);
    const indexCurve = run.index.map((v, k) => ({ ts: slice[k]!, value: v }));
    points.push({
      ts: from,
      returnPct: (growth - 1) * 100,
      vsBtcPct: btcGrowth > 0 ? (growth / btcGrowth - 1) * 100 : 0,
      maxDrawdownPct: maxDrawdownPct(indexCurve),
    });
  }
  const sorted = points.map((p) => p.returnPct).sort((a, b) => a - b);
  const n = points.length;
  return {
    windowDays,
    stepDays: step,
    points,
    summary: {
      n,
      positivePct: (points.filter((p) => p.returnPct > 0).length / n) * 100,
      beatBtcPct: (points.filter((p) => p.vsBtcPct > 0).length / n) * 100,
      p10: quantile(sorted, 0.1),
      median: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      worst: sorted[0]!,
      best: sorted.at(-1)!,
    },
  };
}

export interface FullSimulation {
  result: BranchResult;
  /** Daily time-weighted returns of the branch: the history a bootstrap projection resamples. */
  dailyReturns: number[];
}

export function simulateFull(config: BranchConfig, candlesByCoin: Record<string, DailyClose[]>): FullSimulation {
  for (const coin of [...config.allocations.map((a) => a.coin), ...(config.dca ?? []).map((d) => d.coin)]) {
    if (STABLES.has(coin)) continue;
    if (!candlesByCoin[coin] || candlesByCoin[coin]!.length === 0) throw new NoPriceDataError(coin);
  }

  const startMs = Date.parse(config.startDate);
  const grid = buildGrid(candlesByCoin, startMs);
  if (grid.length === 0) throw new NoPriceDataError("BTC", "no price history in range");

  const cap = config.initialCapitalUsd;
  const opts: RunOptions = { costs: config.costs, cashflow: config.cashflow };
  // Benchmarks pay the same fees and get the same cash flows, so "vs BTC" compares like with like.
  const benchOpts: RunOptions = { costs: config.costs && { feeBps: config.costs.feeBps }, cashflow: config.cashflow };
  const run = runPortfolio(config.allocations, config.rebalance, cap, grid, candlesByCoin, config.dca, opts);
  const btc = runPortfolio([{ coin: "BTC", weightPct: 100 }], "none", cap, grid, candlesByCoin, [], benchOpts).equity;
  const usdc = runPortfolio([{ coin: "USDC", weightPct: 100 }], "none", cap, grid, candlesByCoin, [], benchOpts).equity;
  const equity = run.equity;

  const finalValue = equity.at(-1)?.value ?? cap;
  const btcFinal = btc.at(-1)?.value ?? cap;
  const usdcFinal = usdc.at(-1)?.value ?? cap;
  // With external cash the curve mixes performance and deposits: growth stats come from the time-weighted index.
  const twr = config.cashflow ? run.index.map((v, i) => ({ ts: grid[i]!, value: v * cap })) : undefined;
  const growth = twr ?? equity;
  const returns = indexReturns(run.index);
  const finalIndex = run.index.at(-1) ?? 1;
  const cagr =
    grid.length < 2 ? 0 : twr ? cagrPct(1, finalIndex, grid[0]!, grid.at(-1)!) : cagrPct(cap, finalValue, grid[0]!, grid.at(-1)!);
  const maxDd = maxDrawdownPct(growth);
  const spanDays = grid.length > 1 ? (grid.at(-1)! - grid[0]!) / DAY_MS : 0;

  const result: BranchResult = {
    equity,
    benchmarks: { btc, usdc },
    stats: {
      finalValue,
      cagrPct: cagr,
      maxDrawdownPct: maxDd,
      vsBtcPct: btcFinal > 0 ? (finalValue / btcFinal - 1) * 100 : 0,
      vsUsdcPct: usdcFinal > 0 ? (finalValue / usdcFinal - 1) * 100 : 0,
      twrPct: (finalIndex - 1) * 100,
      ...riskStats(returns),
      calmar: maxDd > 0 ? cagr / maxDd : 0,
      longestDrawdownDays: longestDrawdownDays(growth),
      feesUsd: run.feesUsd,
      fundingUsd: run.fundingUsd,
      netFlowUsd: run.netFlowUsd,
    },
    monthly: monthlyReturns(growth),
    ...(twr && { twr }),
  };
  const rolling = rollingWindows(config, candlesByCoin, grid, config.rollingWindowDays ?? defaultRollingWindow(spanDays));
  if (rolling) result.rolling = rolling;
  return { result, dailyReturns: returns };
}

export function simulate(config: BranchConfig, candlesByCoin: Record<string, DailyClose[]>): BranchResult {
  return simulateFull(config, candlesByCoin).result;
}
