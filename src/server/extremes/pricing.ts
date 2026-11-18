import type { ExtremeKind } from "../../shared/extremes.js";
import { atr, median } from "../../shared/signalMath.js";
import type { Side } from "../../shared/intel.js";
import type { Candle } from "../../shared/types.js";

// Entry, stop and target for an extremes take, ported from perp-radar's scanner (src/setups.ts there). Code prices,
// never the model: entry is the live mark at verdict time; the stop is the farther of the template's structural stop
// and the verdict's killPx, widened to at least MIN_STOP_ATR; the target is the template's. One template per kind and
// fade side, on 1h candles (the current bar last):
//   price_dislocation  fade_extension       short: stop 24h high + 0.5 ATR, target 72h median (long mirrored on the low)
//   oi_flush           flush_reversion      long:  stop 24h low − 0.5 ATR, target 24h low + half the 24h range
//                      squeeze_exhaustion   short: stop 24h high + 0.5 ATR, target 24h high − half the 24h range
//   crowded_asymmetry  short_squeeze_loading long: stop 72h low − 0.25 ATR, target 72h high
//                      long_squeeze_loading  short: stop 72h high + 0.25 ATR, target 72h low
// A take against the event's fade side has no template and stays unpriced (no target), as does one without enough
// candles. Conviction is the verdict's own when it gives one, else the R:R's: the code measures the payoff, the model
// judges the thesis.

/** Stops closer than this many 1h ATRs get widened, so a tight stop cannot inflate the R:R (perp-radar's value). */
const MIN_STOP_ATR = 0.75;
/** The 72h range needs this many prior 1h bars (perp-radar's floor). */
const MIN_RANGE_BARS = 48;
/** Default R:R floor for a priced take (EXTREMES_MIN_RR). */
const DEFAULT_EXTREMES_MIN_RR = 2;
/** 1h candles a pricing read asks for: the 72h range, its current bar and slack for gaps. */
export const PRICING_LOOKBACK_MS = 80 * 3_600_000;

export type Conviction = "low" | "medium" | "high";

export type ExtremeLevels = {
  atr1h: number;
  hi24h: number;
  lo24h: number;
  range72h: { lo: number; hi: number; mid: number } | null;
};

export type ExtremePricing =
  | {
      priced: true;
      setup: string;
      entry: number;
      stop: number;
      target: number;
      /** The level the template keys on (the extreme or the range edge). */
      zone: number;
      /** reward / risk at the entry, two decimals. */
      rr: number;
      /** The template's own stop before the kill and the ATR floor. */
      structuralStop: number;
      levels: ExtremeLevels;
    }
  | { priced: false; reason: string };

const round = (x: number, d = 6) => Number(x.toPrecision(d));

/** perp-radar's features on 1h bars (current bar last) and the live mark. Null without 15 bars for the ATR or any 24h bar. */
export function extremeLevels(bars: Candle[], mark: number): ExtremeLevels | null {
  const atr1h = atr(bars, 14);
  const last24 = bars.slice(-24);
  if (atr1h == null || !(atr1h > 0) || !last24.length) return null;
  const prior = bars.slice(-73, -1);
  const range72h = prior.length >= MIN_RANGE_BARS
    ? { lo: Math.min(...prior.map((b) => b.l)), hi: Math.max(...prior.map((b) => b.h)), mid: median(prior.map((b) => b.c)) }
    : null;
  return { atr1h, hi24h: Math.max(...last24.map((b) => b.h), mark), lo24h: Math.min(...last24.map((b) => b.l), mark), range72h };
}

type Template = { setup: string; zone: number; stop: number; target: number };

function template(kind: ExtremeKind, side: Side, f: ExtremeLevels): Template | string {
  const a = f.atr1h;
  const long = side === "long";
  switch (kind) {
    case "price_dislocation":
      if (!f.range72h) return "under 48 h of candles for the 72 h range";
      return long
        ? { setup: "fade_extension", zone: f.lo24h, stop: f.lo24h - 0.5 * a, target: f.range72h.mid }
        : { setup: "fade_extension", zone: f.hi24h, stop: f.hi24h + 0.5 * a, target: f.range72h.mid };
    case "oi_flush": {
      const half = 0.5 * (f.hi24h - f.lo24h);
      return long
        ? { setup: "flush_reversion", zone: f.lo24h, stop: f.lo24h - 0.5 * a, target: f.lo24h + half }
        : { setup: "squeeze_exhaustion", zone: f.hi24h, stop: f.hi24h + 0.5 * a, target: f.hi24h - half };
    }
    case "crowded_asymmetry":
      if (!f.range72h) return "under 48 h of candles for the 72 h range";
      return long
        ? { setup: "short_squeeze_loading", zone: f.range72h.lo, stop: f.range72h.lo - 0.25 * a, target: f.range72h.hi }
        : { setup: "long_squeeze_loading", zone: f.range72h.hi, stop: f.range72h.hi + 0.25 * a, target: f.range72h.lo };
  }
}

/**
 * Prices a take (pure). `fadeSide` is the event's side, `direction` and `killPx` the verdict's, `entry` the mark
 * stamped at verdict time, `bars` 1h candles with the current bar last.
 */
export function priceExtreme(i: { kind: ExtremeKind; fadeSide: Side; direction: Side; entry: number; killPx: number; bars: Candle[] }): ExtremePricing {
  if (i.direction !== i.fadeSide) return { priced: false, reason: `a ${i.direction} against the event's ${i.fadeSide} fade has no template` };
  const f = extremeLevels(i.bars, i.entry);
  if (!f) return { priced: false, reason: "under 15 h of 1h candles" };
  const t = template(i.kind, i.direction, f);
  if (typeof t === "string") return { priced: false, reason: t };
  const long = i.direction === "long";
  const e = i.entry;
  // The farther of the structure and the model's kill, then at least MIN_STOP_ATR from the entry.
  const minDist = MIN_STOP_ATR * f.atr1h;
  let stop = long ? Math.min(t.stop, i.killPx) : Math.max(t.stop, i.killPx);
  if (long && e - stop < minDist) stop = e - minDist;
  if (!long && stop - e < minDist) stop = e + minDist;
  const risk = Math.abs(e - stop);
  const reward = long ? t.target - e : e - t.target;
  if (!(stop > 0) || !(risk > 0)) return { priced: false, reason: "no room for a stop" };
  if (!(reward > 0)) return { priced: false, reason: `the ${t.setup} target ${round(t.target)} is already behind the mark ${round(e)}` };
  return { priced: true, setup: t.setup, entry: round(e), stop: round(stop), target: round(t.target), zone: round(t.zone), rr: Number((reward / risk).toFixed(2)), structuralStop: round(t.stop), levels: f };
}

/** The R:R floor a priced take must clear, from EXTREMES_MIN_RR (default 2). */
export function extremesMinRr(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EXTREMES_MIN_RR?.trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_EXTREMES_MIN_RR;
}

/** Whether `rr` clears the floor, compared at one decimal: 1.98 against 2 passes, 1.94 does not. */
export const clearsMinRr = (rr: number, floor: number) => Math.round(rr * 10) / 10 >= floor;

/** The R:R's conviction when the verdict gives none: 3.5:1 or more high, 2.5:1 or more medium, else low. */
export function convictionOfRr(rr: number): Conviction {
  return rr >= 3.5 ? "high" : rr >= 2.5 ? "medium" : "low";
}

/** Conviction and leverage tags on an opportunity: how the desk reads them back (ticketOf in routes/platform.ts). */
export const convictionTag = (c: Conviction) => `conviction:${c}`;
export const leverageTag = (n: number) => `leverage:${n}`;

/** The conviction and leverage an opportunity's tags carry, when they do. */
export function tradeHints(tags: readonly string[]): { confidence?: Conviction; leverage?: number } {
  const out: { confidence?: Conviction; leverage?: number } = {};
  for (const t of tags) {
    const [k, v] = t.split(":");
    if (k === "conviction" && (v === "low" || v === "medium" || v === "high")) out.confidence = v;
    if (k === "leverage") {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= 10) out.leverage = n;
    }
  }
  return out;
}
