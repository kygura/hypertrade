import { evaluateRisk, floorToDecimals, type GovernorContext, type MarketRef } from "../../../src/server/desk/governor.js";
import type { AccountState, RiskOrder } from "../../../src/server/desk/types.js";
import { roundPerpPx } from "../../../src/server/desk/hl/wire.js";
import { resolveOrder, type OrderMarket } from "../../../src/server/intel/order-resolve.js";
import { walkBook } from "../../../src/server/platform/costs.js";
import { governorLimits } from "./config.js";
import type { AccountSnapshot, Candle, Config, InfoSource, MarketRow, OrderIntent, PositionRow, Requote, Ticket, TicketAction } from "./types.js";

// Tickets: an action resolved into exact numbers at the live market, with
// every reason it must not be sent. Nothing here signs or sends; exchange.ts
// does, and only for a ticket with canSend === true.
//
// Open: resolveOrder (intent → stop, size, liq) → governor evaluateRisk (it
// may clip the size) → live-book slippage → notional cap → mode blockers.
// Close / cancel / stop only reduce risk: no governor, no notional cap.

export interface TicketDeps {
  config: Config;
  info: InfoSource;
  markets: MarketRow[];
  account: AccountSnapshot | null;
  now?: () => Date;
  id?: () => string;
}

/**
 * Extra fields carried on Ticket.action (types.ts has no slot for them):
 * - open.riskPct: risk-based sizing ("risk 0.5%"); notional = equity × risk% / stop%.
 *   Without it the intent's own size.usd / size.pctBook is used.
 * - close.cleanupOids / stop.replaceOids: trigger orders captured from the account
 *   at quote time (listed in the ticket notes) that the exchange cancels after a
 *   full close, or replaces with the new stop. Rebuilt fresh on every requote.
 */
export type OpenTicketAction = Extract<TicketAction, { kind: "open" }> & { riskPct?: number };
export type CloseTicketAction = Extract<TicketAction, { kind: "close" }> & { cleanupOids?: number[] };
export type StopTicketAction = Extract<TicketAction, { kind: "stop" }> & { replaceOids?: number[] };
export type TicketRequest = TicketAction | OpenTicketAction;

/** Mark move between quote and confirm that forces a fresh confirmation. */
export const REQUOTE_MOVE = 0.005;
const DAY = 86_400_000;

/** The price tickets and the exchange quote against: the WS mid when fresher, else the polled mark. */
export const livePx = (m: MarketRow): number => m.midPx ?? m.markPx;

export function findMarket(markets: MarketRow[], coin: string): MarketRow | null {
  return markets.find((m) => m.coin === coin) ?? markets.find((m) => m.coin.toLowerCase() === coin.toLowerCase()) ?? null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const fmtPx = (x: number) => x.toLocaleString("en-US", { maximumSignificantDigits: 6 });
const fmtUsd = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 64 random bits: ids also guard against double sends, so they must never collide. */
function defaultId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return `t-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Notional the HT_MAX_NOTIONAL_USD cap is checked against: size × limit for a
 * limit entry, else size × mark × (1 + slippage), the far edge of the IOC band.
 * Shared with exchange.ts so the ticket and the pre-sign check agree.
 */
export function capNotionalUsd(size: number, limitPx: number | null, mark: number, slippage: number): number {
  return size * (limitPx ?? mark * (1 + slippage));
}

/** Strips the quote-time extras so a requote recaptures them from the fresh account. */
function baseAction(a: TicketAction): TicketRequest {
  switch (a.kind) {
    case "open": {
      const rp = (a as OpenTicketAction).riskPct;
      return rp != null ? { kind: "open", intent: a.intent, riskPct: rp } : { kind: "open", intent: a.intent };
    }
    case "close":
      return { kind: "close", coin: a.coin, pct: a.pct };
    case "stop":
      return { kind: "stop", coin: a.coin, px: a.px };
    case "cancel":
      return { kind: "cancel", oids: a.oids.map((o) => ({ coin: o.coin, oid: o.oid })) };
  }
}

function modeBlockers(config: Config): string[] {
  if (config.demo) return ["demo: orders disabled"];
  if (!config.canTrade) return ["read-only: no HT_AGENT_KEY"];
  return [];
}

function blank(action: TicketAction, deps: TicketDeps, now: Date): Ticket {
  return {
    id: (deps.id ?? defaultId)(),
    action,
    network: deps.config.network,
    coin: "",
    side: null,
    size: null,
    notionalUsd: null,
    entryPx: null,
    stopPx: null,
    tpPx: null,
    liqPx: null,
    riskUsd: null,
    riskPct: null,
    rr: null,
    leverage: null,
    slippageBps: null,
    verdict: null,
    blockers: [],
    warnings: [],
    notes: [],
    canSend: false,
    markPx: null,
    quotedAt: now.getTime(),
  };
}

function finish(t: Ticket, config: Config): Ticket {
  for (const b of modeBlockers(config)) if (!t.blockers.includes(b)) t.blockers.push(b);
  t.canSend = t.blockers.length === 0;
  return t;
}

function toAccountState(a: AccountSnapshot, network: string): AccountState {
  return {
    venue: `hl-${network}`,
    equityUsd: a.equityUsd,
    // AccountSnapshot carries no day PnL: the governor's daily-loss check cannot fire (noted on each open ticket).
    dayPnlUsd: 0,
    positions: [
      ...a.positions.map((p) => ({
        coin: p.coin,
        side: p.side,
        size: p.size,
        entryPx: p.entryPx,
        markPx: p.markPx,
        stopPx: p.stopPx,
        tpPx: p.tpPx,
        unrealizedPnl: p.unrealizedPnlUsd,
        notionalUsd: p.notionalUsd,
      })),
      ...pendingExposure(a),
    ],
    available: true,
  };
}

/**
 * Resting non-reduce-only orders as would-be positions (one per coin and side),
 * so the governor's same-coin rule, position count, open-risk and gross budgets
 * see them. Risk is to a reduce-only stop trigger on the loss side when one is
 * visible and the coin has no position (else that stop belongs to the position);
 * otherwise the whole notional counts as at risk, as for an unprotected position.
 */
function pendingExposure(a: AccountSnapshot): AccountState["positions"] {
  const by = new Map<string, { coin: string; side: "long" | "short"; size: number; notional: number }>();
  for (const o of a.orders) {
    if (o.reduceOnly) continue;
    const px = o.triggerPx ?? o.limitPx;
    if (!(px > 0) || !(o.size > 0)) continue;
    const side = o.side === "buy" ? "long" : "short";
    const e = by.get(`${o.coin}:${side}`) ?? { coin: o.coin, side, size: 0, notional: 0 };
    e.size += o.size;
    e.notional += o.size * px;
    by.set(`${o.coin}:${side}`, e);
  }
  return [...by.values()].map((e) => {
    const entryPx = e.notional / e.size;
    const long = e.side === "long";
    const hasPos = a.positions.some((p) => p.coin === e.coin);
    const sl = hasPos ? undefined : a.orders.find((o) => o.coin === e.coin && o.reduceOnly && o.tpsl === "sl" && o.side === (long ? "sell" : "buy"));
    const slPx = sl ? (sl.triggerPx ?? sl.limitPx) : null;
    const stopPx = slPx != null && (long ? slPx < entryPx : slPx > entryPx) ? slPx : null;
    return { coin: e.coin, side: e.side, size: e.size, entryPx, markPx: entryPx, stopPx, tpPx: null, unrealizedPnl: 0, notionalUsd: e.notional };
  });
}

/** Slippage estimate in bps vs mid for `notional` USD taken on `side`; adds a warning when unknown or wider than the IOC band. */
async function estimateSlippage(t: Ticket, info: InfoSource, coin: string, isBuy: boolean, notional: number, band: number): Promise<void> {
  try {
    const book = await info.book(coin);
    const fill = walkBook(isBuy ? book.asks : book.bids, isBuy ? "buy" : "sell", notional, book.mid ?? undefined);
    if (!fill) {
      t.warnings.push(`book too thin to fill ${fmtUsd(notional)}: slippage unknown, the IOC may fill partially`);
      return;
    }
    t.slippageBps = r2(fill.slippageBps);
    if (fill.slippageBps > band * 1e4) t.warnings.push(`estimated slippage ${r2(fill.slippageBps)} bps exceeds the ±${r2(band * 100)}% IOC band: expect a partial fill`);
  } catch (e) {
    t.warnings.push(`book unavailable (${errMsg(e)}): slippage not estimated`);
  }
}

function position(account: AccountSnapshot | null, coin: string): PositionRow | null {
  return account?.positions.find((p) => p.coin === coin) ?? null;
}

// ─── open ───

async function buildOpen(action: OpenTicketAction, deps: TicketDeps, now: Date): Promise<Ticket> {
  const { config, info, account } = deps;
  const intent: OrderIntent = action.intent;
  const t = blank(action, deps, now);
  t.coin = intent.asset;
  t.side = intent.side;
  t.tpPx = intent.target ?? null;

  const m = findMarket(deps.markets, intent.asset);
  if (!m) {
    t.blockers.push(`${intent.asset} is not a listed Hyperliquid perp`);
    return finish(t, config);
  }
  t.coin = m.coin;
  const mark = livePx(m);
  t.markPx = mark;
  if (m.isDelisted) t.blockers.push(`${m.coin} is delisted`);
  if (!account) {
    t.blockers.push("no account configured: set HT_ACCOUNT or HT_AGENT_KEY");
    return finish(t, config);
  }
  if (!(account.equityUsd > 0)) {
    t.blockers.push("account has no equity: the order cannot be sized");
    return finish(t, config);
  }
  if (action.riskPct != null && !(action.riskPct > 0 && Number.isFinite(action.riskPct))) {
    t.blockers.push(`risk ${action.riskPct}% is not a positive percent`);
    return finish(t, config);
  }

  let daily: Candle[] = [];
  if (intent.stop.type === "atr_mult" || intent.stop.type === "prev_day_low" || intent.stop.type === "prev_day_high") {
    try {
      daily = await info.candles(m.coin, "1d", now.getTime() - 30 * DAY);
    } catch (e) {
      t.blockers.push(`candles: ${errMsg(e)}`);
      return finish(t, config);
    }
  }
  const om: OrderMarket = { coin: m.coin, markPx: mark, maxLeverage: m.maxLeverage, szDecimals: m.szDecimals, equityUsd: account.equityUsd, daily, now };

  // Venue-rounded prices throughout, so the ticket shows and sizes exactly what goes on the wire.
  const venue = (px: number) => roundPerpPx(px, m.szDecimals);
  const rounded: OrderIntent = { ...intent };
  if (intent.entry.type === "limit") {
    const px = venue(intent.entry.px);
    if (px !== intent.entry.px) t.notes.push(`limit ${fmtPx(intent.entry.px)} rounded to the venue price ${fmtPx(px)}`);
    rounded.entry = { type: "limit", px };
  }
  if (intent.target != null) {
    const tp = venue(intent.target);
    if (tp !== intent.target) t.notes.push(`tp ${fmtPx(intent.target)} rounded to the venue price ${fmtPx(tp)}`);
    rounded.target = tp;
  }
  t.tpPx = rounded.target ?? null;

  // Pass 1 resolves the stop; pass 2 resolves at the venue-rounded stop and the final (risk-implied) size.
  const probe = resolveOrder(action.riskPct != null ? { ...rounded, size: { usd: Math.max(account.equityUsd, 1e6) } } : rounded, om);
  if (!probe.ok) {
    t.blockers.push(`resolve: ${probe.error}`);
    return finish(t, config);
  }
  const venueStop = venue(probe.resolved.stopPx);
  let size: OrderIntent["size"] = rounded.size;
  let riskNote: string | null = null;
  if (action.riskPct != null) {
    const stopFrac = Math.abs(probe.resolved.entryPx - venueStop) / probe.resolved.entryPx;
    if (!(stopFrac > 0)) {
      t.blockers.push(`resolve: stop ${fmtPx(venueStop)} rounds onto the entry`);
      return finish(t, config);
    }
    const usd = r2((account.equityUsd * (action.riskPct / 100)) / stopFrac);
    size = { usd };
    riskNote = `size = risk ${action.riskPct}% of equity ${fmtUsd(account.equityUsd)} at a ${r2(stopFrac * 100)}% stop: ${fmtUsd(usd)} notional`;
  }
  const r = resolveOrder({ ...rounded, size, stop: { type: "price", px: venueStop } }, om);
  if (!r.ok) {
    t.blockers.push(`resolve: ${r.error}`);
    return finish(t, config);
  }
  const { entryPx, stopPx, liqPx } = r.resolved;
  t.entryPx = entryPx;
  t.stopPx = stopPx;
  t.liqPx = liqPx;
  // Hyperliquid takes whole-number leverage; round down (more margin, never less).
  t.leverage = Math.max(1, Math.floor(r.leverage));
  if (t.leverage !== r.leverage) t.warnings.push(`leverage ${r.leverage}x rounded down to ${t.leverage}x (Hyperliquid takes whole numbers); liq ≈ is for ${r.leverage}x`);
  if (riskNote) t.notes.push(riskNote);
  const how = probe.notes.find((n) => n.startsWith("stop = "));
  t.notes.push(...r.notes.map((n) => (how && n.startsWith("stop = ") ? how : n)));
  if (venueStop !== probe.resolved.stopPx) t.notes.push(`stop ${fmtPx(probe.resolved.stopPx)} rounded to the venue price ${fmtPx(venueStop)}`);
  t.warnings.push(...r.warnings, ...probe.warnings.filter((w) => !w.startsWith("liquidation") && !r.warnings.includes(w)));

  // A limit order is evaluated at its limit price (where it fills), not the mark:
  // the desk's entryLimit means "worst acceptable price" and would reject every resting limit.
  const isLimit = intent.entry.type === "limit";
  if (isLimit) {
    t.notes.push(`limit order: governor evaluated at the limit price ${fmtPx(entryPx)}`);
    const long = intent.side === "long";
    const band = config.slippage;
    if (long ? entryPx > mark * (1 + band) : entryPx < mark * (1 - band)) {
      t.blockers.push(`limit ${fmtPx(entryPx)} is more than ${r2(band * 100)}% through the mark ${fmtPx(mark)}: use a market order or a closer limit`);
    } else if (long ? entryPx >= mark : entryPx <= mark) {
      t.warnings.push(`limit ${fmtPx(entryPx)} is through the mark ${fmtPx(mark)}: it fills at once as a taker`);
    }
  }

  // Resting entries count as exposure: same coin blocks, every coin counts toward open risk and gross.
  const resting = account.orders.filter((o) => !o.reduceOnly);
  const sameCoin = resting.filter((o) => o.coin === m.coin);
  if (sameCoin.length) t.blockers.push(`resting entry order${sameCoin.length > 1 ? "s" : ""} on ${m.coin} (oid ${sameCoin.map((o) => o.oid).join(", ")}): cancel before opening another`);
  if (resting.length) t.notes.push(`${resting.length} resting entry order(s) counted as exposure by the governor (without a visible stop, their whole notional counts as risk)`);

  const ref: MarketRef = { coin: m.coin, markPx: entryPx, szDecimals: m.szDecimals, isDelisted: m.isDelisted };
  const ctx: GovernorContext = { limits: governorLimits(config.limits), account: toAccountState(account, config.network), market: ref, killSwitch: false, now };
  // Full-precision risk percent: the resolver's rounded one could make the governor floor one size step lower.
  const resolvedRiskPct = ((r.resolved.size * Math.abs(entryPx - stopPx)) / account.equityUsd) * 100;
  const order: RiskOrder = { coin: m.coin, side: intent.side, stop: stopPx, riskPct: resolvedRiskPct, ...(rounded.target != null ? { target: rounded.target } : {}) };
  const verdict = evaluateRisk(order, ctx);
  t.verdict = verdict;
  t.notes.push("governor daily-loss limit not checked: day PnL is not available from the account snapshot");
  for (const reason of verdict.reasons) if (!t.blockers.includes(reason)) t.blockers.push(reason);

  let qty = r.resolved.size;
  if (verdict.sizing) {
    const capped = floorToDecimals(Math.min(qty, verdict.sizing.size), m.szDecimals);
    if (capped < qty) t.warnings.push(`size reduced from ${qty} to ${capped} ${m.coin} by the governor`);
    qty = capped;
  }
  if (!(qty > 0)) t.blockers.push("size rounds to zero");
  t.size = qty;
  const notional = qty * entryPx;
  t.notionalUsd = r2(notional);
  t.riskUsd = r2(qty * Math.abs(entryPx - stopPx));
  t.riskPct = Math.round(((qty * Math.abs(entryPx - stopPx)) / account.equityUsd) * 100 * 1e4) / 1e4;
  if (rounded.target != null) t.rr = r2(Math.abs(rounded.target - entryPx) / Math.abs(entryPx - stopPx));

  // Cap on the worst price the order may fill at: the limit, or the far edge of the IOC band.
  const capNotional = capNotionalUsd(qty, isLimit ? entryPx : null, mark, config.slippage);
  if (capNotional > config.maxNotionalUsd) {
    t.blockers.push(`notional ${fmtUsd(capNotional)}${isLimit ? "" : ` (mark + ${r2(config.slippage * 100)}% IOC band)`} exceeds HT_MAX_NOTIONAL_USD ${fmtUsd(config.maxNotionalUsd)}`);
  }
  const lev = t.leverage;
  if (notional / lev > account.withdrawableUsd) {
    t.warnings.push(`margin needed ≈ ${fmtUsd(notional / lev)} at ${lev}x exceeds withdrawable ${fmtUsd(account.withdrawableUsd)}: the exchange may reject it`);
  }

  if (qty > 0) {
    if (isLimit) t.notes.push("Gtc limit entry: slippage not estimated");
    else await estimateSlippage(t, info, m.coin, intent.side === "long", notional, config.slippage);
  }
  if (!isLimit) t.notes.push(`market entry: IOC limit ${r2(config.slippage * 100)}% through the mark`);
  return finish(t, config);
}

// ─── close ───

async function buildClose(action: CloseTicketAction, deps: TicketDeps, now: Date): Promise<Ticket> {
  const { config, account } = deps;
  const t = blank(action, deps, now);
  t.coin = action.coin;
  const m = findMarket(deps.markets, action.coin);
  if (!m) {
    t.blockers.push(`${action.coin} is not a listed Hyperliquid perp`);
    return finish(t, config);
  }
  t.coin = m.coin;
  t.markPx = livePx(m);
  if (!account) {
    t.blockers.push("no account configured: set HT_ACCOUNT or HT_AGENT_KEY");
    return finish(t, config);
  }
  const pos = position(account, m.coin);
  if (!pos) {
    t.blockers.push(`no open ${m.coin} position`);
    return finish(t, config);
  }
  if (!(Number.isFinite(action.pct) && action.pct > 0 && action.pct <= 100)) {
    t.blockers.push(`close percent ${action.pct} must be above 0 and at most 100`);
    return finish(t, config);
  }
  const full = action.pct >= 100;
  const size = full ? pos.size : floorToDecimals(pos.size * (action.pct / 100), m.szDecimals);
  t.side = pos.side;
  t.size = size;
  t.entryPx = t.markPx;
  t.stopPx = pos.stopPx;
  t.tpPx = pos.tpPx;
  t.liqPx = pos.liqPx;
  t.leverage = pos.leverage;
  if (!(size > 0)) {
    t.blockers.push("close size rounds to zero");
    return finish(t, config);
  }
  const notional = size * t.markPx;
  t.notionalUsd = r2(notional);
  t.notes.push(`reduce-only IOC ${pos.side === "long" ? "sell" : "buy"} ${r2(config.slippage * 100)}% through the mark: closes ${full ? "the whole" : `${action.pct}% of the`} ${pos.side} position (${pos.size} ${m.coin})`);
  if (notional > config.maxNotionalUsd) {
    t.warnings.push(`notional ${fmtUsd(notional)} is over HT_MAX_NOTIONAL_USD ${fmtUsd(config.maxNotionalUsd)}; closes are not capped (they reduce risk)`);
  }
  if (full) {
    const triggers = account.orders.filter((o) => o.coin === m.coin && o.reduceOnly && o.isTrigger);
    const extra: CloseTicketAction = { ...action, cleanupOids: triggers.map((o) => o.oid) };
    t.action = extra;
    if (triggers.length) t.notes.push(`after a full fill, cancels ${triggers.length} leftover trigger order(s): ${triggers.map((o) => `${o.oid} ${o.tpsl ?? "trigger"} @ ${fmtPx(o.triggerPx ?? o.limitPx)}`).join(", ")}`);
  }
  await estimateSlippage(t, deps.info, m.coin, pos.side === "short", notional, config.slippage);
  return finish(t, config);
}

// ─── cancel ───

function buildCancel(action: Extract<TicketAction, { kind: "cancel" }>, deps: TicketDeps, now: Date): Ticket {
  const { config, account } = deps;
  const t = blank(action, deps, now);
  const coins = [...new Set(action.oids.map((o) => o.coin))];
  t.coin = coins.join(",");
  if (!action.oids.length) {
    t.blockers.push("no orders to cancel");
    return finish(t, config);
  }
  if (!account) {
    t.blockers.push("no account configured: set HT_ACCOUNT or HT_AGENT_KEY");
    return finish(t, config);
  }
  const seen = new Set<number>();
  for (const { coin, oid } of action.oids) {
    if (seen.has(oid)) {
      t.blockers.push(`order ${oid} is listed twice`);
      continue;
    }
    seen.add(oid);
    const o = account.orders.find((x) => x.oid === oid);
    if (!o) {
      t.blockers.push(`order ${oid} is not among the open orders`);
      continue;
    }
    if (o.coin !== coin) {
      t.blockers.push(`order ${oid} is on ${o.coin}, not ${coin}`);
      continue;
    }
    if (!findMarket(deps.markets, o.coin)) t.blockers.push(`${o.coin} is not a listed Hyperliquid perp`);
    t.notes.push(`${o.oid} ${o.coin} ${o.side} ${o.size} ${o.isTrigger ? `${o.tpsl ?? "trigger"} @ ${fmtPx(o.triggerPx ?? o.limitPx)}` : `limit @ ${fmtPx(o.limitPx)}`}${o.reduceOnly ? " reduce-only" : ""}`);
    if (o.tpsl === "sl" && position(account, o.coin)) {
      const others = account.orders.filter((x) => x.coin === o.coin && x.tpsl === "sl" && !action.oids.some((c) => c.oid === x.oid));
      if (!others.length) t.warnings.push(`cancelling ${oid} leaves the open ${o.coin} position without a stop`);
    }
  }
  return finish(t, config);
}

// ─── stop ───

function buildStop(action: StopTicketAction, deps: TicketDeps, now: Date): Ticket {
  const { config, account } = deps;
  const t = blank(action, deps, now);
  t.coin = action.coin;
  const m = findMarket(deps.markets, action.coin);
  if (!m) {
    t.blockers.push(`${action.coin} is not a listed Hyperliquid perp`);
    return finish(t, config);
  }
  t.coin = m.coin;
  const mark = livePx(m);
  t.markPx = mark;
  if (!account) {
    t.blockers.push("no account configured: set HT_ACCOUNT or HT_AGENT_KEY");
    return finish(t, config);
  }
  const pos = position(account, m.coin);
  if (!pos) {
    t.blockers.push(`no open ${m.coin} position`);
    return finish(t, config);
  }
  t.side = pos.side;
  t.size = pos.size;
  t.entryPx = pos.entryPx;
  t.tpPx = pos.tpPx;
  t.liqPx = pos.liqPx;
  t.leverage = pos.leverage;
  t.notionalUsd = r2(pos.size * mark);
  if (!(Number.isFinite(action.px) && action.px > 0)) {
    t.blockers.push(`stop ${action.px} is not a price`);
    return finish(t, config);
  }
  // The venue-rounded price is what is shown, checked and sent.
  const px = roundPerpPx(action.px, m.szDecimals);
  if (px !== action.px) t.notes.push(`stop ${fmtPx(action.px)} rounded to the venue price ${fmtPx(px)}`);
  t.stopPx = px;
  const long = pos.side === "long";
  if (long ? !(px < mark) : !(px > mark)) {
    t.blockers.push(`stop ${fmtPx(px)} is on the wrong side of the mark ${fmtPx(mark)} for a ${pos.side}: it would trigger at once`);
  }
  if (pos.liqPx != null && (long ? px <= pos.liqPx : px >= pos.liqPx)) {
    t.warnings.push(`stop ${fmtPx(px)} is beyond the liquidation price ${fmtPx(pos.liqPx)}`);
  }
  const riskUsd = pos.size * Math.abs(mark - px);
  t.riskUsd = r2(riskUsd);
  if (account.equityUsd > 0) t.riskPct = Math.round((riskUsd / account.equityUsd) * 100 * 1e4) / 1e4;
  const old = account.orders.filter((o) => o.coin === m.coin && o.tpsl === "sl");
  const withOids: StopTicketAction = { ...action, replaceOids: old.map((o) => o.oid) };
  t.action = withOids;
  t.notes.push(`reduce-only market stop for the full ${pos.size} ${m.coin}; the new stop is placed first, then the old one cancelled`);
  if (old.length) t.notes.push(`replaces ${old.map((o) => `${o.oid} @ ${fmtPx(o.triggerPx ?? o.limitPx)}`).join(", ")}`);
  else t.warnings.push(`${m.coin} position has no stop resting now`);
  return finish(t, config);
}

/** Resolves an action into a ticket at the current market. Never throws for market or account problems: they become blockers. */
export async function buildTicket(action: TicketRequest, deps: TicketDeps): Promise<Ticket> {
  const now = (deps.now ?? (() => new Date()))();
  switch (action.kind) {
    case "open":
      return buildOpen(action, deps, now);
    case "close":
      return buildClose(action, deps, now);
    case "cancel":
      return buildCancel(action, deps, now);
    case "stop":
      return buildStop(action, deps, now);
  }
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * Which prices are fixed by the action (compared exactly on requote) rather
 * than moving with the mark (covered by the 0.5% mark rule): a market entry,
 * a close's fill estimate, and pct/ATR stops of a market entry track the mark.
 */
function fixedPrices(t: Ticket): { entry: boolean; stop: boolean } {
  const a = t.action;
  if (a.kind === "close") return { entry: false, stop: true };
  if (a.kind !== "open") return { entry: true, stop: true };
  const limit = a.intent.entry.type === "limit";
  return { entry: limit, stop: limit || (a.intent.stop.type !== "pct" && a.intent.stop.type !== "atr_mult") };
}

/**
 * Re-quotes a ticket at confirm time (same id), on a freshly fetched account
 * (falling back to deps.account with a warning when the fetch fails).
 * "changed" when the mark moved more than 0.5%; the size, leverage, TP, a fixed
 * entry or stop price changed; sendability or the governor verdict flipped; or
 * the blockers differ. The UI must then ask for another `y`.
 */
export async function requote(t: Ticket, deps: TicketDeps): Promise<Requote> {
  let account = deps.account;
  let refreshWarning: string | null = null;
  if (deps.config.account) {
    try {
      account = await deps.info.account(deps.config.account, deps.markets);
    } catch (e) {
      refreshWarning = `account refresh failed (${errMsg(e)}): re-quoted on the last snapshot`;
    }
  }
  const next = await buildTicket(baseAction(t.action), { ...deps, account, id: () => t.id });
  if (refreshWarning) next.warnings.push(refreshWarning);
  const why: string[] = [];
  if (t.markPx != null && next.markPx != null) {
    const move = (next.markPx - t.markPx) / t.markPx;
    if (Math.abs(move) > REQUOTE_MOVE) why.push(`mark moved ${move > 0 ? "+" : ""}${r2(move * 100)}% (${fmtPx(t.markPx)} → ${fmtPx(next.markPx)})`);
  } else if (t.markPx !== next.markPx) why.push("mark unavailable");
  const fixed = fixedPrices(t);
  const diff = (label: string, a: number | null, b: number | null) => {
    if (a !== b) why.push(`${label} ${a ?? "—"} → ${b ?? "—"}`);
  };
  diff("size", t.size, next.size);
  diff("leverage", t.leverage, next.leverage);
  diff("tp", t.tpPx, next.tpPx);
  if (fixed.entry) diff("entry", t.entryPx, next.entryPx);
  if (fixed.stop) diff("stop", t.stopPx, next.stopPx);
  if ((t.verdict?.approved ?? null) !== (next.verdict?.approved ?? null)) why.push(`governor ${t.verdict?.approved ? "PASS" : "REJECTED"} → ${next.verdict?.approved ? "PASS" : "REJECTED"}`);
  if (t.canSend !== next.canSend) why.push(next.canSend ? "now sendable" : "now blocked");
  if (!sameList(t.blockers, next.blockers)) why.push("blockers changed");
  return why.length ? { kind: "changed", ticket: next, why: why.join("; ") } : { kind: "same", ticket: next };
}
