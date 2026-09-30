// Hyperliquid public REST client. No auth required. Isomorphic: the REST
// calls are plain `fetch` and run on server or browser.
import { HlCandlesResponseSchema, HlMetaAndAssetCtxsResponseSchema } from "./schemas.js";
import type { AssetCtx, Candle, HlRawPerpMeta } from "./types.js";

export const HL_REST = "https://api.hyperliquid.xyz/info";
export const HL_WS = "wss://api.hyperliquid.xyz/ws";

async function post<T>(body: unknown, fetchFn: typeof fetch = fetch): Promise<T> {
  const r = await fetchFn(HL_REST, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HL ${r.status}`);
  return (await r.json()) as T;
}

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
    };
  });
  return { meta, ctxs: assetCtxs };
}

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export async function fetchCandles(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number = Date.now(),
  fetchFn: typeof fetch = fetch,
): Promise<Candle[]> {
  const raw = await post<unknown>(
    { type: "candleSnapshot", req: { coin, interval, startTime, endTime } },
    fetchFn,
  );
  return HlCandlesResponseSchema.parse(raw).map((c) => ({
    t: c.t,
    T: c.T,
    o: Number(c.o),
    h: Number(c.h),
    l: Number(c.l),
    c: Number(c.c),
    v: Number(c.v),
  }));
}
