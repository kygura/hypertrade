import { fmtUsd } from "../../shared/format.js";
import type { OrderIntent, OrderPreview } from "../../shared/intel.js";
import type { Candle } from "../../shared/types.js";
import { atr } from "../desk/analytics.js";
import { floorToDecimals } from "../desk/governor.js";
import { round } from "./util.js";

// Intent -> exact numbers. Pure, so the terminal companion can import it
// without the db or the Desk service; copilot.ts re-exports it.

const DAY = 86_400_000;
/** Hyperliquid prices carry at most 5 significant figures. */
const sig5 = (x: number) => Number(x.toPrecision(5));
const px = (x: number) => x.toLocaleString("en-US", { maximumSignificantDigits: 6 });

export interface OrderMarket {
  /** The venue's coin name. */
  coin: string;
  markPx: number;
  /** The coin's venue maximum; 0 when unknown (no clamp, no liquidation estimate). */
  maxLeverage: number;
  szDecimals: number;
  /** Desk equity: the book that pctBook and riskPct refer to. */
  equityUsd: number;
  /** Daily candles; the one still open at `now` is ignored. */
  daily: Candle[];
  now: Date;
}

export type Resolution =
  | { ok: true; resolved: OrderPreview["resolved"]; leverage: number; warnings: string[]; notes: string[] }
  | { ok: false; error: string; field: string };

/**
 * Turns an intent into exact numbers at the given market. Pure.
 *
 * Liquidation is an approximation of Hyperliquid isolated margin: maintenance
 * margin rate mmr = 1 / (2 · maxLeverage), long liq = entry · (1 − 1/lev + mmr),
 * short liq = entry · (1 + 1/lev − mmr). It ignores fees, funding and the
 * venue's tiered margin tables.
 */
export function resolveOrder(intent: OrderIntent, m: OrderMarket): Resolution {
  const fail = (field: string, error: string): Resolution => ({ ok: false, error, field });
  const warnings: string[] = [];
  const notes: string[] = [];
  const long = intent.side === "long";
  const loss = long ? "below" : "above";
  if (!(m.markPx > 0)) return fail("asset", `no mark price for ${m.coin}`);
  if (!(m.equityUsd > 0)) return fail("size", "Desk equity is unavailable, so the order cannot be sized against the book");

  const entryPx = intent.entry.type === "limit" ? intent.entry.px : m.markPx;
  notes.push(intent.entry.type === "limit" ? `entry = limit ${px(entryPx)}` : `entry = market, resolved at mark ${px(entryPx)}`);

  const nowMs = m.now.getTime();
  const complete = m.daily.filter((c) => c.t + DAY <= nowMs).sort((a, b) => a.t - b.t);
  const s = intent.stop;
  let stopPx: number;
  let how: string;
  if (s.type === "price") {
    stopPx = s.px;
    how = `stop = ${px(stopPx)} as given`;
  } else if (s.type === "pct") {
    stopPx = sig5(entryPx * (long ? 1 - s.pct / 100 : 1 + s.pct / 100));
    how = `stop = ${s.pct}% ${loss} entry: ${px(stopPx)}`;
  } else if (s.type === "atr_mult") {
    const a = atr(complete);
    if (a == null) return fail("stop", `ATR14 needs 15 complete daily candles for ${m.coin}; ${complete.length} available`);
    stopPx = sig5(long ? entryPx - s.mult * a : entryPx + s.mult * a);
    how = `stop = ${s.mult} × ATR14 (1d) ${px(a)} ${loss} entry: ${px(stopPx)}`;
  } else {
    const c = complete.at(-1);
    if (!c) return fail("stop", `no complete daily candle for ${m.coin}`);
    const day = new Date(c.t).toISOString().slice(0, 10);
    const yesterday = c.t === Math.floor(nowMs / DAY) * DAY - DAY;
    if (!yesterday) warnings.push(`no daily candle for yesterday: the ${day} candle was used`);
    const low = s.type === "prev_day_low";
    stopPx = low ? c.l : c.h;
    how = `stop = ${yesterday ? "yesterday's" : "previous daily"} ${low ? "low" : "high"} ${px(stopPx)} (${day} UTC candle)`;
  }
  if (!(stopPx > 0)) return fail("stop", `stop resolves to ${px(stopPx)}, not a price`);
  if (long ? !(stopPx < entryPx) : !(stopPx > entryPx)) {
    return fail("stop", `stop ${px(stopPx)} is on the wrong side of entry ${px(entryPx)}: a ${intent.side} needs it ${loss}`);
  }
  const stopDistPct = (Math.abs(entryPx - stopPx) / entryPx) * 100;
  notes.push(`${how} (${long ? "−" : "+"}${stopDistPct.toFixed(2)}% from entry)`);

  // pctBook is rounded to whole dollars so small equity drift between preview and confirm keeps the same order.
  const notionalUsd = "usd" in intent.size ? round(intent.size.usd, 2) : Math.round((intent.size.pctBook / 100) * m.equityUsd);
  if ("pctBook" in intent.size) notes.push(`size = ${intent.size.pctBook}% of the Desk book (${fmtUsd(m.equityUsd)}) as notional: ${fmtUsd(notionalUsd)}`);
  const size = floorToDecimals(notionalUsd / entryPx, m.szDecimals);
  if (!(size > 0)) return fail("size", `${fmtUsd(notionalUsd)} is under one ${m.coin} size step at ${px(entryPx)}`);

  let leverage = intent.leverage;
  const maxLev = m.maxLeverage > 0 ? m.maxLeverage : null;
  if (maxLev != null && leverage > maxLev) {
    warnings.push(`leverage ${leverage}x clamped to the ${m.coin} maximum of ${maxLev}x`);
    leverage = maxLev;
  }

  let liqPx: number | null = null;
  if (maxLev != null) {
    const mmr = 1 / (2 * maxLev);
    const raw = long ? entryPx * (1 - 1 / leverage + mmr) : entryPx * (1 + 1 / leverage - mmr);
    liqPx = raw > 0 ? sig5(raw) : null;
    if (liqPx != null) {
      notes.push(`liq ≈ ${px(liqPx)} at ${leverage}x (isolated-margin approximation, maintenance margin 1/(2 × ${maxLev}))`);
      if (long ? liqPx >= stopPx : liqPx <= stopPx) warnings.push(`liquidation ≈ ${px(liqPx)} is reached before the stop ${px(stopPx)}`);
    }
  } else {
    warnings.push(`${m.coin} max leverage unknown: no liquidation estimate`);
  }

  const riskUsd = size * Math.abs(entryPx - stopPx);
  return {
    ok: true,
    resolved: { stopPx, entryPx, size, notionalUsd, liqPx, riskPct: round((riskUsd / m.equityUsd) * 100, 4), riskUsd: round(riskUsd, 2) },
    leverage,
    warnings,
    notes,
  };
}
