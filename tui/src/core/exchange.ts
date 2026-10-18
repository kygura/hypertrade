import { floorToDecimals } from "../../../src/server/desk/governor.js";
import { isPrivateKey, signL1Action } from "../../../src/server/desk/hl/signing.js";
import { cancelAction, orderAction, roundPerpPx, slippagePx, updateLeverageAction, type OrderRequest } from "../../../src/server/desk/hl/wire.js";
import { API_BASE } from "./config.js";
import { REQUOTE_MOVE, capNotionalUsd, findMarket, livePx, type CloseTicketAction, type StopTicketAction } from "./ticket.js";
import type { Config, MarketRow, SendResult, Ticket } from "./types.js";

// The money path: Hyperliquid /exchange actions, signed with the agent key.
// Mirrors src/server/desk/hl/broker.ts (leverage then one normalTpsl order
// action; monotonic nonces; `stop rejected → flatten at once`) for both
// networks. Builders are pure; createExchange owns the key and is the only
// thing that signs.
//
// Defence in depth at send time, independent of the ticket's own checks:
// canSend, network match, notional cap, mark drift since the quote, ticket
// age, one send per ticket id, one send at a time. Errors never carry the key.

export { API_BASE };

/** A ticket older than this must be re-quoted before sending. */
export const MAX_TICKET_AGE_MS = 30_000;
/**
 * The emergency flatten after a rejected stop: IOC attempts this many times the
 * configured slippage through a fresh mid (the second only for what the first
 * left open), each band capped at FLATTEN_MAX_BAND.
 */
const FLATTEN_SLIPPAGE_MULTS = [2, 5];
const FLATTEN_MAX_BAND = 0.2;

export type LeverageAction = ReturnType<typeof updateLeverageAction>;
export type OrderAction = ReturnType<typeof orderAction>;
export type CancelAction = ReturnType<typeof cancelAction>;

const fmtPx = (x: number) => x.toLocaleString("en-US", { maximumSignificantDigits: 6 });

function needMarket(t: Ticket, m: MarketRow): void {
  if (m.coin !== t.coin) throw new Error(`market ${m.coin} does not match ticket coin ${t.coin}`);
}

function needSize(t: Ticket, m: MarketRow): number {
  const sz = t.size == null ? 0 : floorToDecimals(t.size, m.szDecimals);
  if (!(sz > 0) || sz !== t.size) throw new Error(`ticket size ${t.size} is not a positive multiple of the ${m.coin} size step`);
  return sz;
}

/**
 * Open: [updateLeverage (cross, whole number, ≤ coin max), order normalTpsl
 * [entry, reduce-only market SL trigger, optional reduce-only market TP trigger]].
 * Market entry = IOC `slippage` through the live mark; `@px` entry = Gtc at the
 * ticket's venue-rounded entry. Stop/TP come from the ticket (already venue-rounded).
 */
export function buildOpenActions(t: Ticket, m: MarketRow, slippage: number): [LeverageAction, OrderAction] {
  if (t.action.kind !== "open") throw new Error(`not an open ticket (${t.action.kind})`);
  needMarket(t, m);
  if (t.side == null || t.stopPx == null || t.leverage == null) throw new Error("open ticket is missing side, stop or leverage");
  const sz = needSize(t, m);
  const intent = t.action.intent;
  if (intent.entry.type === "limit" && t.entryPx == null) throw new Error("limit ticket has no entry price");
  const isBuy = t.side === "long";
  const leverage = Math.max(1, Math.min(Math.floor(t.leverage), m.maxLeverage > 0 ? m.maxLeverage : 1));
  const entry: OrderRequest =
    intent.entry.type === "limit"
      ? { asset: m.asset, isBuy, limitPx: roundPerpPx(t.entryPx!, m.szDecimals), sz, reduceOnly: false, orderType: { limit: { tif: "Gtc" } } }
      : { asset: m.asset, isBuy, limitPx: slippagePx(livePx(m), isBuy, slippage, m.szDecimals), sz, reduceOnly: false, orderType: { limit: { tif: "Ioc" } } };
  const legs: OrderRequest[] = [entry, trigger(m, !isBuy, t.stopPx, sz, "sl", slippage)];
  if (t.tpPx != null) legs.push(trigger(m, !isBuy, t.tpPx, sz, "tp", slippage));
  return [updateLeverageAction(m.asset, true, leverage), orderAction(legs, "normalTpsl")];
}

function trigger(m: MarketRow, isBuy: boolean, px: number, sz: number, tpsl: "sl" | "tp", slippage: number): OrderRequest {
  return {
    asset: m.asset,
    isBuy,
    limitPx: slippagePx(px, isBuy, slippage, m.szDecimals),
    sz,
    reduceOnly: true,
    orderType: { trigger: { isMarket: true, triggerPx: roundPerpPx(px, m.szDecimals), tpsl } },
  };
}

/** Close: one reduce-only IOC `slippage` through the live mark, opposite the position side. */
export function buildCloseAction(t: Ticket, m: MarketRow, slippage: number): OrderAction {
  if (t.action.kind !== "close") throw new Error(`not a close ticket (${t.action.kind})`);
  needMarket(t, m);
  if (t.side == null) throw new Error("close ticket has no position side");
  const sz = needSize(t, m);
  const isBuy = t.side === "short";
  return orderAction([{ asset: m.asset, isBuy, limitPx: slippagePx(livePx(m), isBuy, slippage, m.szDecimals), sz, reduceOnly: true, orderType: { limit: { tif: "Ioc" } } }]);
}

/** Cancel: one cancel action; each oid gets its own coin's asset index. */
export function buildCancelAction(t: Ticket, markets: MarketRow[]): CancelAction {
  if (t.action.kind !== "cancel") throw new Error(`not a cancel ticket (${t.action.kind})`);
  if (!t.action.oids.length) throw new Error("no orders to cancel");
  return cancelAction(
    t.action.oids.map(({ coin, oid }) => {
      const m = findMarket(markets, coin);
      if (!m) throw new Error(`${coin} is not a listed market`);
      return { asset: m.asset, oid };
    }),
  );
}

/**
 * Stop: [place the new reduce-only market SL (positionTpsl, full position size),
 * cancel the old SL oids or null]. Sent in that order, so a rejected new stop
 * leaves the old one in place.
 */
export function buildStopActions(t: Ticket, m: MarketRow, slippage: number): [OrderAction, CancelAction | null] {
  if (t.action.kind !== "stop") throw new Error(`not a stop ticket (${t.action.kind})`);
  needMarket(t, m);
  if (t.side == null || t.stopPx == null) throw new Error("stop ticket has no position side or stop price");
  const sz = needSize(t, m);
  const old = (t.action as StopTicketAction).replaceOids ?? [];
  const place = orderAction([trigger(m, t.side === "short", t.stopPx, sz, "sl", slippage)], "positionTpsl");
  return [place, old.length ? cancelAction(old.map((oid) => ({ asset: m.asset, oid }))) : null];
}

// ─── response parsing ───

type Status = { filled: { totalSz: string; avgPx: string; oid: number } } | { resting: { oid: number } } | { error: string } | string;
type Parsed = { ok: true; statuses: Status[] } | { ok: false; error: string };

/** Status strings Hyperliquid returns for accepted TP/SL children of a normalTpsl parent. */
const PENDING_STRINGS = new Set(["waitingForFill", "waitingForTrigger"]);

function parseStatuses(raw: unknown, type: "order" | "cancel"): Parsed {
  const r = raw as { status?: unknown; response?: unknown } | null;
  if (!r || r.status !== "ok") return { ok: false, error: typeof r?.response === "string" ? r.response : "exchange returned an error" };
  const resp = r.response as { type?: unknown; data?: { statuses?: unknown } } | undefined;
  if (resp?.type !== type || !Array.isArray(resp.data?.statuses)) return { ok: false, error: `unexpected ${type} response` };
  return { ok: true, statuses: resp.data.statuses as Status[] };
}

const isObj = (s: Status | undefined): s is Exclude<Status, string> => s != null && typeof s === "object";
const filled = (s: Status | undefined) => (isObj(s) && "filled" in s && s.filled ? s.filled : null);
const restingOid = (s: Status | undefined) => (isObj(s) && "resting" in s && s.resting ? s.resting.oid : null);
/** Null when the leg was accepted (resting, filled, or a pending tpsl child); else the reason. */
function legError(s: Status | undefined): string | null {
  if (s == null) return "no status returned";
  if (typeof s === "string") return PENDING_STRINGS.has(s) ? null : s;
  if ("error" in s) return String(s.error);
  if ("resting" in s || "filled" in s) return null;
  return "unrecognised status";
}

// ─── sender ───

export interface Exchange {
  /** Signs and sends a ticket. Never throws; never sends a ticket with canSend false. `markets` may be one row or the full list (cancels span coins). */
  send(t: Ticket, markets: MarketRow | MarketRow[]): Promise<SendResult>;
}

export interface ExchangeOptions {
  fetchFn?: typeof fetch;
  /** Nonce and ticket-age clock, ms. */
  now?: () => number;
  /** Trade for a vault/sub-account (signed and posted); default none. */
  vaultAddress?: string;
}

/** Null when there is no valid key, the config cannot trade, or this is a demo. */
export function createExchange(config: Config, agentKey: string | null, opts: ExchangeOptions = {}): Exchange | null {
  if (config.demo || !config.canTrade || !agentKey || !isPrivateKey(agentKey)) return null;
  const vault = opts.vaultAddress?.trim().toLowerCase() ?? null;
  if (vault != null && !/^0x[0-9a-f]{40}$/.test(vault)) throw new Error("vaultAddress is not a 0x-prefixed 40-hex address");
  const key = agentKey.trim();
  const keyHex = key.replace(/^0x/i, "").toLowerCase();
  const isMainnet = config.network === "mainnet";
  const base = API_BASE[config.network];
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  let lastNonce = 0;
  let busy = false;
  const sent = new Set<string>();

  /** Error text, with the key scrubbed should any upstream message ever contain it. */
  const safe = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.replace(new RegExp(`(0x)?${keyHex}`, "gi"), "[redacted]");
  };

  async function post(action: unknown): Promise<unknown> {
    const nonce = Math.max(now(), lastNonce + 1);
    lastNonce = nonce;
    const signature = signL1Action(key, action, vault, nonce, null, isMainnet);
    const r = await fetchFn(`${base}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, nonce, signature, vaultAddress: vault, expiresAfter: null }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HL ${config.network} /exchange HTTP ${r.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`HL ${config.network} /exchange returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  /** Unsigned /info read on the same network. */
  async function postInfo<T>(body: { type: string } & Record<string, unknown>): Promise<T> {
    const r = await fetchFn(`${base}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HL ${config.network} /info HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  /** A fresh mid: allMids, else the l2Book's best bid/ask; null when neither answers. */
  async function freshMid(coin: string): Promise<number | null> {
    try {
      const mids = await postInfo<Record<string, string>>({ type: "allMids" });
      const mid = Number(mids?.[coin]);
      if (mid > 0) return mid;
    } catch {
      // fall through to the book
    }
    try {
      const b = await postInfo<{ levels?: Array<Array<{ px: string }>> }>({ type: "l2Book", coin });
      const bid = Number(b?.levels?.[0]?.[0]?.px);
      const ask = Number(b?.levels?.[1]?.[0]?.px);
      if (bid > 0 && ask > 0) return (bid + ask) / 2;
    } catch {
      // no fresh price
    }
    return null;
  }

  /** Signed size of `coin` on the traded account right now (0 = flat). Throws when it cannot be read. */
  async function positionSize(coin: string): Promise<number> {
    const user = vault ?? config.account;
    if (!user) throw new Error("no account configured");
    const st = await postInfo<{ assetPositions?: Array<{ position?: { coin?: string; szi?: string } }> }>({ type: "clearinghouseState", user });
    if (!Array.isArray(st?.assetPositions)) throw new Error("unexpected clearinghouseState response");
    const p = st.assetPositions.find((x) => x.position?.coin === coin);
    const szi = Number(p?.position?.szi ?? 0);
    if (!Number.isFinite(szi)) throw new Error("unreadable position size");
    return szi;
  }

  /**
   * Reduce-only IOC closes of `size` after a rejected stop: each attempt is
   * anchored to a fresh mid (fallback: the entry fill price) and retried once,
   * with a wider band, for whatever is still open. Returns the size left open.
   */
  async function flatten(m: MarketRow, closeIsBuy: boolean, size: number, fallbackPx: number, out: SendResult): Promise<number> {
    let left = size;
    for (const mult of FLATTEN_SLIPPAGE_MULTS) {
      if (left <= 1e-12) break;
      const anchor = (await freshMid(m.coin)) ?? fallbackPx;
      const band = Math.min(config.slippage * mult, FLATTEN_MAX_BAND);
      const sz = floorToDecimals(left, m.szDecimals);
      if (!(sz > 0)) break;
      try {
        const fp = parseStatuses(
          await post(orderAction([{ asset: m.asset, isBuy: closeIsBuy, limitPx: slippagePx(anchor, closeIsBuy, band, m.szDecimals), sz, reduceOnly: true, orderType: { limit: { tif: "Ioc" } } }])),
          "order",
        );
        const ff = fp.ok ? filled(fp.statuses[0]) : null;
        if (ff) {
          left -= Number(ff.totalSz);
          out.lines.push(`flattened ${ff.totalSz} ${m.coin} @ ${fmtPx(Number(ff.avgPx))} (oid ${ff.oid}, ±${Math.round(band * 1000) / 10}% band)`);
          out.oids.push(ff.oid);
        } else {
          out.errors.push(`flatten attempt at ±${Math.round(band * 1000) / 10}% not filled (${fp.ok ? (legError(fp.statuses[0]) ?? "IOC did not cross") : fp.error})`);
        }
      } catch (e) {
        out.errors.push(`flatten attempt at ±${Math.round(band * 1000) / 10}% failed (${safe(e)})`);
      }
    }
    return Math.max(0, left);
  }

  async function cancelOids(m: MarketRow, oids: number[], label: string, out: SendResult): Promise<boolean> {
    if (!oids.length) return true;
    try {
      const p = parseStatuses(await post(cancelAction(oids.map((oid) => ({ asset: m.asset, oid })))), "cancel");
      if (!p.ok) {
        out.errors.push(`could not cancel ${label} ${oids.join(", ")}: ${p.error}`);
        return false;
      }
      let all = true;
      oids.forEach((oid, i) => {
        const s = p.statuses[i];
        if (s === "success") out.lines.push(`cancelled ${label} oid ${oid}`);
        else {
          all = false;
          out.errors.push(`could not cancel ${label} oid ${oid}: ${legError(s) ?? "unknown"}`);
        }
      });
      return all;
    } catch (e) {
      out.errors.push(`could not cancel ${label} ${oids.join(", ")}: ${safe(e)}`);
      return false;
    }
  }

  function preflight(t: Ticket, m: MarketRow | null): string | null {
    if (!t.canSend || t.blockers.length) return `ticket is blocked: ${t.blockers.join("; ") || "canSend is false"}`;
    if (t.network !== config.network) return `ticket was quoted on ${t.network}, this exchange sends to ${config.network}`;
    if (sent.has(t.id)) return `ticket ${t.id} was already sent`;
    if (now() - t.quotedAt > MAX_TICKET_AGE_MS) return `ticket quoted ${Math.round((now() - t.quotedAt) / 1000)}s ago: re-quote before sending`;
    if (t.action.kind === "cancel") return null;
    if (!m) return `${t.coin} is not a listed market`;
    const mark = livePx(m);
    if (!(mark > 0)) return `no mark for ${m.coin}`;
    if (t.markPx != null && Math.abs(mark / t.markPx - 1) > REQUOTE_MOVE) return `mark moved from ${fmtPx(t.markPx)} to ${fmtPx(mark)} since the quote: re-quote`;
    if (t.action.kind === "open") {
      if (m.isDelisted) return `${m.coin} is delisted`;
      if (t.size == null || t.stopPx == null) return "open ticket has no size or stop";
      const limit = t.action.intent.entry.type === "limit";
      if (limit && t.entryPx == null) return "limit ticket has no entry price";
      const notional = Math.max(capNotionalUsd(t.size, limit ? t.entryPx : null, mark, config.slippage), t.notionalUsd ?? 0);
      if (!(notional <= config.maxNotionalUsd)) return `notional $${notional.toFixed(2)} exceeds HT_MAX_NOTIONAL_USD $${config.maxNotionalUsd}`;
      const long = t.side === "long";
      if (long ? !(t.stopPx < mark) : !(t.stopPx > mark)) return `stop ${fmtPx(t.stopPx)} is on the wrong side of the mark ${fmtPx(mark)}`;
      if (t.tpPx != null && (long ? !(t.tpPx > mark) : !(t.tpPx < mark))) return `take-profit ${fmtPx(t.tpPx)} is on the wrong side of the mark ${fmtPx(mark)}`;
    }
    if (t.action.kind === "stop") {
      const long = t.side === "long";
      if (t.stopPx == null) return "stop ticket has no stop price";
      if (long ? !(t.stopPx < mark) : !(t.stopPx > mark)) return `stop ${fmtPx(t.stopPx)} is on the wrong side of the mark ${fmtPx(mark)}`;
    }
    return null;
  }

  async function sendOpen(t: Ticket, m: MarketRow, out: SendResult): Promise<void> {
    const [lev, order] = buildOpenActions(t, m, config.slippage);
    let levRes: { status?: unknown; response?: unknown } | null;
    try {
      levRes = (await post(lev)) as typeof levRes;
    } catch (e) {
      out.errors.push(`leverage update failed (${safe(e)}); nothing was ordered`);
      return;
    }
    if (levRes?.status !== "ok") {
      out.errors.push(`leverage update rejected: ${typeof levRes?.response === "string" ? levRes.response : "exchange error"}; nothing was ordered`);
      return;
    }
    out.lines.push(`leverage ${lev.leverage}x cross set on ${m.coin}`);

    let raw: unknown;
    try {
      raw = await post(order);
    } catch (e) {
      out.errors.push(`order status unknown (${safe(e)}): check /pos before retrying`);
      return;
    }
    const p = parseStatuses(raw, "order");
    if (!p.ok) {
      out.errors.push(`order rejected: ${p.error}`);
      return;
    }
    const isBuy = t.side === "long";
    const [entry, stop, tp] = p.statuses;
    const hasTp = t.tpPx != null;
    const fill = filled(entry);
    const entryOid = fill?.oid ?? restingOid(entry);
    const childOids = [restingOid(stop), hasTp ? restingOid(tp) : null].filter((x): x is number => x != null);

    if (!fill && entryOid == null) {
      out.errors.push(`entry not filled: ${legError(entry) ?? "IOC did not cross"}`);
      await cancelOids(m, childOids, "orphaned trigger", out);
      return;
    }
    if (fill) {
      const sz = Number(fill.totalSz);
      out.lines.push(`filled ${fill.totalSz} ${m.coin} @ ${fmtPx(Number(fill.avgPx))} (oid ${fill.oid})`);
      if (sz < (t.size ?? 0) - 1e-12) out.lines.push(`partial fill: ${fill.totalSz} of ${t.size} ${m.coin}`);
    } else out.lines.push(`entry resting oid ${entryOid} @ ${fmtPx(t.entryPx ?? 0)}`);
    out.oids.push(entryOid!);

    const stopErr = legError(stop);
    if (stopErr) {
      out.errors.push(`stop order rejected (${stopErr})`);
      const tpOids = hasTp && restingOid(tp) != null ? [restingOid(tp)!] : [];
      if (fill) {
        // No exchange-side stop: flatten now rather than hold it unprotected.
        const sz = Number(fill.totalSz);
        const left = await flatten(m, !isBuy, sz, Number(fill.avgPx), out);
        if (left > 1e-12) {
          // Keep the take-profit: it is the only exchange-side order still reducing the position.
          out.errors.push(`FLATTEN FAILED: ${Math.round(left * 1e8) / 1e8} of ${sz} ${m.coin} is open WITHOUT a stop${tpOids.length ? "; take-profit kept" : ""}: act now`);
          return;
        }
      } else {
        // A resting entry without its stop must not be allowed to fill.
        const ok = await cancelOids(m, [entryOid!], "entry", out);
        if (!ok) out.errors.push(`entry oid ${entryOid} may still rest WITHOUT a stop: cancel it now`);
      }
      await cancelOids(m, tpOids, "take-profit", out);
      return;
    }
    const sOid = restingOid(stop);
    out.lines.push(sOid != null ? `stop oid ${sOid} resting @ ${fmtPx(t.stopPx!)}` : `stop accepted @ ${fmtPx(t.stopPx!)} (${stop as string})`);
    if (sOid != null) out.oids.push(sOid);
    if (hasTp) {
      const tpErr = legError(tp);
      const tOid = restingOid(tp);
      if (tpErr) out.errors.push(`take-profit rejected (${tpErr}); the stop is live`);
      else out.lines.push(tOid != null ? `take-profit oid ${tOid} resting @ ${fmtPx(t.tpPx!)}` : `take-profit accepted @ ${fmtPx(t.tpPx!)} (${tp as string})`);
      if (tOid != null) out.oids.push(tOid);
    }
    out.ok = true;
  }

  async function sendClose(t: Ticket, m: MarketRow, out: SendResult): Promise<void> {
    let raw: unknown;
    try {
      raw = await post(buildCloseAction(t, m, config.slippage));
    } catch (e) {
      out.errors.push(`close status unknown (${safe(e)}): check /pos before retrying`);
      return;
    }
    const p = parseStatuses(raw, "order");
    if (!p.ok) {
      out.errors.push(`close rejected: ${p.error}`);
      return;
    }
    const f = filled(p.statuses[0]);
    if (!f) {
      out.errors.push(`close not filled: ${legError(p.statuses[0]) ?? "IOC did not cross"}`);
      return;
    }
    out.lines.push(`closed ${f.totalSz} ${m.coin} @ ${fmtPx(Number(f.avgPx))} (oid ${f.oid})`);
    out.oids.push(f.oid);
    const action = t.action as CloseTicketAction;
    const complete = Number(f.totalSz) >= (t.size ?? Infinity) - 1e-12;
    out.ok = complete;
    if (!complete) out.errors.push(`partial close: ${f.totalSz} of ${t.size} ${m.coin} filled`);
    const leftovers = action.cleanupOids ?? [];
    if (action.pct < 100 || !leftovers.length) return;
    // Cancel leftover reduce-only triggers only once the venue confirms the position is flat.
    let szi: number;
    try {
      szi = await positionSize(m.coin);
    } catch (e) {
      out.errors.push(`could not confirm ${m.coin} is flat (${safe(e)}): triggers kept`);
      return;
    }
    if (szi !== 0) {
      out.lines.push(`${m.coin}: position remains, triggers kept (${Math.abs(szi)} still open)`);
      return;
    }
    await cancelOids(m, leftovers, "leftover trigger", out);
  }

  async function sendStop(t: Ticket, m: MarketRow, out: SendResult): Promise<void> {
    const [place, cancel] = buildStopActions(t, m, config.slippage);
    let raw: unknown;
    try {
      raw = await post(place);
    } catch (e) {
      out.errors.push(`new stop status unknown (${safe(e)}): old stop left in place; check /pos`);
      return;
    }
    const p = parseStatuses(raw, "order");
    const err = p.ok ? legError(p.statuses[0]) : p.error;
    if (err) {
      out.errors.push(`new stop rejected (${err}); the old stop is left in place`);
      return;
    }
    const oid = p.ok ? restingOid(p.statuses[0]) : null;
    out.lines.push(oid != null ? `stop oid ${oid} resting @ ${fmtPx(t.stopPx!)}` : `stop accepted @ ${fmtPx(t.stopPx!)}`);
    if (oid != null) out.oids.push(oid);
    out.ok = true;
    if (cancel) await cancelOids(m, cancel.cancels.map((c) => c.o), "old stop", out);
  }

  async function sendCancel(t: Ticket, markets: MarketRow[], out: SendResult): Promise<void> {
    const action = buildCancelAction(t, markets);
    let raw: unknown;
    try {
      raw = await post(action);
    } catch (e) {
      out.errors.push(`cancel status unknown (${safe(e)}): check /pos`);
      return;
    }
    const p = parseStatuses(raw, "cancel");
    if (!p.ok) {
      out.errors.push(`cancel rejected: ${p.error}`);
      return;
    }
    let all = true;
    action.cancels.forEach((c, i) => {
      const s = p.statuses[i];
      if (s === "success") {
        out.lines.push(`cancelled oid ${c.o}`);
        out.oids.push(c.o);
      } else {
        all = false;
        out.errors.push(`oid ${c.o} not cancelled: ${legError(s) ?? "unknown"}`);
      }
    });
    out.ok = all;
  }

  return {
    async send(t, markets) {
      const out: SendResult = { ok: false, lines: [], errors: [], oids: [] };
      const list = Array.isArray(markets) ? markets : [markets];
      const m = t.action.kind === "cancel" ? null : findMarket(list, t.coin);
      const refused = busy ? "another order is being sent" : preflight(t, m);
      if (refused) {
        out.errors.push(`not sent: ${refused}`);
        return out;
      }
      busy = true;
      sent.add(t.id);
      try {
        switch (t.action.kind) {
          case "open":
            await sendOpen(t, m!, out);
            break;
          case "close":
            await sendClose(t, m!, out);
            break;
          case "stop":
            await sendStop(t, m!, out);
            break;
          case "cancel":
            await sendCancel(t, list, out);
            break;
        }
      } catch (e) {
        out.ok = false;
        out.errors.push(safe(e));
      } finally {
        busy = false;
      }
      return out;
    },
  };
}
