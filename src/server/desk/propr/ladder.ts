import type { ProprVenueConfig } from "../config.js";
import { floorToDecimals } from "../governor.js";
import { roundPerpPx } from "../hl/wire.js";
import type { Confidence, RiskOrder, Sizing } from "../types.js";
import type { ProprSnapshot } from "./account.js";
import type { ProprOrderRequest } from "./client.js";
import { ladderId } from "./ids.js";

// Laddered entries and the Propr firm guards, pure. Ported from perp-radar's executor (ladderEdge, ladderPrices,
// planOrder, ladderRequests), with one change: the governor has already sized the order, so the ladder never exceeds
// the governor's risk or its notional. Spreading the same notional over better prices only lowers the risk.

export interface Rung {
  px: number;
  qty: number;
  market: boolean;
}

export interface LadderPlan {
  coin: string;
  side: "long" | "short";
  stop: number;
  target: number | null;
  rungs: Rung[];
  /** Total quantity and notional if every rung fills. */
  qty: number;
  notionalUsd: number;
  /** Loss if every rung fills and the stop is hit at its price. */
  riskUsd: number;
  avgEntry: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Far edge of the ladder: halfway from the entry to the stop, pulled back so the last rung keeps room before the stop. */
export function ladderEdge(side: "long" | "short", entry: number, stop: number, minStopGapShare: number): number {
  const dist = Math.abs(entry - stop);
  const gap = minStopGapShare * dist;
  const raw = (entry + stop) / 2;
  return side === "long" ? Math.min(entry, Math.max(raw, stop + gap)) : Math.max(entry, Math.min(raw, stop - gap));
}

/** Rung prices from the entry to the edge, evenly spaced, rounded to Hyperliquid's price rules. */
export function ladderPrices(entry: number, edge: number, n: number, szDecimals: number): number[] {
  if (n <= 1 || entry === edge) return [entry];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = i === 0 ? entry : roundPerpPx(entry + ((edge - entry) * i) / (n - 1), szDecimals);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export const rungsFor = (cfg: ProprVenueConfig["ladder"], coin: string) => cfg.rungsByCoin[coin] ?? cfg.rungs;

/** Propr's rulebook: up to 10x on BTC, ETH and SOL, 2x on other crypto perps. PROPR_LEVERAGE_BY_COIN overrides a coin. */
const MAJORS = new Set(["BTC", "ETH", "SOL"]);
type LeverageCfg = Pick<ProprVenueConfig, "maxLeverage" | "leverageByCoin" | "defaultLeverage" | "leverageByConfidence">;

export function coinMaxLeverage(cfg: Pick<ProprVenueConfig, "maxLeverage" | "leverageByCoin">, coin: string): number {
  return Math.max(1, Math.min(cfg.maxLeverage, cfg.leverageByCoin[coin] ?? (MAJORS.has(coin) ? 10 : 2)));
}

/**
 * The cross leverage a trade runs at, first that applies: the trade's own choice (the operator's, or the model's from
 * its conviction), the signal's confidence through PROPR_LEVERAGE_BY_CONFIDENCE, PROPR_DEFAULT_LEVERAGE. 1x is exposure
 * that is hard to liquidate; the coin's maximum is for a high-conviction trade. Whole and capped, with a warning when
 * capped. Null: nothing set, the venue uses the smallest leverage that carries the ladder.
 */
export function tradeLeverage(cfg: LeverageCfg, coin: string, chosen: number | undefined, confidence?: Confidence): { leverage: number | null; max: number; warning?: string } {
  const max = coinMaxLeverage(cfg, coin);
  if (chosen == null) {
    const fallback = (confidence ? cfg.leverageByConfidence[confidence] : undefined) ?? cfg.defaultLeverage;
    return fallback == null ? { leverage: null, max } : { leverage: Math.min(max, fallback), max };
  }
  const lev = Math.min(max, Math.max(1, Math.round(chosen)));
  if (chosen > max) return { leverage: lev, max, warning: `leverage ${chosen}x on ${coin} capped at Propr's ${max}x` };
  if (lev !== chosen) return { leverage: lev, max, warning: `leverage ${chosen}x rounded to ${lev}x (Propr takes whole numbers)` };
  return { leverage: lev, max };
}

/**
 * Splits a governor-sized order into equal-quantity rungs from the mark toward the stop. The quantity per rung is the
 * smaller of the governor's risk spread over the rungs' distances and its notional spread over their prices, floored
 * to the size step. Rungs drop until each clears the order minimum; a zone under 0.1% of price is one entry.
 */
export function planLadder(order: RiskOrder, sizing: Sizing, szDecimals: number, cfg: ProprVenueConfig["ladder"]): { plan?: LadderPlan; reasons: string[] } {
  const entry = sizing.markPx;
  const stop = roundPerpPx(order.stop, szDecimals);
  const target = order.target != null ? roundPerpPx(order.target, szDecimals) : null;
  const edge = ladderEdge(order.side, entry, stop, cfg.minStopGapShare);
  const zoneWide = Math.abs(entry - edge) >= entry * 0.001;

  let prices = [entry];
  let each = 0;
  for (let n = zoneWide ? rungsFor(cfg, order.coin) : 1; n >= 1; n--) {
    prices = ladderPrices(entry, edge, n, szDecimals);
    const sumDist = prices.reduce((s, p) => s + Math.abs(p - stop), 0);
    const sumPx = prices.reduce((s, p) => s + p, 0);
    each = floorToDecimals(Math.min(sizing.riskUsd / sumDist, sizing.notionalUsd / sumPx), szDecimals);
    if (prices.every((p) => each * p >= cfg.minRungUsd)) break;
  }
  if (!(each > 0) || prices.some((p) => each * p < cfg.minRungUsd)) {
    return { reasons: [`ladder rung of ${each} ${order.coin} is under the $${cfg.minRungUsd} order minimum`] };
  }
  const rungs = prices.map((px, i) => ({ px, qty: each, market: i === 0 && (cfg.firstAtMarket || prices.length === 1) }));
  const qty = floorToDecimals(each * prices.length, szDecimals);
  const notionalUsd = prices.reduce((s, p) => s + each * p, 0);
  const riskUsd = prices.reduce((s, p) => s + each * Math.abs(p - stop), 0);
  const avgEntry = prices.reduce((s, p) => s + p, 0) / prices.length;
  return { plan: { coin: order.coin, side: order.side, stop, target, rungs, qty, notionalUsd: r2(notionalUsd), riskUsd: r2(riskUsd), avgEntry: roundPerpPx(avgEntry, szDecimals) }, reasons: [] };
}

/**
 * A ladder of the operator's own rungs (a written plan), each a resting GTC limit at its price: sizes floored to the
 * size step, prices rounded to Hyperliquid's rules. Refused (reasons) when a rung rounds to zero or under the order
 * minimum. Nothing is moved or resized beyond that rounding.
 */
export function explicitLadder(order: RiskOrder, rungs: Array<{ px: number; size: number }>, szDecimals: number, cfg: ProprVenueConfig["ladder"]): { plan?: LadderPlan; reasons: string[] } {
  const stop = roundPerpPx(order.stop, szDecimals);
  const target = order.target != null ? roundPerpPx(order.target, szDecimals) : null;
  const out: Rung[] = rungs.map((r) => ({ px: roundPerpPx(r.px, szDecimals), qty: floorToDecimals(r.size, szDecimals), market: false }));
  const reasons = out.filter((r) => !(r.qty > 0) || r.qty * r.px < cfg.minRungUsd).map((r) => `rung ${r.qty} ${order.coin} @ ${r.px} is under the $${cfg.minRungUsd} order minimum`);
  if (reasons.length) return { reasons };
  const qty = out.reduce((a, r) => a + r.qty, 0);
  const notionalUsd = out.reduce((a, r) => a + r.qty * r.px, 0);
  const riskUsd = out.reduce((a, r) => a + r.qty * Math.abs(r.px - stop), 0);
  return {
    plan: { coin: order.coin, side: order.side, stop, target, rungs: out, qty: floorToDecimals(qty, szDecimals), notionalUsd: r2(notionalUsd), riskUsd: r2(riskUsd), avgEntry: roundPerpPx(notionalUsd / qty, szDecimals) },
    reasons: [],
  };
}

export const dailyFloor = (s: ProprSnapshot, f: ProprVenueConfig["firm"]) => s.dayStartBalance * (1 - f.dailyLossPct / 100);
export const drawdownFloor = (s: ProprSnapshot, f: ProprVenueConfig["firm"]) => s.startingBalance * (1 - f.maxDrawdownPct / 100);

/** What every open position can still lose at its stop (an unprotected one blocks trading in firmReasons). */
export function openStopRisk(s: ProprSnapshot): number {
  return s.positions.reduce((a, p) => a + (p.stop == null ? 0 : Math.max(0, p.side === "long" ? (p.mark - p.stop) * p.qty : (p.stop - p.mark) * p.qty)), 0);
}

/**
 * Propr's firm rules on top of the governor: entries per day, no trade while anything is unprotected or already
 * working on the coin, the daily halt at a share of the daily limit, and the worst case (this ladder filled with the
 * stop slipping, fees both ways, every other open stop and resting rung) leaving a buffer above both loss floors.
 */
export function firmReasons(s: ProprSnapshot, plan: LadderPlan, f: ProprVenueConfig["firm"]): string[] {
  const out: string[] = [];
  if (s.perpRadarOrders > 0) out.push(`perp-radar's executor has ${s.perpRadarOrders} open order${s.perpRadarOrders === 1 ? "" : "s"} on this account: one executor per account`);
  if (s.positions.some((p) => p.stop == null)) out.push("an open position has no full stop: no new trades until it does");
  if (s.pendingRisk === Infinity) out.push("a resting ladder rung has no stop");
  if (s.working.includes(plan.coin)) out.push(`entry orders on ${plan.coin} are already resting`);
  if (s.entriesToday >= f.maxEntriesPerDay) out.push(`${s.entriesToday} entries today, limit ${f.maxEntriesPerDay}`);
  const limitUsd = s.dayStartBalance * (f.dailyLossPct / 100);
  const usedUsd = s.dayStartBalance - s.equity;
  if (usedUsd >= limitUsd * f.haltDailyUsedShare) out.push(`daily halt: ${r2(usedUsd)} USD of the ${r2(limitUsd)} USD daily limit used`);
  const worst = plan.riskUsd * f.stopSlipFactor + 2 * plan.notionalUsd * (f.feePct / 100);
  const others = openStopRisk(s) + (Number.isFinite(s.pendingRisk) ? s.pendingRisk : 0);
  const dailyRoom = s.equity - others - worst - dailyFloor(s, f);
  const floorRoom = s.equity - others - worst - drawdownFloor(s, f);
  const dailyNeed = s.dayStartBalance * (f.dailyBufferPct / 100);
  const floorNeed = s.startingBalance * (f.floorBufferPct / 100);
  if (dailyRoom < dailyNeed) out.push(`worst case leaves ${r2(dailyRoom)} USD above the daily-loss floor, needs ${r2(dailyNeed)}`);
  if (floorRoom < floorNeed) out.push(`worst case leaves ${r2(floorRoom)} USD above the drawdown floor, needs ${r2(floorNeed)}`);
  return out;
}

export interface LadderRequest {
  orderGroupId: string;
  orders: ProprOrderRequest[];
}

/** One request per rung (Propr takes one entry per request): the entry plus a reduce-only stop, and a take-profit when
 * the order has a target, for that rung's quantity in one orderGroupId, so each rung is protected the moment it fills. */
export function ladderRequests(plan: LadderPlan, accountId: string, seed: string, now: number): LadderRequest[] {
  const long = plan.side === "long";
  const exit = long ? ("sell" as const) : ("buy" as const);
  return plan.rungs.map((r, i) => {
    const common = { accountId, exchange: "hyperliquid" as const, positionSide: plan.side, productType: "perp" as const, asset: plan.coin, base: plan.coin, quote: "USDC" as const, quantity: String(r.qty), closePosition: false };
    const entry: ProprOrderRequest = r.market
      ? { ...common, intentId: ladderId(now, seed, i, "entry"), type: "market", side: long ? "buy" : "sell", timeInForce: "IOC", reduceOnly: false }
      : { ...common, intentId: ladderId(now, seed, i, "entry"), type: "limit", side: long ? "buy" : "sell", timeInForce: "GTC", price: String(r.px), reduceOnly: false };
    const orders: ProprOrderRequest[] = [entry, { ...common, intentId: ladderId(now, seed, i, "stop"), type: "stop_market", side: exit, timeInForce: "GTC", triggerPrice: String(plan.stop), reduceOnly: true }];
    if (plan.target != null) orders.push({ ...common, intentId: ladderId(now, seed, i, "tp"), type: "take_profit_market", side: exit, timeInForce: "GTC", triggerPrice: String(plan.target), reduceOnly: true });
    return { orderGroupId: ladderId(now, seed, i, "group"), orders };
  });
}
