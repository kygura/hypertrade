// Hyperliquid public REST client. No auth required. Isomorphic: the REST
// calls are plain `fetch` and run on server or browser.
//
// Reliability rules ported from hl-cycles' sources/hyperliquid.ts: every call
// has a timeout, one retry on 429/5xx/network error, and a rolling weight
// log keeps a process under HL's 1200 weight/min/IP budget without callers
// having to think about it.
import { z } from "zod";
import { HlCandlesResponseSchema, HlMetaAndAssetCtxsResponseSchema } from "./schemas.js";
import type { Timeframe } from "./timeframes.js";
import type { AssetCtx, Candle, HlRawPerpMeta } from "./types.js";

export const HL_REST = "https://api.hyperliquid.xyz/info";
export const HL_WS = "wss://api.hyperliquid.xyz/ws";

const FETCH_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 500;

// ─── weight guard ───
// info calls weigh 20, plus 1 per 60 candles (candleSnapshot) or per 20 rows
// (fundingHistory). Budget sits under HL's 1200 so a burst never 429s.
export type WeightLogEntry = { t: number; weight: number };
const WEIGHT_WINDOW_MS = 60_000;
const WEIGHT_BUDGET = 1000;
const weightLog: WeightLogEntry[] = [];

/** ms to wait until one more base-weight call fits the trailing-60s budget. Pure. */
export function weightWaitMs(log: WeightLogEntry[], now: number, budget: number = WEIGHT_BUDGET): number {
  const relevant = log.filter((e) => e.t > now - WEIGHT_WINDOW_MS);
  const sum = relevant.reduce((a, e) => a + e.weight, 0);
  if (sum + 20 <= budget) return 0;
  const oldest = relevant.reduce((min, e) => Math.min(min, e.t), Infinity);
  return Math.max(0, oldest + WEIGHT_WINDOW_MS - now);
}

/** ms the next call would wait on the weight guard right now. Lets a deadline-bound caller skip a call it couldn't finish. */
export function hlWeightWaitMs(now: number = Date.now()): number {
  return weightWaitMs(weightLog, now);
}

function logWeight(weight: number) {
  const now = Date.now();
  weightLog.push({ t: now, weight });
  while (weightLog.length && weightLog[0]!.t <= now - WEIGHT_WINDOW_MS) weightLog.shift();
}

function responseWeight(type: string, json: unknown): number {
  const rows = Array.isArray(json) ? json.length : 0;
  if (type === "candleSnapshot") return 20 + Math.ceil(rows / 60);
  if (type === "fundingHistory") return 20 + Math.ceil(rows / 20);
  return 20;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(body: { type: string } & Record<string, unknown>, fetchFn: typeof fetch = fetch, attempt = 0): Promise<T> {
  for (let wait = weightWaitMs(weightLog, Date.now()); wait > 0; wait = weightWaitMs(weightLog, Date.now())) {
    await sleep(wait);
  }
  let r: Response;
  try {
    r = await fetchFn(HL_REST, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logWeight(20);
    if (attempt === 0) {
      await sleep(RETRY_DELAY_MS);
      return post<T>(body, fetchFn, 1);
    }
    throw new Error(`HL request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!r.ok) {
    logWeight(20);
    if ((r.status === 429 || r.status >= 500) && attempt === 0) {
      await sleep(RETRY_DELAY_MS);
      return post<T>(body, fetchFn, 1);
    }
    throw new Error(`HL ${r.status}`);
  }
  const json = (await r.json()) as T;
  logWeight(responseWeight(body.type, json));
  return json;
}

/** Any info request, under the same weight guard and retry as the typed fetchers. */
export function hlInfo<T>(body: { type: string } & Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<T> {
  return post<T>(body, fetchFn);
}

const num = (s: string | null | undefined): number | null => {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export async function fetchPerpMetaAndCtxs(
  fetchFn: typeof fetch = fetch,
): Promise<{ meta: HlRawPerpMeta; ctxs: AssetCtx[] }> {
  const raw = await post<unknown>({ type: "metaAndAssetCtxs" }, fetchFn);
  const [meta, ctxs] = HlMetaAndAssetCtxsResponseSchema.parse(raw);
  const assetCtxs: AssetCtx[] = meta.universe.map((u, i) => {
    const ctx = ctxs[i]!;
    const markPx = Number(ctx.markPx);
    const prev = Number(ctx.prevDayPx);
    return {
      name: u.name,
      szDecimals: u.szDecimals,
      markPx,
      oraclePx: Number(ctx.oraclePx),
      midPx: Number(ctx.midPx ?? ctx.markPx),
      dayNtlVlm: Number(ctx.dayNtlVlm),
      prevDayPx: prev,
      openInterest: Number(ctx.openInterest),
      funding: Number(ctx.funding),
      premium: ctx.premium == null ? 0 : Number(ctx.premium),
      dayChange: prev > 0 ? (markPx - prev) / prev : 0,
      isDelisted: u.isDelisted ?? false,
      maxLeverage: u.maxLeverage,
      dayBaseVlm: Number(ctx.dayBaseVlm),
      impactBidPx: num(ctx.impactPxs?.[0]),
      impactAskPx: num(ctx.impactPxs?.[1]),
    };
  });
  return { meta, ctxs: assetCtxs };
}

export type CandleInterval = Timeframe;

/** HL serves at most this many candles per call, and only the latest 5000 per interval exist. */
export const HL_MAX_CANDLES = 5000;

/**
 * Candles in [startTime, endTime], paginated forward whenever a full page
 * comes back. HL only keeps the latest 5000 bars per interval, so a range
 * older than that returns nothing: callers treat that as "HL has no earlier
 * history" and reach for another source.
 */
export async function fetchCandles(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  let cursor = startTime;
  for (;;) {
    const raw = await post<unknown>({ type: "candleSnapshot", req: { coin, interval, startTime: cursor, endTime } }, fetchFn);
    const rows = HlCandlesResponseSchema.parse(raw);
    for (const c of rows) {
      out.set(c.t, { t: c.t, T: c.T, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) });
    }
    if (rows.length < HL_MAX_CANDLES) break;
    const lastT = rows[rows.length - 1]!.t;
    if (lastT < cursor) break; // no progress: never loop forever
    cursor = lastT + 1;
    if (cursor >= endTime) break;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// ─── funding ───

const HlFundingRowSchema = z.object({
  coin: z.string(),
  fundingRate: z.string(),
  premium: z.string(),
  time: z.number(),
});

/** One hourly funding settlement. `rate` is the hourly rate (fraction); `premium` the sampled premium. */
export interface FundingPoint {
  t: number;
  rate: number;
  premium: number;
}

/** fundingHistory returns at most this many rows per call. */
export const HL_FUNDING_PAGE = 500;

/** One fundingHistory page: up to 500 rows from startTime (inclusive) forward. */
export async function fetchFundingPage(
  coin: string,
  startTime: number,
  endTime: number = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<FundingPoint[]> {
  const raw = await post<unknown>({ type: "fundingHistory", coin, startTime, endTime }, fetchFn);
  const out: FundingPoint[] = [];
  for (const row of z.array(z.unknown()).parse(raw)) {
    const p = HlFundingRowSchema.safeParse(row);
    if (!p.success) continue;
    const rate = num(p.data.fundingRate);
    const premium = num(p.data.premium);
    if (rate == null || premium == null) continue;
    out.push({ t: p.data.time, rate, premium });
  }
  return out.sort((a, b) => a.t - b.t);
}

const PredictedVenueSchema = z
  .object({
    fundingRate: z.string().optional(),
    nextFundingTime: z.number().optional(),
    fundingIntervalHours: z.number().optional(),
  })
  .nullable();
const PredictedFundingsSchema = z.array(z.tuple([z.string(), z.array(z.tuple([z.string(), PredictedVenueSchema]))]));

export interface PredictedFunding {
  venue: string;
  /** Rate per venue interval (fraction). */
  rate: number;
  intervalHours: number;
  nextFundingTime: number | null;
}

/** Predicted next funding per coin across venues (HlPerp, BinPerp, BybitPerp). */
export async function fetchPredictedFundings(fetchFn: typeof fetch = fetch): Promise<Map<string, PredictedFunding[]>> {
  const raw = await post<unknown>({ type: "predictedFundings" }, fetchFn);
  const out = new Map<string, PredictedFunding[]>();
  for (const [coin, venues] of PredictedFundingsSchema.parse(raw)) {
    const list: PredictedFunding[] = [];
    for (const [venue, v] of venues) {
      const rate = num(v?.fundingRate);
      if (v == null || rate == null) continue;
      // HL omits the interval on its own entry in older payloads; it settles hourly.
      const intervalHours = v.fundingIntervalHours ?? (venue === "HlPerp" ? 1 : 8);
      list.push({ venue, rate, intervalHours, nextFundingTime: v.nextFundingTime ?? null });
    }
    out.set(coin, list);
  }
  return out;
}

/** Coins currently at their open-interest cap (new positions can only reduce). */
export async function fetchPerpsAtOpenInterestCap(fetchFn: typeof fetch = fetch): Promise<string[]> {
  const raw = await post<unknown>({ type: "perpsAtOpenInterestCap" }, fetchFn);
  return z.array(z.string()).parse(raw);
}
