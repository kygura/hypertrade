import { Hono } from "hono";
import { z } from "zod";
import type { CandlesResponse } from "../../shared/market.js";
import { DEFAULT_PAGE_BARS, MAX_PAGE_BARS, TIMEFRAMES, type Timeframe } from "../../shared/timeframes.js";
import * as db from "../db.js";
import { nextBarT, readPage, type Page } from "../market/candleSync.js";
import { syncFunding, type FundingSyncResult } from "../market/fundingSync.js";
import { joinOverlays, type ChartBar } from "../market/overlay.js";

export type { CandlesResponse };
import { resolveCoin } from "./hl.js";

// GET /candles/:coin?tf=1h&before=<ms>&limit=1500
//
// One page of chart bars, newest first when `before` is omitted; the chart
// asks for the next page (before = oldest bar it holds) as the user scrolls
// back. Each page is synced/backfilled on demand (market/candleSync.ts), and
// carries funding, premium and OI joined onto the same bars.

const HOUR = 3_600_000;
const FUNDING_PAGES_PER_REQUEST = 12; // ~250 days of hourly funding
const FUNDING_BUDGET_MS = 8_000;

const querySchema = z.object({
  tf: z.enum(TIMEFRAMES).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(10).max(MAX_PAGE_BARS).optional(),
});

export type CandlesDeps = {
  resolveCoin: (param: string) => Promise<string>;
  touch: (coin: string, tf: Timeframe) => Promise<void>;
  readPage: (coin: string, tf: Timeframe, opts: { before?: number; limit: number }) => Promise<Page>;
  syncFunding: (coin: string, from: number) => Promise<FundingSyncResult>;
  funding: (coin: string, from: number, to: number) => Promise<{ t: number; rate: number; premium: number }[]>;
  oi: (coin: string, from: number, to: number) => Promise<{ t: number; v: number }[]>;
};

export const defaultCandlesDeps: CandlesDeps = {
  resolveCoin,
  touch: (coin, tf) => db.touchSyncAccess(coin, tf),
  readPage: (coin, tf, opts) => readPage(coin, tf, opts),
  syncFunding: (coin, from) =>
    syncFunding(coin, from, { maxPages: FUNDING_PAGES_PER_REQUEST, deadline: Date.now() + FUNDING_BUDGET_MS }),
  funding: async (coin, from, to) =>
    (await db.getFunding(coin, new Date(from), new Date(to))).map((r) => ({ t: r.ts.getTime(), rate: r.rate, premium: r.premium })),
  // OI history is the collector's 15-minute hl.oi.<COIN> snapshots (USD notional).
  oi: async (coin, from, to) =>
    (await db.seriesRange(`hl.oi.${coin}`, new Date(from), new Date(to))).map((p) => ({ t: new Date(p.ts).getTime(), v: p.value })),
};

export function candlesRoute(deps: CandlesDeps = defaultCandlesDeps) {
  return new Hono().get("/:coin", async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query" }, 400);
    const tf = parsed.data.tf ?? "1d";
    const limit = parsed.data.limit ?? DEFAULT_PAGE_BARS;
    const coin = await deps.resolveCoin(c.req.param("coin"));

    await deps.touch(coin, tf).catch(() => {}); // bookkeeping only; never fails the chart
    const page = await deps.readPage(coin, tf, { before: parsed.data.before, limit });

    let bars: ChartBar[] = page.bars.map((b) => ({ ...b, f: null, p: null, oi: null }));
    let fundingMeta: CandlesResponse["funding"] = { from: null, complete: false };
    let oiFrom: number | null = null;
    if (page.bars.length > 0) {
      const from = page.bars[0]!.t;
      const to = nextBarT(page.bars[page.bars.length - 1]!.t, tf);
      const fs = await deps.syncFunding(coin, from).catch(() => null);
      const [funding, oi] = await Promise.all([
        deps.funding(coin, from, to + HOUR).catch(() => []),
        deps.oi(coin, from - HOUR, to).catch(() => []),
      ]);
      bars = joinOverlays(page.bars, tf, funding, oi);
      fundingMeta = { from: fs?.from ?? null, complete: fs?.complete ?? false };
      oiFrom = oi[0]?.t ?? null;
    }

    const body: CandlesResponse = { coin, tf, bars, hasMore: page.hasMore, error: page.error, funding: fundingMeta, oi: { from: oiFrom } };
    return c.json(body);
  });
}

export const candlesRoutes = candlesRoute();
