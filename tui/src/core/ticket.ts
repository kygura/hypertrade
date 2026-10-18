import { evaluateRisk, floorToDecimals, type GovernorContext, type MarketRef } from "../../../src/server/desk/governor.js";
import type { AccountState, RiskOrder } from "../../../src/server/desk/types.js";
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

function defaultId(): string {
  return `t-${crypto.randomUUID().replace(/-/g, "").slice(0, 4)}`;
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
    positions: a.positions.map((p) => ({
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
    available: true,
  };
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

  // Risk sizing needs the resolved stop first: resolve once for the stop, then again at the risk-implied notional.
  let sizedIntent = intent;
  let riskNote: string | null = null;
  if (action.riskPct != null) {
    const probe = resolveOrder({ ...intent, size: { usd: account.equityUsd } }, om);
    if (!probe.ok) {
      t.blockers.push(`resolve: ${probe.error}`);
      return finish(t, config);
    }
    const stopFrac = Math.abs(probe.resolved.entryPx - probe.resolved.stopPx) / probe.resolved.entryPx;
    const usd = r2((account.equityUsd * (action.riskPct / 100)) / stopFrac);
    sizedIntent = { ...intent, size: { usd } };
    riskNote = `size = risk ${action.riskPct}% of equity ${fmtUsd(account.equityUsd)} at a ${r2(stopFrac * 100)}% stop: ${fmtUsd(usd)} notional`;
  }
  const r = resolveOrder(sizedIntent, om);
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
  t.notes.push(...r.notes);
  t.warnings.push(...r.warnings);

  // Governor. A limit order is evaluated at its limit price (where it fills), not the mark:
  // the desk's entryLimit means "worst acceptable price" and would reject every resting limit.
  const isLimit = intent.entry.type === "limit";
  if (isLimit) {
    t.notes.push(`limit order: governor evaluated at the limit price ${fmtPx(entryPx)}`);
    const marketable = intent.side === "long" ? entryPx >= mark : entryPx <= mark;
    if (marketable) t.warnings.push(`limit ${fmtPx(entryPx)} is through the mark ${fmtPx(mark)}: it fills at once as a taker`);
  }
  const ref: MarketRef = { coin: m.coin, markPx: entryPx, szDecimals: m.szDecimals, isDelisted: m.isDelisted };
  const ctx: GovernorContext = { limits: governorLimits(config.limits), account: toAccountState(account, config.network), market: ref, killSwitch: false, now };
  // Full-precision risk percent: the resolver's rounded one could make the governor floor one size step lower.
  const resolvedRiskPct = ((r.resolved.size * Math.abs(entryPx - stopPx)) / account.equityUsd) * 100;
  const order: RiskOrder = { coin: m.coin, side: intent.side, stop: stopPx, riskPct: resolvedRiskPct, ...(intent.target != null ? { target: intent.target } : {}) };
  const verdict = evaluateRisk(order, ctx);
  t.verdict = verdict;
  t.notes.push("governor daily-loss limit not checked: day PnL is not available from the account snapshot");
  if (!verdict.approved) t.blockers.push(...verdict.reasons);

  let size = r.resolved.size;
  if (verdict.sizing) {
    const capped = floorToDecimals(Math.min(size, verdict.sizing.size), m.szDecimals);
    if (capped < size) t.warnings.push(`size reduced from ${size} to ${capped} ${m.coin} by the governor`);
    size = capped;
  }
  if (!(size > 0)) t.blockers.push("size rounds to zero");
  t.size = size;
  const notional = size * entryPx;
  t.notionalUsd = r2(notional);
  t.riskUsd = r2(size * Math.abs(entryPx - stopPx));
  t.riskPct = Math.round(((size * Math.abs(entryPx - stopPx)) / account.equityUsd) * 100 * 1e4) / 1e4;
  if (intent.target != null) t.rr = r2(Math.abs(intent.target - entryPx) / Math.abs(entryPx - stopPx));

  if (notional > config.maxNotionalUsd) t.blockers.push(`notional ${fmtUsd(notional)} exceeds HT_MAX_NOTIONAL_USD ${fmtUsd(config.maxNotionalUsd)}`);
  const lev = t.leverage;
  if (notional / lev > account.withdrawableUsd) {
    t.warnings.push(`margin needed ≈ ${fmtUsd(notional / lev)} at ${lev}x exceeds withdrawable ${fmtUsd(account.withdrawableUsd)}: the exchange may reject it`);
  }

  if (size > 0) {
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
  t.stopPx = action.px;
  const long = pos.side === "long";
  if (long ? !(action.px < mark) : !(action.px > mark)) {
    t.blockers.push(`stop ${fmtPx(action.px)} is on the wrong side of the mark ${fmtPx(mark)} for a ${pos.side}: it would trigger at once`);
  }
  if (pos.liqPx != null && (long ? action.px <= pos.liqPx : action.px >= pos.liqPx)) {
    t.warnings.push(`stop ${fmtPx(action.px)} is beyond the liquidation price ${fmtPx(pos.liqPx)}`);
  }
  const riskUsd = pos.size * Math.abs(mark - action.px);
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
 * Re-quotes a ticket at confirm time (same id). "changed" when the mark moved
 * more than 0.5%, the size changed, sendability or the governor verdict
 * flipped, or the blockers differ; the UI must then ask for another `y`.
 */
export async function requote(t: Ticket, deps: TicketDeps): Promise<Requote> {
  const next = await buildTicket(baseAction(t.action), { ...deps, id: () => t.id });
  const why: string[] = [];
  if (t.markPx != null && next.markPx != null) {
    const move = (next.markPx - t.markPx) / t.markPx;
    if (Math.abs(move) > REQUOTE_MOVE) why.push(`mark moved ${move > 0 ? "+" : ""}${r2(move * 100)}% (${fmtPx(t.markPx)} → ${fmtPx(next.markPx)})`);
  } else if (t.markPx !== next.markPx) why.push("mark unavailable");
  if (t.size !== next.size) why.push(`size ${t.size ?? "—"} → ${next.size ?? "—"}`);
  if ((t.verdict?.approved ?? null) !== (next.verdict?.approved ?? null)) why.push(`governor ${t.verdict?.approved ? "PASS" : "REJECTED"} → ${next.verdict?.approved ? "PASS" : "REJECTED"}`);
  if (t.canSend !== next.canSend) why.push(next.canSend ? "now sendable" : "now blocked");
  if (!sameList(t.blockers, next.blockers)) why.push("blockers changed");
  return why.length ? { kind: "changed", ticket: next, why: why.join("; ") } : { kind: "same", ticket: next };
}

