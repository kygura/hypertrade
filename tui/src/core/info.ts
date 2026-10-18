// Read side of Hyperliquid's /info endpoint for one network. Fetching, retry
// and the weight guard come from shared/hl-client.ts (which only knows the
// mainnet URL, so we hand it a fetch that points at our network). Parsing of
// untrusted payloads lives here as pure functions the demo source reuses.
import { z } from "zod";
import { fetchCandles, fetchFundingPage, HL_FUNDING_PAGE, hlInfo, parseMetaAndCtxs } from "../../../src/shared/hl-client.js";
import { bookFromL2, depthWithin, midOf, walkBook } from "../../../src/server/platform/costs.js";
import type { AccountSnapshot, BookView, Candle, FundingPoint, InfoSource, MarketRow, Network, OpenOrder, PositionRow } from "./types.js";

export function infoBase(network: Network): string {
  return network === "mainnet" ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz";
}

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Book sizes (USD) the slippage ladder is quoted for. */
export const BOOK_SIZES_USD = [10_000, 50_000, 250_000] as const;

const APR = 24 * 365 * 100;

// ─── markets ───

const PredictedSchema = z.array(
  z.tuple([z.string(), z.array(z.tuple([z.string(), z.object({ fundingRate: z.string().optional(), fundingIntervalHours: z.number().optional() }).nullable()]))]),
);

/** predictedFundings payload → hourly rate per coin from the Hyperliquid venue entry. Empty when malformed. */
function predictedHourly(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const p = PredictedSchema.safeParse(raw);
  if (!p.success) return out;
  for (const [coin, venues] of p.data) {
    const hl = venues.find(([v]) => v === "HlPerp")?.[1];
    const rate = hl?.fundingRate == null ? NaN : Number(hl.fundingRate);
    // HL settles hourly; its own entry omits the interval in older payloads.
    if (Number.isFinite(rate)) out.set(coin, rate / (hl?.fundingIntervalHours ?? 1));
  }
  return out;
}

/**
 * metaAndAssetCtxs (+ optional predictedFundings / perpsAtOpenInterestCap
 * payloads) → MarketRow[]. Throws when the main payload does not match the
 * schema; the optional ones are ignored when malformed or null.
 */
export function marketsFromRaw(raw: unknown, predictedRaw: unknown = null, capRaw: unknown = null): MarketRow[] {
  const { meta, ctxs } = parseMetaAndCtxs(raw);
  // parseMetaAndCtxs coalesces a null premium to 0; keep the null for the row.
  const rawCtxs = (raw as [unknown, Array<{ premium: string | null }>])[1];
  const predicted = predictedHourly(predictedRaw);
  const capped = new Set(z.array(z.string()).catch([]).parse(capRaw));
  return ctxs.map((c, i) => ({
    coin: c.name,
    asset: i,
    szDecimals: c.szDecimals,
    maxLeverage: c.maxLeverage ?? meta.universe[i]!.maxLeverage,
    markPx: c.markPx,
    midPx: null,
    prevDayPx: c.prevDayPx,
    dayChangePct: c.dayChange * 100,
    fundingHourly: c.funding,
    fundingAprPct: c.funding * APR,
    predictedFundingHourly: predicted.get(c.name) ?? null,
    oiUsd: c.openInterest * c.markPx,
    dayVolumeUsd: c.dayNtlVlm,
    premium: rawCtxs[i]?.premium == null ? null : c.premium,
    isDelisted: c.isDelisted,
    atOiCap: capped.has(c.name),
  }));
}

// ─── account ───

const Num = z.union([z.string(), z.number()]).transform(Number).pipe(z.number().finite());

const ClearinghouseSchema = z.object({
  marginSummary: z.object({ accountValue: Num, totalMarginUsed: Num }),
  withdrawable: Num.optional(),
  assetPositions: z.array(
    z.object({
      position: z.object({
        coin: z.string(),
        szi: Num,
        entryPx: Num.nullable().optional(),
        positionValue: Num,
        unrealizedPnl: Num,
        liquidationPx: Num.nullable().optional(),
        marginUsed: Num,
        leverage: z.object({ value: Num }),
      }),
    }),
  ),
});

const OpenOrdersSchema = z.array(
  z.object({
    coin: z.string(),
    side: z.enum(["B", "A"]),
    limitPx: Num,
    sz: Num,
    oid: z.number(),
    timestamp: z.number(),
    isTrigger: z.boolean().optional(),
    triggerPx: Num.nullable().optional(),
    reduceOnly: z.boolean().optional(),
    orderType: z.string().optional(),
  }),
);

type RawOrder = z.infer<typeof OpenOrdersSchema>[number];

/** "Stop Market" / "Stop Limit" → sl, "Take Profit Market" / "Take Profit Limit" → tp. */
function tpslOf(o: RawOrder): "sl" | "tp" | null {
  if (!o.isTrigger) return null;
  if (/^take profit/i.test(o.orderType ?? "")) return "tp";
  if (/^stop/i.test(o.orderType ?? "")) return "sl";
  return null;
}

/** Percent from `mark` to `px`; negative when reaching `px` needs an adverse move for `side`. */
function distPct(side: "long" | "short", mark: number, px: number): number | null {
  if (!(mark > 0)) return null;
  const d = ((px - mark) / mark) * 100;
  return side === "long" ? d : -d;
}

/**
 * clearinghouseState + frontendOpenOrders → AccountSnapshot. Marks come from
 * `markets` (positionValue / size when a coin is missing). A coin's stop/tp is
 * its reduce-only trigger order. Throws on a malformed payload: a silently
 * dropped stop order would show as a false "no stop" alert.
 */
export function accountFromRaw(address: string, state: unknown, orders: unknown, markets: MarketRow[], at: number): AccountSnapshot {
  const s = ClearinghouseSchema.parse(state);
  const raw = OpenOrdersSchema.parse(orders);
  const markOf = new Map(markets.map((m) => [m.coin, m.markPx]));

  const openOrders: OpenOrder[] = raw.map((o) => ({
    oid: o.oid,
    coin: o.coin,
    side: o.side === "B" ? "buy" : "sell",
    size: o.sz,
    limitPx: o.limitPx,
    triggerPx: o.isTrigger && o.triggerPx ? o.triggerPx : null,
    isTrigger: o.isTrigger ?? false,
    reduceOnly: o.reduceOnly ?? false,
    tpsl: tpslOf(o),
    orderType: o.orderType ?? "Limit",
    timestamp: o.timestamp,
  }));
  const protective = openOrders.filter((o) => o.isTrigger && o.reduceOnly && o.triggerPx != null);

  const positions: PositionRow[] = s.assetPositions
    .map(({ position: p }): PositionRow => {
      const size = Math.abs(p.szi);
      const side = p.szi >= 0 ? "long" : "short";
      const markPx = markOf.get(p.coin) ?? (size > 0 ? p.positionValue / size : 0);
      const mine = protective.filter((o) => o.coin === p.coin);
      const stopPx = mine.find((o) => o.tpsl === "sl")?.triggerPx ?? null;
      const tpPx = mine.find((o) => o.tpsl === "tp")?.triggerPx ?? null;
      const liqPx = p.liquidationPx ?? null;
      return {
        coin: p.coin,
        side,
        size,
        entryPx: p.entryPx ?? markPx,
        markPx,
        unrealizedPnlUsd: p.unrealizedPnl,
        notionalUsd: p.positionValue,
        leverage: p.leverage.value,
        liqPx,
        marginUsedUsd: p.marginUsed,
        stopPx,
        tpPx,
        stopDistPct: stopPx == null ? null : distPct(side, markPx, stopPx),
        liqDistPct: liqPx == null ? null : distPct(side, markPx, liqPx),
      };
    })
    .filter((p) => p.size > 0);

  return {
    address,
    equityUsd: s.marginSummary.accountValue,
    marginUsedUsd: s.marginSummary.totalMarginUsed,
    withdrawableUsd: s.withdrawable ?? 0,
    unrealizedPnlUsd: positions.reduce((a, p) => a + p.unrealizedPnlUsd, 0),
    positions,
    orders: openOrders,
    at,
  };
}

// ─── book ───

/** l2Book payload → BookView with spread, depth within 50 bps and the slippage ladder. Throws on an empty or crossed book. */
export function bookViewFromRaw(coin: string, raw: unknown, at: number): BookView {
  const book = bookFromL2(raw);
  if (!book) throw new Error(`no usable order book for ${coin}`);
  const mid = midOf(book)!;
  const bestBid = book.bids[0]!.px;
  const bestAsk = book.asks[0]!.px;
  return {
    coin,
    bids: book.bids,
    asks: book.asks,
    mid,
    spreadBps: ((bestAsk - bestBid) / mid) * 1e4,
    depth50Usd: { bid: depthWithin(book.bids, mid), ask: depthWithin(book.asks, mid) },
    slippage: BOOK_SIZES_USD.map((sizeUsd) => ({
      sizeUsd,
      buyBps: walkBook(book.asks, "buy", sizeUsd, mid)?.slippageBps ?? null,
      sellBps: walkBook(book.bids, "sell", sizeUsd, mid)?.slippageBps ?? null,
    })),
    at,
  };
}

// ─── live source ───

const FUNDING_MAX_PAGES = 4;

export class HlInfo implements InfoSource {
  private readonly fetchFn: typeof fetch;

  constructor(
    readonly network: Network,
    fetchFn: FetchFn = fetch,
  ) {
    const url = `${infoBase(network)}/info`;
    // hl-client always posts to the mainnet URL; send it to this network instead.
    this.fetchFn = ((_input: unknown, init?: RequestInit) => fetchFn(url, init)) as unknown as typeof fetch;
  }

  private info<T>(body: { type: string } & Record<string, unknown>): Promise<T> {
    return hlInfo<T>(body, this.fetchFn);
  }

  async markets(): Promise<MarketRow[]> {
    const [raw, predicted, cap] = await Promise.all([
      this.info<unknown>({ type: "metaAndAssetCtxs" }),
      this.info<unknown>({ type: "predictedFundings" }).catch(() => null),
      this.info<unknown>({ type: "perpsAtOpenInterestCap" }).catch(() => null),
    ]);
    return marketsFromRaw(raw, predicted, cap);
  }

  async account(address: string, markets: MarketRow[]): Promise<AccountSnapshot> {
    const [state, orders] = await Promise.all([
      this.info<unknown>({ type: "clearinghouseState", user: address }),
      this.info<unknown>({ type: "frontendOpenOrders", user: address }),
    ]);
    return accountFromRaw(address, state, orders, markets, Date.now());
  }

  async book(coin: string): Promise<BookView> {
    return bookViewFromRaw(coin, await this.info<unknown>({ type: "l2Book", coin }), Date.now());
  }

  candles(coin: string, interval: "1h" | "4h" | "1d", startMs: number): Promise<Candle[]> {
    return fetchCandles(coin, interval, startMs, Date.now(), this.fetchFn);
  }

  async fundingHistory(coin: string, startMs: number): Promise<FundingPoint[]> {
    const end = Date.now();
    const out: FundingPoint[] = [];
    let cursor = startMs;
    for (let page = 0; page < FUNDING_MAX_PAGES && cursor < end; page++) {
      const rows = await fetchFundingPage(coin, cursor, end, this.fetchFn);
      out.push(...rows);
      if (rows.length < HL_FUNDING_PAGE) break;
      cursor = rows[rows.length - 1]!.t + 1;
    }
    return out;
  }
}
