// Daily OI history backfill for hl.oi.<COIN> from Coinalyze (Hyperliquid's own perp market, exchange "Hyperliquid",
// not the aggregate), so the novelty detector's 365-day OI gate can open before 365 days of live snapshots exist.
// Same series, unit and timestamp convention as the live collector (collectors/hyperliquid.ts):
//   - unit: USD notional. Live = openInterest(coins) * markPx. Coinalyze is asked in coins (convert_to_usd=false) and
//     multiplied by the stored 1d candle close of the same day, so noveltyLoop's oi / close recovers the coin count exactly.
//   - ts: live points are instants and alignDaily keeps the last per UTC day; a Coinalyze daily bar (t = day start, c = OI at
//     the end of that day) is stored at 23:59:59Z of its day. The still-open current day is never written.
//   - never overwrites: a day that already has any observation (live or earlier backfill) is skipped, so re-runs insert nothing.
// observations has no per-row provenance column; backfilled rows are recognisable only by their 23:59:59 timestamp.
// Rate limit: 40 calls/min per key; calls are serialised 1.6 s apart.
import { z } from "zod";
import { ensureSeries, seriesRange, upsertObservations } from "../db.js";
import { defaultHtDeps } from "../lab/providers/ht.js";
import { NOVELTY } from "../platform/novelty.js";
import { COINALYZE_BASE_URL } from "./coinalyze.js";

const DAY = 86_400_000;
const CALL_GAP_MS = 1_600;
/** How far back OI is requested (HL perps listed in 2023; a coin's history simply starts at its listing). */
const BACKFILL_DAYS = 1500;

const ExchangesSchema = z.array(z.object({ name: z.string(), code: z.string() }));
const MarketsSchema = z.array(z.object({ symbol: z.string(), exchange: z.string(), base_asset: z.string(), is_perpetual: z.boolean() }));
const OiSchema = z.array(z.object({ symbol: z.string(), history: z.array(z.object({ t: z.number(), c: z.number().nonnegative() })) }));

const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;

/** Pure: coin -> Coinalyze symbol of the Hyperliquid perp. */
export function hlSymbolMap(exchangesRaw: unknown, marketsRaw: unknown): Map<string, string> {
  const code = ExchangesSchema.parse(exchangesRaw).find((e) => e.name.toLowerCase() === "hyperliquid")?.code;
  const out = new Map<string, string>();
  for (const m of MarketsSchema.parse(marketsRaw)) if (m.exchange === code && m.is_perpetual && !out.has(m.base_asset)) out.set(m.base_asset, m.symbol);
  return out;
}

/** Pure: Coinalyze open-interest-history response -> OI in coins per UTC day start. */
export function parseDailyOi(raw: unknown): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of OiSchema.parse(raw)[0]?.history ?? []) out.set(dayStart(p.t * 1000), p.c);
  return out;
}

export interface OiRow { seriesId: string; ts: Date; value: number }

/** Pure: backfill rows = closed days with a candle close and no stored observation. */
export function oiRows(coin: string, coins: Map<number, number>, closes: Map<number, number>, haveDays: Set<number>, now: number): OiRow[] {
  const rows: OiRow[] = [];
  for (const [d, oi] of [...coins].sort(([a], [b]) => a - b)) {
    const close = closes.get(d);
    if (d + DAY > now || haveDays.has(d) || !close || close <= 0) continue;
    rows.push({ seriesId: `hl.oi.${coin}`, ts: new Date(d + DAY - 1000), value: oi * close });
  }
  return rows;
}

export interface OiBackfillDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Stored 1d candles (t = day start, c = close). */
  candles(coin: string): Promise<Array<{ t: number; c: number }>>;
  /** Stored hl.oi.<coin> observations. */
  stored(coin: string): Promise<Array<{ t: number }>>;
  insert(coin: string, rows: OiRow[]): Promise<void>;
}

/** HTTP 429: the caller may retry the coin on its next run. */
export class OiRateLimited extends Error {}
const MAP_RETRY_MS = 3_600_000;

/** Returns backfill(coin) -> rows inserted. Skips (0, no API call) without a key or when the coin already has the novelty minimum of OI days. Throws on HTTP errors. */
export function createOiBackfill(deps: OiBackfillDeps) {
  const key = deps.env.COINALYZE_API_KEY?.trim();
  let last = 0;
  let symbols: Map<string, string> | undefined;
  /** A failed (or empty) symbol-map fetch is not retried for MAP_RETRY_MS: every coin would otherwise repeat the slow calls. */
  let mapFailedAt = -Infinity;
  const get = async (path: string, params: Record<string, string> = {}): Promise<unknown> => {
    const wait = last + CALL_GAP_MS - deps.now();
    if (wait > 0) await deps.sleep(wait);
    last = deps.now();
    const res = await deps.fetch(`${COINALYZE_BASE_URL}/${path}?${new URLSearchParams(params)}`, { headers: { api_key: key!, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) throw new OiRateLimited(`coinalyze ${path}: rate limited (429)`);
    if (!res.ok) throw new Error(`coinalyze ${path}: HTTP ${res.status}`);
    return res.json();
  };
  return async (coin: string): Promise<number> => {
    if (!key) return 0;
    const have = new Set((await deps.stored(coin)).map((p) => dayStart(p.t)));
    if (have.size >= NOVELTY.minOiDays) return 0;
    if (!symbols) {
      if (deps.now() - mapFailedAt < MAP_RETRY_MS) return 0;
      try {
        const m = hlSymbolMap(await get("exchanges"), await get("future-markets"));
        if (!m.size) throw new Error("coinalyze lists no Hyperliquid perps");
        symbols = m;
      } catch (e) {
        mapFailedAt = deps.now();
        throw e;
      }
    }
    const symbol = symbols.get(coin);
    if (!symbol) return 0;
    const now = deps.now();
    const raw = await get("open-interest-history", { symbols: symbol, interval: "daily", from: String(Math.floor((now - BACKFILL_DAYS * DAY) / 1000)), to: String(Math.floor(now / 1000)), convert_to_usd: "false" });
    const closes = new Map((await deps.candles(coin)).map((c) => [dayStart(c.t), c.c]));
    const rows = oiRows(coin, parseDailyOi(raw), closes, have, now);
    if (rows.length) await deps.insert(coin, rows);
    return rows.length;
  };
}

/** Production wiring (env key, platform tables). */
export const defaultOiBackfill = () =>
  createOiBackfill({
    fetch,
    env: process.env,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    candles: (coin) => defaultHtDeps.candles(coin, 0),
    stored: async (coin) => (await seriesRange(`hl.oi.${coin}`)).map((p) => ({ t: new Date(p.ts).getTime() })),
    insert: async (coin, rows) => {
      // Same def as the live collector, so ensureSeries leaves the series unchanged.
      await ensureSeries([{ id: `hl.oi.${coin}`, source: "hyperliquid", units: "USD", description: `${coin} open interest (Hyperliquid)` }]);
      await upsertObservations(rows);
    },
  });
