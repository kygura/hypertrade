// Coinalyze flow collector (docs/SPEC.md § Flow F0.1). Runs inside the collect
// cron after the Intel snapshot write and fills intel_flow for held ∪ watched
// coins (capped at INTEL_FLOW_MAX_COINS, by notional then watch order):
// liquidations, perp and spot volume, long/short ratio, OI and funding at
// 15-min intervals, from the last stored ts per (asset, venue, metric) or 24 h
// back. Perp metrics use the aggregated symbol `<COIN>USDT_PERP.A` (venue
// `agg`); spot volume uses one spot market per coin (venue = its exchange code).
// The symbol map comes from /future-markets + /spot-markets once per run.
//
// Rate limit: 40 calls/min per key, each symbol in a multi-symbol call counts.
// The cron fires every 15 min, so a run spends at most CALLS_PER_RUN and stops
// (a 429 also stops it); what it did not reach is picked up next run from the
// last stored ts. Endpoints run most-useful first (liquidations and volumes
// feed detectors; OI and funding are HL's in the snapshots).
// No COINALYZE_API_KEY → recorded as skipped. Never throws.
import { z } from "zod";
import type { FlowMetric, FlowRow } from "../../shared/intel.js";
import type { IntelStore } from "../intel/store.js";

export const COINALYZE_COLLECTOR = "intel:flow:coinalyze";
export const COINALYZE_BASE_URL = "https://api.coinalyze.net/v1";
export const PERP_VENUE = "agg";
export const CALLS_PER_RUN = 40;
export const FLOW_BUDGET_MS = 60_000;
export const DEFAULT_MAX_COINS = 8;
const MAX_SYMBOLS = 20;
const LOOKBACK_MS = 24 * 3_600_000;
const SKIPPED_NO_KEY = "skipped:no-key";
/** ponytail: /spot-markets has no volume, so "highest-volume exchange" is a static ranking of Coinalyze exchange codes (aggregate/Binance, Coinbase, Bybit, OKX); any other listing comes after. */
const SPOT_EXCHANGES = ["A", "C", "6", "3"];
const SPOT_QUOTES = ["USDT", "USD", "USDC"];

type Bar = Record<string, number | undefined>;
type Market = "perp" | "spot";
interface Endpoint {
  path: string;
  market: Market;
  usd?: boolean;
  rows(b: Bar): Array<[FlowMetric, number | undefined]>;
}

/** ponytail: OHLCV volume is taken as base-asset units × close; if Coinalyze reports it in quote, the level is off by a price factor (z is unaffected). */
const usd = (v: number | undefined, c: number | undefined) => (v == null || c == null ? undefined : v * c);

export const ENDPOINTS: Endpoint[] = [
  { path: "liquidation-history", market: "perp", usd: true, rows: (b) => [["liq_long_usd", b.l], ["liq_short_usd", b.s]] },
  { path: "ohlcv-history", market: "perp", rows: (b) => [["perp_volume_usd", usd(b.v, b.c)], ["perp_buy_volume_usd", usd(b.bv, b.c)]] },
  { path: "ohlcv-history", market: "spot", rows: (b) => [["spot_volume_usd", usd(b.v, b.c)]] },
  { path: "long-short-ratio-history", market: "perp", rows: (b) => [["long_short_ratio", b.r]] },
  { path: "open-interest-history", market: "perp", usd: true, rows: (b) => [["oi_usd", b.c]] },
  // Coinalyze funding is in percent; stored as a fraction like the rest of the app.
  { path: "funding-rate-history", market: "perp", rows: (b) => [["funding", b.c == null ? undefined : b.c / 100]] },
];

const FutureMarketSchema = z.object({ symbol: z.string(), base_asset: z.string(), is_perpetual: z.boolean().optional() }).passthrough();
const SpotMarketSchema = z.object({ symbol: z.string(), base_asset: z.string(), quote_asset: z.string() }).passthrough();
const HistorySchema = z.array(z.object({ symbol: z.string(), history: z.array(z.object({ t: z.number() }).passthrough()) }));

export interface FlowSymbols {
  perp?: string;
  spot?: { symbol: string; venue: string };
}

/** HL lists 1000x memes as kPEPE; Coinalyze uses the base asset (PEPE). */
const baseOf = (coin: string) => coin.replace(/^k(?=[A-Z0-9])/, "").toUpperCase();
const exchangeCode = (symbol: string) => symbol.slice(symbol.lastIndexOf(".") + 1);

/** Pure: per coin, the aggregated perp symbol (when any perpetual lists it) and one spot market. */
export function symbolMap(futuresRaw: unknown, spotRaw: unknown, coins: string[]): Map<string, FlowSymbols> {
  const futures = z.array(FutureMarketSchema).catch([]).parse(futuresRaw);
  const spot = z.array(SpotMarketSchema).catch([]).parse(spotRaw);
  const rank = (s: z.infer<typeof SpotMarketSchema>) => {
    const ex = SPOT_EXCHANGES.indexOf(exchangeCode(s.symbol));
    return (ex < 0 ? SPOT_EXCHANGES.length : ex) * SPOT_QUOTES.length + SPOT_QUOTES.indexOf(s.quote_asset.toUpperCase());
  };
  const out = new Map<string, FlowSymbols>();
  for (const coin of coins) {
    const base = baseOf(coin);
    const s: FlowSymbols = {};
    if (futures.some((m) => m.is_perpetual !== false && m.base_asset.toUpperCase() === base)) s.perp = `${base}USDT_PERP.A`;
    const best = spot
      .filter((m) => m.base_asset.toUpperCase() === base && SPOT_QUOTES.includes(m.quote_asset.toUpperCase()))
      .sort((a, b) => rank(a) - rank(b))[0];
    if (best) s.spot = { symbol: best.symbol, venue: exchangeCode(best.symbol) };
    if (s.perp || s.spot) out.set(coin, s);
  }
  return out;
}

/** Pure: one endpoint's response → flow rows. Unknown symbols, missing fields and non-finite values are dropped. */
export function parseHistory(raw: unknown, ep: Endpoint, bySymbol: Map<string, { asset: string; venue: string }>): FlowRow[] {
  const rows: FlowRow[] = [];
  for (const s of HistorySchema.parse(raw)) {
    const key = bySymbol.get(s.symbol);
    if (!key) continue;
    for (const bar of s.history) {
      const ts = new Date(bar.t * 1000).toISOString();
      for (const [metric, value] of ep.rows(bar as Bar)) {
        if (value != null && Number.isFinite(value)) rows.push({ ...key, metric, value, ts });
      }
    }
  }
  return rows;
}

/** Held assets by notional (largest first), then watched, deduped, at most `max`. */
export function flowCoins(positions: Array<{ asset: string; notionalUsd: number }>, watched: string[], max: number): string[] {
  const held = [...positions].sort((a, b) => Math.abs(b.notionalUsd) - Math.abs(a.notionalUsd)).map((p) => p.asset);
  return [...new Set([...held, ...watched])].slice(0, max);
}

/** INTEL_FLOW_MAX_COINS, 1..20 (one multi-symbol call per endpoint), default 8. */
export function maxFlowCoins(env: Record<string, string | undefined>): number {
  const n = Number(env.INTEL_FLOW_MAX_COINS);
  return env.INTEL_FLOW_MAX_COINS?.trim() && Number.isFinite(n) ? Math.min(MAX_SYMBOLS, Math.max(1, Math.round(n))) : DEFAULT_MAX_COINS;
}

export interface FlowCollectDeps {
  fetch: typeof fetch;
  store: Pick<IntelStore, "insertFlow" | "latestFlowTs">;
  /** Held ∪ watched, already capped (flowCoins). */
  coins(): Promise<string[]>;
  recordRun(collector: string, startedAt: Date, ok: boolean, error?: string | null): Promise<void>;
  env: Record<string, string | undefined>;
  now(): number;
  /** Time budget for the run; default FLOW_BUDGET_MS (the collect route passes what is left of its shared budget). */
  budgetMs?: number;
}

export interface FlowCollectResult {
  ok: boolean;
  written: number;
  coins: number;
  /** Rate-limit units spent (one per symbol per call). */
  calls: number;
  errors: string[];
  error?: string;
}

class RateLimited extends Error {}

export async function collectCoinalyze(deps: FlowCollectDeps): Promise<FlowCollectResult> {
  const startedAt = new Date(deps.now());
  const key = deps.env.COINALYZE_API_KEY?.trim();
  const out: FlowCollectResult = { ok: true, written: 0, coins: 0, calls: 0, errors: [] };
  const record = (ok: boolean, error: string | null) => deps.recordRun(COINALYZE_COLLECTOR, startedAt, ok, error?.slice(0, 500) ?? null).catch(() => {});
  if (!key) {
    await record(true, SKIPPED_NO_KEY);
    return { ...out, error: SKIPPED_NO_KEY };
  }
  const deadline = startedAt.getTime() + Math.min(FLOW_BUDGET_MS, deps.budgetMs ?? FLOW_BUDGET_MS);
  let attempted = 0;
  const get = async (path: string, cost: number, params: Record<string, string> = {}): Promise<unknown> => {
    out.calls += cost;
    const res = await deps.fetch(`${COINALYZE_BASE_URL}/${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`, {
      headers: { api_key: key, accept: "application/json" },
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - deps.now()))),
    });
    if (res.status === 429) throw new RateLimited(`${path}: rate limited (429)`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };

  try {
    if (deps.now() >= deadline) {
      out.errors.push("skipped, time budget");
      await record(true, out.errors[0]!);
      return out;
    }
    const coins = await deps.coins();
    out.coins = coins.length;
    if (!coins.length) {
      await record(true, null);
      return out;
    }
    const [futures, spot] = await Promise.all([get("future-markets", 1), get("spot-markets", 1)]);
    const symbols = symbolMap(futures, spot, coins);
    const nowS = Math.floor(deps.now() / 1000);
    for (const ep of ENDPOINTS) {
      const bySymbol = new Map<string, { asset: string; venue: string }>();
      for (const [asset, s] of symbols) {
        const sym = ep.market === "perp" ? s.perp : s.spot?.symbol;
        if (sym) bySymbol.set(sym, { asset, venue: ep.market === "perp" ? PERP_VENUE : s.spot!.venue });
      }
      if (!bySymbol.size) continue;
      if (out.calls + bySymbol.size > CALLS_PER_RUN || deps.now() >= deadline) {
        out.errors.push(`${ep.path} (${ep.market}): skipped, ${out.calls + bySymbol.size > CALLS_PER_RUN ? "call budget" : "time budget"}`);
        continue;
      }
      // `from` = the oldest "last stored ts" across the batch (inclusive, so the still-open interval is refreshed).
      const metric = ep.rows({})[0]![0];
      const latest = await Promise.all([...bySymbol.values()].map((k) => deps.store.latestFlowTs(k.asset, k.venue, metric)));
      const from = Math.min(...latest.map((ts) => (ts ? Date.parse(ts) : deps.now() - LOOKBACK_MS)));
      if (deps.now() >= deadline) {
        out.errors.push(`${ep.path} (${ep.market}): skipped, time budget`);
        continue;
      }
      attempted++;
      try {
        const raw = await get(ep.path, bySymbol.size, {
          symbols: [...bySymbol.keys()].join(","),
          interval: "15min",
          from: String(Math.floor(from / 1000)),
          to: String(nowS),
          ...(ep.usd ? { convert_to_usd: "true" } : {}),
        });
        out.written += await deps.store.insertFlow(parseHistory(raw, ep, bySymbol));
      } catch (e) {
        if (e instanceof RateLimited) throw e;
        out.errors.push(`${ep.path} (${ep.market}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // An attempted run that wrote nothing is a failed run (a quiet market still rewrites the open interval).
    out.ok = out.written > 0 || attempted === 0;
    await record(out.ok, out.errors.length ? out.errors.join("; ") : null);
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await record(false, error);
    return { ...out, ok: false, error };
  }
}
