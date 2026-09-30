import { Hono } from "hono";
import { fetchPerpsAtOpenInterestCap, fetchPredictedFundings, type PredictedFunding } from "../../shared/hl-client.js";
import type { PerpStats } from "../../shared/market.js";
import * as db from "../db.js";
import { syncFunding } from "../market/fundingSync.js";
import { getCtxs, resolveCoin } from "./hl.js";

export type { PerpStats };

// GET /perp/:coin — everything Hyperliquid exposes about one perp beyond its
// candles: the live asset context (mark/oracle/premium/funding/OI/volume,
// impact prices, max leverage), cross-venue predicted funding, the OI-cap
// flag, trailing funding averages and OI change from stored history.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CACHE_MS = 60_000;

let predictedCache: { ts: number; data: Map<string, PredictedFunding[]> } | null = null;
let capCache: { ts: number; data: Set<string> } | null = null;

async function predicted(coin: string): Promise<PredictedFunding[]> {
  if (!predictedCache || Date.now() - predictedCache.ts >= CACHE_MS) {
    predictedCache = { ts: Date.now(), data: await fetchPredictedFundings() };
  }
  return predictedCache.data.get(coin) ?? [];
}

async function atCap(coin: string): Promise<boolean> {
  if (!capCache || Date.now() - capCache.ts >= CACHE_MS) {
    capCache = { ts: Date.now(), data: new Set(await fetchPerpsAtOpenInterestCap()) };
  }
  return capCache.data.has(coin);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Mean of `rate` over rows newer than `since`, only when history reaches back that far. */
export function trailingMean(rows: { t: number; rate: number }[], since: number): number | null {
  if (!rows.length || rows[0]!.t > since + 2 * HOUR) return null;
  return mean(rows.filter((r) => r.t > since).map((r) => r.rate));
}

/** Fractional change from the point nearest `ago` before the last point (within `tol`) to the last. */
export function changeSince(points: { t: number; v: number }[], ago: number, tol: number): number | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1]!;
  const target = last.t - ago;
  let best: { t: number; v: number } | null = null;
  for (const p of points) {
    if (Math.abs(p.t - target) <= tol && (!best || Math.abs(p.t - target) < Math.abs(best.t - target))) best = p;
  }
  return best && best.v > 0 ? last.v / best.v - 1 : null;
}

export const perpRoutes = new Hono().get("/:coin", async (c) => {
  const coin = await resolveCoin(c.req.param("coin"));
  const now = Date.now();

  const [ctxRes, pred, cap] = await Promise.all([
    getCtxs().catch(() => null),
    predicted(coin).catch(() => []),
    atCap(coin).catch(() => false),
  ]);
  const a = ctxRes?.ctxs.find((x) => x.name === coin) ?? null;

  await syncFunding(coin, now - 30 * DAY, { maxPages: 2, deadline: now + 5_000 }).catch(() => null);
  const [fundingRows, oiPts] = await Promise.all([
    db.getFunding(coin, new Date(now - 30 * DAY - HOUR), new Date(now)).catch(() => []),
    db.seriesRange(`hl.oi.${coin}`, new Date(now - 8 * DAY), new Date(now)).catch(() => []),
  ]);
  const f = fundingRows.map((r) => ({ t: r.ts.getTime(), rate: r.rate }));
  const oi = oiPts.map((p) => ({ t: new Date(p.ts).getTime(), v: p.value }));

  const body: PerpStats = {
    coin,
    fetchedAt: new Date(ctxRes?.fetchedAt ?? now).toISOString(),
    ctx: a && {
      markPx: a.markPx,
      oraclePx: a.oraclePx,
      midPx: a.midPx,
      premium: a.premium,
      funding: a.funding,
      openInterest: a.openInterest,
      openInterestUsd: a.openInterest * a.markPx,
      dayNtlVlm: a.dayNtlVlm,
      dayBaseVlm: a.dayBaseVlm ?? null,
      prevDayPx: a.prevDayPx,
      dayChange: a.dayChange,
      maxLeverage: a.maxLeverage ?? null,
      impactBidPx: a.impactBidPx ?? null,
      impactAskPx: a.impactAskPx ?? null,
      isDelisted: a.isDelisted,
    },
    atOiCap: cap,
    predicted: pred,
    fundingAvg: { h24: trailingMean(f, now - DAY), d7: trailingMean(f, now - 7 * DAY), d30: trailingMean(f, now - 30 * DAY) },
    oiChange: { h24: changeSince(oi, DAY, HOUR), d7: changeSince(oi, 7 * DAY, 3 * HOUR) },
  };
  return c.json(body);
});
