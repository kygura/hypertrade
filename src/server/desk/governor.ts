import { confidenceAtLeast, type GovernorLimits } from "./config.js";
import type { AccountState, ExitProposal, Sizing, TradeProposal, Verdict } from "./types.js";

// The governor: deterministic risk rules between the agents and the book.
// No model output reaches an order without passing here, and the governor
// computes size itself from equity, the stop and the live mark. It runs
// again at execution time (approval may come hours later), so a verdict is
// always about current prices.

export interface MarketRef {
  coin: string;
  markPx: number;
  szDecimals: number;
  isDelisted: boolean;
}

export interface GovernorContext {
  limits: GovernorLimits;
  account: AccountState;
  market: MarketRef | null;
  killSwitch: boolean;
  now: Date;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Floor to the venue's size step so a rounded order never exceeds the risk budget. */
export function floorToDecimals(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.floor(x * f + 1e-9) / f;
}

/** Stop risk of an open position in USD (0 when it has no stop). */
export function openRiskUsd(p: AccountState["positions"][number]): number {
  if (p.stopPx == null) return p.notionalUsd; // unprotected: the whole notional is at risk
  return Math.max(0, p.side === "long" ? (p.markPx - p.stopPx) * p.size : (p.stopPx - p.markPx) * p.size);
}

export function evaluateOpen(p: TradeProposal, ctx: GovernorContext): Verdict {
  const { limits, account, market } = ctx;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const equity = account.equityUsd;
  const verdict = (sizing?: Sizing): Verdict => ({
    approved: reasons.length === 0,
    reasons,
    warnings,
    sizing,
    equityUsd: r2(equity),
    checkedAt: ctx.now.toISOString(),
  });

  if (ctx.killSwitch) reasons.push("kill switch is on: no new entries");
  if (!account.available) reasons.push(`account unavailable${account.note ? `: ${account.note}` : ""}`);
  if (!(equity > 0)) reasons.push("no equity");
  if (!market) {
    reasons.push(`${p.coin} is not a listed Hyperliquid perp`);
    return verdict();
  }
  if (market.isDelisted) reasons.push(`${p.coin} is delisted`);
  if (!confidenceAtLeast(p.confidence, limits.minConfidence)) reasons.push(`confidence ${p.confidence} is below the ${limits.minConfidence} floor`);

  const dayLossPct = equity > 0 ? (-account.dayPnlUsd / equity) * 100 : 0;
  if (dayLossPct >= limits.dailyLossLimitPct) reasons.push(`day loss ${r2(dayLossPct)}% has hit the ${limits.dailyLossLimitPct}% limit`);

  const existing = account.positions.find((x) => x.coin === p.coin);
  if (existing) reasons.push(`already ${existing.side} ${p.coin}: exit or adjust it instead of adding`);
  if (account.positions.length >= limits.maxPositions) reasons.push(`${account.positions.length} positions open, limit ${limits.maxPositions}`);

  const mark = market.markPx;
  const long = p.side === "long";
  if (long ? !(p.stop < mark) : !(p.stop > mark)) reasons.push(`stop ${p.stop} is on the wrong side of the mark ${mark} for a ${p.side}`);
  if (long ? !(p.target > mark) : !(p.target < mark)) reasons.push(`target ${p.target} is on the wrong side of the mark ${mark} for a ${p.side}`);
  if (p.entryLimit != null && (long ? mark > p.entryLimit : mark < p.entryLimit)) {
    reasons.push(`mark ${mark} is already past the entry limit ${p.entryLimit}`);
  }
  if (reasons.some((x) => x.includes("wrong side"))) return verdict();

  const stopDistPct = (Math.abs(mark - p.stop) / mark) * 100;
  if (stopDistPct < limits.minStopPct) reasons.push(`stop is ${r2(stopDistPct)}% away, under the ${limits.minStopPct}% minimum (noise, and fees eat it)`);
  if (stopDistPct > limits.maxStopPct) reasons.push(`stop is ${r2(stopDistPct)}% away, over the ${limits.maxStopPct}% maximum`);
  const rr = Math.abs(p.target - mark) / Math.abs(mark - p.stop);
  if (rr < limits.minRewardRisk) reasons.push(`reward:risk ${r2(rr)} at the current mark is under ${limits.minRewardRisk}`);

  // Size from risk, then cap by leverage limits and the open-risk budget.
  let riskPct = p.riskPct;
  if (riskPct > limits.maxRiskPct) {
    warnings.push(`risk ${riskPct}% clipped to the ${limits.maxRiskPct}% per-trade limit`);
    riskPct = limits.maxRiskPct;
  }
  const openRisk = account.positions.reduce((a, x) => a + openRiskUsd(x), 0);
  const riskRoom = (limits.maxOpenRiskPct / 100) * equity - openRisk;
  let riskUsd = Math.min((riskPct / 100) * equity, Math.max(0, riskRoom));
  if (riskUsd < (riskPct / 100) * equity) warnings.push(`risk reduced to ${r2(riskUsd)} USD by the ${limits.maxOpenRiskPct}% open-risk budget`);

  let notional = riskUsd / (stopDistPct / 100);
  const gross = account.positions.reduce((a, x) => a + x.notionalUsd, 0);
  const grossRoom = limits.maxGrossLeverage * equity - gross;
  const coinCap = limits.maxCoinLeverage * equity;
  const cap = Math.min(grossRoom, coinCap);
  if (notional > cap) {
    warnings.push(`notional capped at ${r2(Math.max(0, cap))} USD by leverage limits (gross ${limits.maxGrossLeverage}x, per coin ${limits.maxCoinLeverage}x)`);
    notional = Math.max(0, cap);
  }
  const size = floorToDecimals(notional / mark, market.szDecimals);
  notional = size * mark;
  riskUsd = notional * (stopDistPct / 100);
  if (notional < limits.minNotionalUsd) reasons.push(`order would be ${r2(notional)} USD, under the ${limits.minNotionalUsd} USD minimum`);

  const feeUsd = notional * limits.takerFee * 2;
  if (riskUsd > 0 && feeUsd / riskUsd > 0.15) warnings.push(`round-trip fees are ${r2((feeUsd / riskUsd) * 100)}% of the risk`);

  return verdict({
    markPx: mark,
    size,
    notionalUsd: r2(notional),
    riskUsd: r2(riskUsd),
    stopDistPct: r2(stopDistPct),
    rr: r2(rr),
    feeUsd: r2(feeUsd),
    grossLeverageAfter: equity > 0 ? r2((gross + notional) / equity) : 0,
  });
}

/** Exits only reduce risk, so the only checks are that the position exists and the size rounds. */
export function evaluateExit(p: ExitProposal, ctx: GovernorContext): Verdict {
  const reasons: string[] = [];
  const pos = ctx.account.positions.find((x) => x.coin === p.coin);
  if (!ctx.account.available) reasons.push("account unavailable");
  if (!pos) reasons.push(`no open ${p.coin} position`);
  let sizing: Sizing | undefined;
  if (pos && ctx.market) {
    const size = p.fraction >= 1 ? pos.size : floorToDecimals(pos.size * p.fraction, ctx.market.szDecimals);
    if (size <= 0) reasons.push("exit size rounds to zero");
    const notional = size * ctx.market.markPx;
    sizing = {
      markPx: ctx.market.markPx,
      size,
      notionalUsd: r2(notional),
      riskUsd: 0,
      stopDistPct: 0,
      rr: 0,
      feeUsd: r2(notional * ctx.limits.takerFee),
      grossLeverageAfter: 0,
    };
  }
  return { approved: reasons.length === 0, reasons, warnings: [], sizing, equityUsd: r2(ctx.account.equityUsd), checkedAt: ctx.now.toISOString() };
}
