import { z } from "zod";
import { fetchCandles, fetchFundingPage, hlInfo, type FundingPoint } from "../../shared/hl-client.js";
import type { AssetCtx, Candle } from "../../shared/types.js";
import { seriesRange, summaryFor, type MetricSummary } from "../db.js";
import { getCtxs } from "../routes/hl.js";
import type { AccountState, Position } from "./types.js";

// Market data for the desk: live Hyperliquid reads plus the series the
// collector already stores (OI snapshots, FRED macro). Injectable as a
// whole so tools, the watch tick and tests share one seam.

export interface MarketData {
  ctxs(): Promise<AssetCtx[]>;
  candles(coin: string, interval: "5m" | "15m" | "1h" | "4h" | "1d", start: number, end: number): Promise<Candle[]>;
  funding(coin: string, start: number, end: number): Promise<FundingPoint[]>;
  /** Collected series points (e.g. hl.oi.BTC, fred.DGS10), ascending. */
  series(id: string, from: Date): Promise<Array<{ t: number; v: number }>>;
  summary(ids: string[]): Promise<MetricSummary[]>;
  /** Read-only view of a Hyperliquid account by address (no keys involved). */
  watchedAccount(address: string): Promise<AccountState>;
  /** hl-cycles static export file, e.g. "vector.json". */
  cycles(baseUrl: string, file: string): Promise<unknown>;
}

const FUNDING_PAGE_ROWS = 500;

export const liveMarketData: MarketData = {
  async ctxs() {
    return (await getCtxs()).ctxs;
  },
  candles: (coin, interval, start, end) => fetchCandles(coin, interval, start, end),
  async funding(coin, start, end) {
    const out: FundingPoint[] = [];
    let cursor = start;
    for (let page = 0; page < 4 && cursor < end; page++) {
      const rows = await fetchFundingPage(coin, cursor, end);
      out.push(...rows);
      if (rows.length < FUNDING_PAGE_ROWS) break;
      cursor = rows[rows.length - 1]!.t + 1;
    }
    return out;
  },
  async series(id, from) {
    const pts = await seriesRange(id, from);
    return pts.map((p) => ({ t: new Date(p.ts).getTime(), v: Number(p.value) }));
  },
  summary: (ids) => summaryFor(ids),
  watchedAccount: (address) => readHlAccount(address),
  async cycles(baseUrl, file) {
    const r = await fetch(`${baseUrl}/api/${file}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`hl-cycles ${file}: HTTP ${r.status}`);
    return r.json();
  },
};

const Num = z.union([z.string(), z.number()]).transform(Number);

const ClearinghouseSchema = z.object({
  marginSummary: z.object({ accountValue: Num, totalNtlPos: Num }),
  assetPositions: z.array(
    z.object({
      position: z.object({
        coin: z.string(),
        szi: Num,
        entryPx: Num.nullable().optional(),
        positionValue: Num,
        unrealizedPnl: Num,
      }),
    }),
  ),
});

const OpenOrdersSchema = z.array(
  z.object({
    coin: z.string(),
    isTrigger: z.boolean().optional(),
    triggerPx: Num.optional(),
    orderType: z.string().optional(),
    reduceOnly: z.boolean().optional(),
  }),
);

const PortfolioSchema = z.array(z.tuple([z.string(), z.object({ accountValueHistory: z.array(z.tuple([z.number(), Num])) }).passthrough()]));

/** Maps a clearinghouseState + open orders payload onto AccountState. Pure; exported for tests. */
export function toWatchedAccount(state: unknown, orders: unknown, dayStartEquity: number | null): AccountState {
  const s = ClearinghouseSchema.parse(state);
  const o = OpenOrdersSchema.safeParse(orders);
  const triggers = o.success ? o.data.filter((x) => x.isTrigger && x.reduceOnly && x.triggerPx != null) : [];
  const positions: Position[] = s.assetPositions
    .map(({ position: p }) => {
      const size = Math.abs(p.szi);
      const side = p.szi >= 0 ? ("long" as const) : ("short" as const);
      const markPx = size > 0 ? p.positionValue / size : 0;
      const mine = triggers.filter((t) => t.coin === p.coin);
      const stop = mine.find((t) => /stop/i.test(t.orderType ?? ""));
      const tp = mine.find((t) => /take profit/i.test(t.orderType ?? ""));
      return {
        coin: p.coin,
        side,
        size,
        entryPx: p.entryPx ?? markPx,
        markPx,
        stopPx: stop?.triggerPx ?? null,
        tpPx: tp?.triggerPx ?? null,
        unrealizedPnl: p.unrealizedPnl,
        notionalUsd: p.positionValue,
      };
    })
    .filter((p) => p.size > 0);
  const equity = s.marginSummary.accountValue;
  return { venue: "hyperliquid (watch)", equityUsd: equity, dayPnlUsd: dayStartEquity == null ? 0 : equity - dayStartEquity, positions, available: true };
}

async function readHlAccount(address: string): Promise<AccountState> {
  try {
    const [state, orders, portfolio] = await Promise.all([
      hlInfo<unknown>({ type: "clearinghouseState", user: address }),
      hlInfo<unknown>({ type: "frontendOpenOrders", user: address }),
      hlInfo<unknown>({ type: "portfolio", user: address }).catch(() => null),
    ]);
    // Day-start equity from HL's own "day" account-value history when present.
    let dayStart: number | null = null;
    const pf = PortfolioSchema.safeParse(portfolio);
    if (pf.success) {
      const day = pf.data.find(([k]) => k === "day")?.[1].accountValueHistory;
      if (day?.length) dayStart = day[0]![1];
    }
    return toWatchedAccount(state, orders, dayStart);
  } catch (err) {
    return { venue: "hyperliquid (watch)", equityUsd: 0, dayPnlUsd: 0, positions: [], available: false, note: err instanceof Error ? err.message : String(err) };
  }
}

/** Shrinks a JSON payload for a model: long arrays keep their last `keep` items. */
export function trimForModel(v: unknown, keep = 8, depth = 0): unknown {
  if (Array.isArray(v)) {
    const tail = v.length > keep * 2 ? v.slice(-keep) : v;
    const mapped = tail.map((x) => trimForModel(x, keep, depth + 1));
    return v.length > keep * 2 ? { omitted: v.length - keep, last: mapped } : mapped;
  }
  if (v && typeof v === "object" && depth < 6) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, trimForModel(x, keep, depth + 1)]));
  }
  return v;
}
