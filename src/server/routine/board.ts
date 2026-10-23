import { z } from "zod";
import type { FundingPoint } from "../../shared/hl-client.js";
import type { AssetCtx, Candle } from "../../shared/types.js";
import { median } from "../intel/util.js";
import { robustSigma } from "../intel/windows.js";
import { sma } from "./htf.js";

// The board (docs/fallback-routine.md § Board): the top-N Hyperliquid perps,
// each read on its 4h, 1d and 1w bars plus positioning, measured here. Pure.
// The model reads these numbers and picks levels from `levels` by key; it
// never computes a number or invents a price. Structure is read on completed
// bars only (a forming bar is not a close); the mark is the live price.

export const BOARD = {
  /** Markets by 24 h notional volume, before the majors and "my markets" are added. */
  top: 30,
  /** OI floor for the top-N pick; majors and "my markets" skip it. */
  minOiUsd: 5_000_000,
  /** Bars in the range window per timeframe. */
  window: { "4h": 20, "1d": 20, "1w": 12 },
  /** Committed snapshot history (data/board/history.json) kept for OI and funding deltas. */
  historyDays: 8,
  /** HL funding carries a fixed interest component of 0.01% per 8 h: "neutral" funding reads ~10.95% annualised, not 0. */
  baselineFundingAnnPct: 10.95,
} as const;

export const BOARD_TFS = ["4h", "1d", "1w"] as const;
export type BoardTf = (typeof BOARD_TFS)[number];
export type Trend = "up" | "down" | "range";

/** The level menu: every price a setup may reference, by key (src/server/routine/scan.ts resolves them). */
export const LEVEL_KEYS = [
  "mark",
  "4h.high20",
  "4h.low20",
  "4h.sma20",
  "1d.pdh",
  "1d.pdl",
  "1d.high20",
  "1d.low20",
  "1d.sma20",
  "1d.sma50",
  "1d.sma200",
  "1w.pwh",
  "1w.pwl",
  "1w.high12",
  "1w.low12",
  "1w.sma20",
] as const;
export type LevelKey = (typeof LEVEL_KEYS)[number];

export interface TfRead {
  /** Completed bars available. */
  bars: number;
  /** Last completed close. */
  close: number;
  /** ATR14 (mean true range of the last 14 completed bars) and as % of the close. */
  atr: number | null;
  atrPct: number | null;
  sma20: number | null;
  sma50: number | null;
  /** (mark − SMA20) in ATRs. */
  vsSma20Atr: number | null;
  /** up: close > SMA20 > SMA50 and SMA20 up at least 0.25 ATR over 5 bars; down mirrored; else range. Null below 25 bars. */
  trend: Trend | null;
  /** High/low of the window before the last completed bar: the range a breakout is measured against. */
  high: number | null;
  low: number | null;
  /** Mark inside the range that includes the last completed bar: 0 = at the low, 1 = at the high. */
  rangePos: number | null;
  /** Last completed bar closed beyond the prior range. */
  breakout: "up" | "down" | null;
  /** Last completed bar traded beyond the prior range and closed back inside it. */
  sweep: "high" | "low" | null;
  /** Last completed bar's volume over the window's mean volume. */
  volRatio: number | null;
  /** ATR5 / ATR20: below ~0.7 reads as compression, above ~1.3 as expansion. */
  atrRatio: number | null;
}

export type Flow = "new_longs" | "short_covering" | "new_shorts" | "long_liquidation" | "oi_build_flat" | "oi_unwind_flat" | "price_only" | "quiet";

export interface Positioning {
  /** Current hourly funding annualised, percent. Neutral on HL is ~10.95 (BOARD.baselineFundingAnnPct). */
  fundingAnnPct: number;
  funding24hAnnPct: number | null;
  funding7dAnnPct: number | null;
  /** Share of the last 7 d of hourly settlements at or below the current rate, 0–100. */
  fundingPctile7d: number | null;
  /** Mean predicted funding on Binance and Bybit, annualised percent, and HL minus it. */
  cexFundingAnnPct: number | null;
  fundingVsCexAnnPct: number | null;
  /** Mark over oracle, basis points. */
  premiumBps: number;
  oiUsd: number;
  volUsd24h: number;
  /** OI over 24 h notional volume: high = positions held, not traded. */
  oiToVol: number | null;
  /** OI change in contracts (price-neutral), from the committed board history. Null until the history reaches back. */
  oiChg4hPct: number | null;
  oiChg24hPct: number | null;
  oiChg7dPct: number | null;
  ret4hPct: number | null;
  ret24hPct: number | null;
  ret7dPct: number | null;
  /** 24 h price × OI quadrant (|price| ≥ 1%, |OI| ≥ 2% count as a move). Null without OI history. */
  flow24h: Flow | null;
}

export interface BoardRow {
  coin: string;
  mark: number;
  tf: Record<BoardTf, TfRead | null>;
  pos: Positioning;
  /** Return minus BTC's over the same window, percentage points. */
  rs: { vsBtc24hPct: number | null; vsBtc7dPct: number | null };
  /** Cross-sectional robust z against the rest of the board (median/MAD). */
  xs: { fundingZ: number | null; oiChg24hZ: number | null; ret24hZ: number | null };
  levels: Partial<Record<LevelKey, number>>;
}

export interface BoardInput {
  ctx: AssetCtx;
  c4h: Candle[] | null;
  c1d: Candle[] | null;
  /** Hourly funding settlements, oldest first. */
  funding: FundingPoint[] | null;
  /** Predicted hourly funding on other venues (Binance, Bybit), as fractions. */
  cexHourly: number[];
}

export interface Board {
  asOf: string;
  rows: BoardRow[];
  /** How far back the OI history reaches. */
  history: { snapshots: number; oldest: string | null };
}

export const BoardHistorySchema = z.object({
  updated_at: z.string(),
  /** rows: coin → [mark, OI in contracts, hourly funding]. */
  snapshots: z.array(z.object({ t: z.string(), rows: z.record(z.tuple([z.number(), z.number(), z.number()])) })),
});
export type BoardHistory = z.infer<typeof BoardHistorySchema>;

const H = 3_600_000;
const DAY = 24 * H;
const ANN = 24 * 365 * 100;

/** Prices to 5 significant figures (Hyperliquid's own price precision); everything else to 2 dp. */
export const sig = (x: number, n = 5) => (x === 0 || !Number.isFinite(x) ? x : Number(x.toPrecision(n)));
const r2 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (a: number, b: number) => ((a - b) / b) * 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Daily candles grouped into ISO weeks (Monday 00:00 UTC). The current week is forming: its T lies in the future. */
export function weeklyFromDaily(daily: Candle[]): Candle[] {
  const weeks = new Map<number, Candle>();
  for (const c of [...daily].sort((a, b) => a.t - b.t)) {
    const d = new Date(c.t);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
    const w = weeks.get(start);
    if (!w) weeks.set(start, { t: start, T: start + 7 * DAY - 1, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    else weeks.set(start, { ...w, h: Math.max(w.h, c.h), l: Math.min(w.l, c.l), c: c.c, v: w.v + c.v });
  }
  return [...weeks.values()];
}

function meanTrueRange(bars: Candle[], n: number): number | null {
  if (bars.length < n + 1) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const c = bars[i]!;
    const prev = bars[i - 1]!.c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  }
  return sum / n;
}

/** One timeframe's structure from its candles; only bars closed before `now` count. Null with fewer than window + 2 bars. */
export function tfRead(candles: Candle[], window: number, mark: number, now: number): TfRead | null {
  const done = candles.filter((c) => c.T < now).sort((a, b) => a.t - b.t);
  if (done.length < window + 2) return null;
  const last = done.at(-1)!;
  const prior = done.slice(-1 - window, -1);
  const high = Math.max(...prior.map((c) => c.h));
  const low = Math.min(...prior.map((c) => c.l));
  const atr = meanTrueRange(done, 14);
  const atr5 = meanTrueRange(done, 5);
  const atr20 = meanTrueRange(done, 20);
  const sma20 = sma(done, 20);
  const sma50 = sma(done, 50);
  const sma20Prev = sma(done, 20, 5);
  let trend: Trend | null = null;
  if (done.length >= 25 && sma20 !== null && sma20Prev !== null && atr) {
    // A slope under a quarter ATR over 5 bars is drift, not a trend.
    const slope = (sma20 - sma20Prev) / atr;
    if (last.c > sma20 && (sma50 === null || sma20 > sma50) && slope >= 0.25) trend = "up";
    else if (last.c < sma20 && (sma50 === null || sma20 < sma50) && slope <= -0.25) trend = "down";
    else trend = "range";
  }
  const hi = Math.max(high, last.h);
  const lo = Math.min(low, last.l);
  const meanVol = mean(prior.map((c) => c.v));
  return {
    bars: done.length,
    close: sig(last.c),
    atr: atr === null ? null : sig(atr, 4),
    atrPct: atr === null ? null : r2((atr / last.c) * 100),
    sma20: sma20 === null ? null : sig(sma20),
    sma50: sma50 === null ? null : sig(sma50),
    vsSma20Atr: sma20 === null || !atr ? null : r2((mark - sma20) / atr),
    trend,
    high: sig(high),
    low: sig(low),
    rangePos: hi > lo ? r2((mark - lo) / (hi - lo)) : null,
    breakout: last.c > high ? "up" : last.c < low ? "down" : null,
    sweep: last.h > high && last.c <= high ? "high" : last.l < low && last.c >= low ? "low" : null,
    volRatio: meanVol ? r2(last.v / meanVol) : null,
    atrRatio: atr5 !== null && atr20 ? r2(atr5 / atr20) : null,
  };
}

/** Close of the last completed candle ending at or before `at`. */
function closeAt(candles: Candle[], at: number): number | null {
  let best: Candle | null = null;
  for (const c of candles) if (c.T <= at && (!best || c.T > best.T)) best = c;
  return best?.c ?? null;
}

/** The snapshot nearest to `at`, if one lies within `tol`. */
function snapshotNear(history: BoardHistory | null, at: number, tol: number) {
  let best: BoardHistory["snapshots"][number] | null = null;
  let bestD = Infinity;
  for (const s of history?.snapshots ?? []) {
    const d = Math.abs(Date.parse(s.t) - at);
    if (d <= tol && d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

export function flowQuadrant(retPct: number | null, oiPct: number | null): Flow | null {
  if (retPct === null || oiPct === null) return null;
  const p = Math.abs(retPct) >= 1 ? Math.sign(retPct) : 0;
  const o = Math.abs(oiPct) >= 2 ? Math.sign(oiPct) : 0;
  if (p > 0) return o > 0 ? "new_longs" : o < 0 ? "short_covering" : "price_only";
  if (p < 0) return o > 0 ? "new_shorts" : o < 0 ? "long_liquidation" : "price_only";
  return o > 0 ? "oi_build_flat" : o < 0 ? "oi_unwind_flat" : "quiet";
}

export function positioning(input: BoardInput, history: BoardHistory | null, now: number): Positioning {
  const { ctx, c4h, funding } = input;
  const mark = ctx.markPx;
  const ret = (lag: number) => {
    const c = c4h ? closeAt(c4h, now - lag) : null;
    return c ? r2(pct(mark, c)) : null;
  };
  const oiChg = (lag: number, tol: number) => {
    const row = snapshotNear(history, now - lag, tol)?.rows[ctx.name];
    return row && row[1] > 0 ? r2(pct(ctx.openInterest, row[1])) : null;
  };
  const rates = (funding ?? []).filter((f) => f.t > now - 7 * DAY);
  const day = rates.filter((f) => f.t > now - DAY).map((f) => f.rate);
  const cex = mean(input.cexHourly);
  const fundingAnnPct = r2(ctx.funding * ANN)!;
  const ret24hPct = ret(DAY) ?? r2(ctx.dayChange * 100);
  const oiChg24hPct = oiChg(DAY, 3 * H);
  return {
    fundingAnnPct,
    funding24hAnnPct: day.length ? r2(mean(day)! * ANN) : null,
    funding7dAnnPct: rates.length ? r2(mean(rates.map((f) => f.rate))! * ANN) : null,
    fundingPctile7d: rates.length ? Math.round((rates.filter((f) => f.rate <= ctx.funding).length / rates.length) * 100) : null,
    cexFundingAnnPct: cex === null ? null : r2(cex * ANN),
    fundingVsCexAnnPct: cex === null ? null : r2((ctx.funding - cex) * ANN),
    premiumBps: r2(ctx.premium * 1e4)!,
    oiUsd: Math.round(ctx.openInterest * mark),
    volUsd24h: Math.round(ctx.dayNtlVlm),
    oiToVol: ctx.dayNtlVlm > 0 ? r2((ctx.openInterest * mark) / ctx.dayNtlVlm) : null,
    oiChg4hPct: oiChg(4 * H, 1.5 * H),
    oiChg24hPct,
    oiChg7dPct: oiChg(7 * DAY, 12 * H),
    ret4hPct: ret(4 * H),
    ret24hPct,
    ret7dPct: ret(7 * DAY),
    flow24h: flowQuadrant(ret24hPct, oiChg24hPct),
  };
}

export function levelMenu(mark: number, tf: Record<BoardTf, TfRead | null>, c1d: Candle[] | null, now: number): Partial<Record<LevelKey, number>> {
  const out: Partial<Record<LevelKey, number>> = { mark: sig(mark) };
  const set = (k: LevelKey, v: number | null | undefined) => {
    if (v !== null && v !== undefined && Number.isFinite(v) && v > 0) out[k] = sig(v);
  };
  set("4h.high20", tf["4h"]?.high);
  set("4h.low20", tf["4h"]?.low);
  set("4h.sma20", tf["4h"]?.sma20);
  const doneDaily = (c1d ?? []).filter((c) => c.T < now).sort((a, b) => a.t - b.t);
  set("1d.pdh", doneDaily.at(-1)?.h);
  set("1d.pdl", doneDaily.at(-1)?.l);
  set("1d.high20", tf["1d"]?.high);
  set("1d.low20", tf["1d"]?.low);
  set("1d.sma20", tf["1d"]?.sma20);
  set("1d.sma50", tf["1d"]?.sma50);
  set("1d.sma200", sma(doneDaily, 200));
  const doneWeekly = weeklyFromDaily(c1d ?? []).filter((c) => c.T < now);
  set("1w.pwh", doneWeekly.at(-1)?.h);
  set("1w.pwl", doneWeekly.at(-1)?.l);
  set("1w.high12", tf["1w"]?.high);
  set("1w.low12", tf["1w"]?.low);
  set("1w.sma20", tf["1w"]?.sma20);
  return out;
}

/** Robust z of each value against the others (median/MAD, with a floor so a flat board does not blow up). */
function crossZ(values: Array<number | null>, floor: number): Array<number | null> {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length < 5) return values.map(() => null);
  const m = median(xs);
  const s = robustSigma(xs, floor);
  return values.map((v) => (v === null ? null : r2((v - m) / s)));
}

export function buildBoard(inputs: BoardInput[], history: BoardHistory | null, now: Date): Board {
  const t = now.getTime();
  const rows: BoardRow[] = inputs.map((input) => {
    const mark = input.ctx.markPx;
    const tf: Record<BoardTf, TfRead | null> = {
      "4h": input.c4h ? tfRead(input.c4h, BOARD.window["4h"], mark, t) : null,
      "1d": input.c1d ? tfRead(input.c1d, BOARD.window["1d"], mark, t) : null,
      "1w": input.c1d ? tfRead(weeklyFromDaily(input.c1d), BOARD.window["1w"], mark, t) : null,
    };
    return {
      coin: input.ctx.name,
      mark: sig(mark),
      tf,
      pos: positioning(input, history, t),
      rs: { vsBtc24hPct: null, vsBtc7dPct: null },
      xs: { fundingZ: null, oiChg24hZ: null, ret24hZ: null },
      levels: levelMenu(mark, tf, input.c1d, t),
    };
  });
  const btc = rows.find((r) => r.coin === "BTC")?.pos;
  const diff = (a: number | null, b: number | null | undefined) => (a === null || b === null || b === undefined ? null : r2(a - b));
  const fz = crossZ(rows.map((r) => r.pos.fundingAnnPct), 1);
  const oz = crossZ(rows.map((r) => r.pos.oiChg24hPct), 0.5);
  const rz = crossZ(rows.map((r) => r.pos.ret24hPct), 0.5);
  rows.forEach((r, i) => {
    if (r.coin !== "BTC") r.rs = { vsBtc24hPct: diff(r.pos.ret24hPct, btc?.ret24hPct), vsBtc7dPct: diff(r.pos.ret7dPct, btc?.ret7dPct) };
    r.xs = { fundingZ: fz[i]!, oiChg24hZ: oz[i]!, ret24hZ: rz[i]! };
  });
  const snaps = history?.snapshots ?? [];
  return { asOf: now.toISOString(), rows, history: { snapshots: snaps.length, oldest: snaps[0]?.t ?? null } };
}

/**
 * Top `top` live markets by 24 h notional volume above the OI floor, plus `always` (majors, "my markets") wherever
 * they are listed. Most liquid first.
 */
export function boardUniverse(ctxs: AssetCtx[], always: readonly string[], o: { top: number; minOiUsd: number } = BOARD): AssetCtx[] {
  const sorted = [...ctxs].sort((a, b) => b.dayNtlVlm - a.dayNtlVlm || (a.name < b.name ? -1 : 1));
  const keep = new Set(sorted.filter((c) => c.openInterest * c.markPx >= o.minOiUsd).slice(0, o.top).map((c) => c.name));
  for (const c of always) keep.add(c);
  return sorted.filter((c) => keep.has(c.name));
}

/** Appends this run's snapshot (replacing one taken < 30 min ago) and drops what is older than BOARD.historyDays. */
export function appendSnapshot(history: BoardHistory | null, ctxs: AssetCtx[], now: Date): BoardHistory {
  const t = now.getTime();
  const rows: BoardHistory["snapshots"][number]["rows"] = {};
  for (const c of ctxs) rows[c.name] = [sig(c.markPx), sig(c.openInterest, 8), c.funding];
  const kept = (history?.snapshots ?? []).filter((s) => {
    const at = Date.parse(s.t);
    return at >= t - BOARD.historyDays * DAY && at < t - 30 * 60_000;
  });
  return { updated_at: now.toISOString(), snapshots: [...kept, { t: now.toISOString(), rows }] };
}
