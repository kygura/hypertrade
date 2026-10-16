import { z } from "zod";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import { HlSocket, type HlSocketState } from "../../shared/hl-ws.js";
import type { PlatformHealth } from "../../shared/platform.js";
import { bus as defaultBus, type Bus } from "./bus.js";

// Server-side HL ingest (SPEC P0.4 `ws`): allMids + trades for every listed
// perp. Keeps a live mid per coin with its receive time and hands each trade's
// two counterparties to `onAddresses`. Every payload is validated; malformed
// messages are dropped and counted, never thrown.

const UNIVERSE_REFRESH_MS = 3_600_000;
const SILENT_MS = 60_000;
/** A mid older than this is not a price (outcomes fall back to the scan mark; the freshness gate refuses). */
export const MID_MAX_AGE_MS = 30_000;

const Num = z.string().transform(Number).pipe(z.number().finite().positive());
const Mids = z.record(z.string(), Num);
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
// Live shape (verified 2026-10-16): {coin, side, px, sz, time, hash, tid, users: [buyer, seller]}.
const Trade = z.object({ coin: z.string().min(1), px: Num, sz: Num, time: z.number(), users: z.tuple([Addr, Addr]) });
export type WsTrade = z.infer<typeof Trade>;

/** allMids `data` is `{mids: {coin: "px"}}`. Entries with a bad price are skipped; null if the envelope is wrong. */
export function parseMids(data: unknown): Map<string, number> | null {
  const env = z.object({ mids: z.record(z.string(), z.unknown()) }).safeParse(data);
  if (!env.success) return null;
  const out = new Map<string, number>();
  for (const [coin, raw] of Object.entries(env.data.mids)) {
    const px = Num.safeParse(raw);
    if (px.success) out.set(coin, px.data);
  }
  return out;
}

/** trades `data` is an array; returns the valid trades and how many entries were malformed (null if not an array). */
export function parseTrades(data: unknown): { trades: WsTrade[]; bad: number } | null {
  if (!Array.isArray(data)) return null;
  const trades: WsTrade[] = [];
  for (const t of data) {
    const r = Trade.safeParse(t);
    if (r.success) trades.push(r.data);
  }
  return { trades, bad: data.length - trades.length };
}

export interface WsIngestDeps {
  socket?: HlSocket;
  bus?: Bus;
  now?: () => number;
  /** Listed perps; default: metaAndAssetCtxs via hl-client. */
  universe?: () => Promise<string[]>;
  /** Called with both counterparties of each valid trade. */
  onAddresses?: (addresses: string[], tradeTimeMs: number) => void;
}

export type WsIngest = ReturnType<typeof createWsIngest>;

export function createWsIngest(deps: WsIngestDeps = {}) {
  const now = deps.now ?? Date.now;
  const bus = deps.bus ?? defaultBus;
  const socket = deps.socket ?? new HlSocket({ idleCloseMs: 0, staleMs: SILENT_MS });
  const mids = new Map<string, { px: number; receivedAt: number }>();
  const subscribed = new Set<string>();
  let started = false;
  let universeAt = -Infinity;
  let dropped = 0;
  let lastMessageAt = 0;
  let state: PlatformHealth["ws"]["state"] = "off";
  const universe = deps.universe ?? (async () => (await fetchPerpMetaAndCtxs()).ctxs.filter((c) => !c.isDelisted).map((c) => c.name));

  const setState = (s: HlSocketState) => {
    if (s === state) return;
    state = s;
    bus.publish("ws", { state, ts: new Date(now()).toISOString() });
  };
  const onMids = (data: unknown) => {
    const m = parseMids(data);
    if (!m) return void dropped++;
    lastMessageAt = now();
    for (const [coin, px] of m) mids.set(coin, { px, receivedAt: lastMessageAt });
  };
  const onTrades = (data: unknown) => {
    const r = parseTrades(data);
    if (!r) return void dropped++;
    lastMessageAt = now();
    dropped += r.bad;
    for (const t of r.trades) deps.onAddresses?.([...t.users], t.time);
  };

  return {
    /** Idempotent: opens the socket, subscribes allMids, then trades for the universe. */
    async tick() {
      if (!started) {
        started = true;
        socket.onState(setState);
        socket.subscribe({ type: "allMids" }, onMids);
      }
      if (now() - universeAt > UNIVERSE_REFRESH_MS) {
        for (const coin of await universe()) {
          if (subscribed.has(coin)) continue;
          subscribed.add(coin);
          socket.subscribe({ type: "trades", coin }, onTrades);
        }
        universeAt = now();
      }
      if (state === "open" && lastMessageAt && now() - lastMessageAt > SILENT_MS) throw new Error("ws silent");
    },
    stop() {
      socket.stop();
    },
    mid: (coin: string) => mids.get(coin)?.px ?? null,
    /** Ms since the coin's last mid update, or null if never seen. */
    midAgeMs: (coin: string, at: number = now()) => {
      const m = mids.get(coin);
      return m ? at - m.receivedAt : null;
    },
    get state() {
      return state;
    },
    lastMessageAgeSec: (at: number = now()) => (lastMessageAt ? Math.max(0, (at - lastMessageAt) / 1000) : null),
    get dropped() {
      return dropped;
    },
    get subscribed() {
      return subscribed.size;
    },
  };
}
