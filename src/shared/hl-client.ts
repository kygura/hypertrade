// Hyperliquid public REST + WS client. No auth required. Isomorphic: the REST
// calls are plain `fetch` and run on server or browser; HLSocket only touches
// the `WebSocket` global inside connect() (never at module load), so importing
// this module from server code is always safe even where WebSocket is absent.
import { HlAllMidsSchema, HlCandlesResponseSchema, HlMetaAndAssetCtxsResponseSchema } from "./schemas";
import type { AllMids, AssetCtx, Candle, HlRawPerpMeta } from "./types";

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

export async function fetchAllMids(fetchFn: typeof fetch = fetch): Promise<AllMids> {
  return HlAllMidsSchema.parse(await post({ type: "allMids" }, fetchFn));
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

// ─── WebSocket ───

type WsHandler = (data: unknown) => void;

export class HLSocket {
  private ws?: WebSocket;
  private handlers = new Map<string, Set<WsHandler>>();
  private subs: Array<Record<string, unknown>> = [];
  private reconnectMs = 1000;
  private maxReconnectMs = 30_000;
  private alive = true;
  private onConnChange?: (connected: boolean) => void;

  constructor(onConnChange?: (connected: boolean) => void) {
    this.onConnChange = onConnChange;
    this.connect();
  }

  private connect() {
    if (!this.alive) return;
    if (typeof WebSocket === "undefined") return; // no-op outside a browser (e.g. imported server-side)
    const ws = new WebSocket(HL_WS);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectMs = 1000;
      this.onConnChange?.(true);
      for (const s of this.subs) {
        ws.send(JSON.stringify({ method: "subscribe", subscription: s }));
      }
    };
    ws.onclose = () => {
      this.onConnChange?.(false);
      if (!this.alive) return;
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as { channel?: string; data?: unknown };
        if (!msg.channel) return;
        const set = this.handlers.get(msg.channel);
        if (set) for (const fn of set) fn(msg.data);
      } catch {
        // ignore malformed frame
      }
    };
  }

  subscribe(sub: Record<string, unknown>, channel: string, handler: WsHandler) {
    this.subs.push(sub);
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    if (typeof WebSocket !== "undefined" && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: "subscribe", subscription: sub }));
    }
    return () => {
      set!.delete(handler);
    };
  }

  close() {
    this.alive = false;
    this.ws?.close();
  }
}
