// Offline InfoSource for `ht --demo`: real Hyperliquid responses recorded into
// ./fixtures (universe trimmed to the top ~40 by OI, so `asset` ids here are
// positions in that trimmed universe, not live ids) plus a crafted account.
// Candles, funding and order timestamps are shifted so the newest bar is
// "now", which keeps the diagnostics windows meaningful whenever it runs.
import accountOrdersFx from "./fixtures/account-orders.json";
import accountStateFx from "./fixtures/account-state.json";
import bookBtcFx from "./fixtures/book-BTC.json";
import bookEthFx from "./fixtures/book-ETH.json";
import candlesBtc1dFx from "./fixtures/candles-BTC-1d.json";
import candlesBtc1hFx from "./fixtures/candles-BTC-1h.json";
import candlesEth1dFx from "./fixtures/candles-ETH-1d.json";
import candlesEth1hFx from "./fixtures/candles-ETH-1h.json";
import fundingBtcFx from "./fixtures/funding-BTC.json";
import fundingEthFx from "./fixtures/funding-ETH.json";
import metaFx from "./fixtures/meta.json";
import oiCapFx from "./fixtures/oicap.json";
import predictedFx from "./fixtures/predicted.json";
import { accountFromRaw, bookViewFromRaw, marketsFromRaw } from "./info.js";
import type { AccountSnapshot, BookView, Candle, FundingPoint, InfoSource, MarketRow } from "./types.js";

/** Syntactically valid placeholder address; the demo source answers for any address. */
export const demoAccountAddress = "0xde30de30de30de30de30de30de30de30de30de30";

const HOUR = 3_600_000;
const INTERVAL_MS = { "1h": HOUR, "4h": 4 * HOUR, "1d": 24 * HOUR } as const;

type RawCandle = { t: number; T: number; o: string; h: string; l: string; c: string; v: string };

const candleFx: Record<string, Partial<Record<"1h" | "1d", RawCandle[]>>> = {
  BTC: { "1d": candlesBtc1dFx, "1h": candlesBtc1hFx },
  ETH: { "1d": candlesEth1dFx, "1h": candlesEth1hFx },
};
const fundingFx: Record<string, Array<{ fundingRate: string; premium: string; time: number }>> = { BTC: fundingBtcFx, ETH: fundingEthFx };

/** Re-buckets ascending 1h candles into 4h bars. */
function to4h(hourly: Candle[]): Candle[] {
  const out = new Map<number, Candle>();
  for (const c of hourly) {
    const t = Math.floor(c.t / (4 * HOUR)) * 4 * HOUR;
    const b = out.get(t);
    if (!b) out.set(t, { t, T: t + 4 * HOUR - 1, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    else Object.assign(b, { h: Math.max(b.h, c.h), l: Math.min(b.l, c.l), c: c.c, v: b.v + c.v });
  }
  return [...out.values()];
}

export class DemoInfo implements InfoSource {
  private rows: MarketRow[] | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  private marketRows(): MarketRow[] {
    return (this.rows ??= marketsFromRaw(metaFx, predictedFx, oiCapFx));
  }

  async markets(): Promise<MarketRow[]> {
    return this.marketRows().map((m) => ({ ...m }));
  }

  async account(address: string, markets: MarketRow[]): Promise<AccountSnapshot> {
    const now = this.now();
    const shift = now - bookBtcFx.time;
    const orders = accountOrdersFx.map((o) => ({ ...o, timestamp: o.timestamp + shift }));
    return accountFromRaw(address, accountStateFx, orders, markets, now);
  }

  async book(coin: string): Promise<BookView> {
    const now = this.now();
    if (coin === "BTC") return bookViewFromRaw(coin, bookBtcFx, now);
    if (coin === "ETH") return bookViewFromRaw(coin, bookEthFx, now);
    const mark = this.marketRows().find((m) => m.coin === coin)?.markPx;
    const base = bookViewFromRaw("BTC", bookBtcFx, now);
    if (!mark || !base.mid) throw new Error(`no demo book for ${coin}`);
    // Same USD depth and relative spacing as the BTC book, at this coin's price.
    const k = mark / base.mid;
    const side = (rows: Array<{ px: number; sz: number }>) => rows.map((l) => ({ px: String(l.px * k), sz: String(l.sz / k) }));
    return bookViewFromRaw(coin, { levels: [side(base.bids), side(base.asks)] }, now);
  }

  async candles(coin: string, interval: "1h" | "4h" | "1d", startMs: number): Promise<Candle[]> {
    const src = candleFx[coin]?.[interval === "1d" ? "1d" : "1h"];
    if (!src?.length) return [];
    const step = interval === "1d" ? INTERVAL_MS["1d"] : HOUR;
    const shift = Math.floor(this.now() / step) * step - src[src.length - 1]!.t;
    const bars: Candle[] = src.map((c) => ({ t: c.t + shift, T: c.T + shift, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }));
    return (interval === "4h" ? to4h(bars) : bars).filter((c) => c.t >= startMs);
  }

  async fundingHistory(coin: string, startMs: number): Promise<FundingPoint[]> {
    const src = fundingFx[coin];
    if (!src?.length) return [];
    const shift = Math.floor(this.now() / HOUR) * HOUR - src[src.length - 1]!.time;
    return src.map((r) => ({ t: r.time + shift, rate: Number(r.fundingRate), premium: Number(r.premium) })).filter((p) => p.t >= startMs);
  }
}
