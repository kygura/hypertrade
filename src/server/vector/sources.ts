import { z } from "zod";
import type { FundingPoint } from "../../shared/hl-client.js";
import type { AltData, FundingRow, OiRow, Row } from "../../shared/vectorCompass.js";
import type { DailyBar } from "../../shared/cycles.js";
import * as db from "../db.js";
import { normCdf } from "../lab/engine/stats.js";
import { CM_BASE, parseCmPage } from "../lab/providers/cm.js";
import { createDeribitProvider } from "../lab/providers/deribit.js";
import { createFngProvider } from "../lab/providers/fng.js";
import { defaultHtDeps, htProvider } from "../lab/providers/ht.js";
import { LLAMA_STABLES_URL, parseStablecoinChart } from "../lab/providers/llama.js";
import { OKX_OI_EPOCH, okxProvider } from "../lab/providers/okx.js";
import { dayStart, getJson, HttpError, REQUEST_TIMEOUT_MS } from "../lab/providers/series.js";
import type { DailySeries } from "../lab/types.js";
import { mapLimit } from "../lab/util.js";
import { errDetail, fetchFred } from "../radar/macro.js";
import { defaultCyclesDeps, loadHistory } from "../routes/cycles.js";

// The Vector's daily inputs (ported from hl-cycles backend/src/vectorSources.ts and
// sources/*). Existing Lab fetchers are reused where they exist (Coin Metrics page
// parser, Deribit DVOL, Fear & Greed, DefiLlama, OKX OI, ht funding/candles, FRED
// fredgraph CSV via radar/macro.ts); bitcoin-data.com (BGeometrics) and the Deribit
// options-skew snapshot are new here. Every loader parses at the boundary and
// throws on failure; routes/vector.ts runs each on its own so one failing source
// only nulls its own inputs.

export type SeriesMap = Record<string, Row[]>;

/** What one source contributes to the model. `error` marks a partial result; `fetchedAt` dates data served from storage. */
export type SourceData = {
  series?: SeriesMap;
  daily?: DailyBar[];
  funding?: FundingRow[];
  oi?: OiRow[];
  alts?: AltData[];
  error?: string;
  fetchedAt?: number;
};

const DAY = 86_400_000;
/** FRED history: the 4y percentile window plus a year of warm-up (200d SMA, 90d change). */
const FRED_DAYS = 6 * 365;
const FRED_TIMEOUT_MS = 20_000;
/** Funding history: the 4y percentile window plus warm-up (only reachable from storage; live tops out near 500 days). */
const FUNDING_DAYS = 5 * 365 + 30;
/** Alts' funding fetched live when not stored: enough for the 7d mean now and a few weeks of breadth history. */
const ALT_LIVE_FUNDING_DAYS = 30;
const ALT_CONCURRENCY = 3;

/** The rotation basket (hl-cycles assets.ts, BTC left out). */
const VECTOR_ALTS = ["ETH", "SOL", "XRP", "HYPE", "LIT", "SUI", "NEAR", "ENA", "DOGE", "PUMP", "TAO"] as const;

const toRows = (s: DailySeries): Row[] => s.t.map((t, i) => ({ t, v: s.v[i]! }));

/** Dedup by UTC day (last write wins), finite values only, ascending. */
function dailyRows(pairs: Iterable<[number, number]>): Row[] {
  const byDay = new Map<number, number>();
  for (const [t, v] of pairs) if (Number.isFinite(t) && Number.isFinite(v)) byDay.set(dayStart(t), v);
  return [...byDay.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

/** Stored rows under fresh ones: a day present in both reads the fresh value. */
export function mergeSeries(older: SeriesMap, newer: SeriesMap): SeriesMap {
  const out: SeriesMap = { ...older };
  for (const [k, rows] of Object.entries(newer)) out[k] = dailyRows([...(older[k] ?? []), ...rows].map((r) => [r.t, r.v] as [number, number]));
  return out;
}

// Number("") and Number(null) are 0, a real-looking value, so blanks are rejected explicitly.
function finite(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x !== "string" || x.trim() === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// ─── Coin Metrics (one multi-metric request) ───

const CM_METRICS = ["CapMrktCurUSD", "CapMVRVCur", "SplyCur", "AdrActCnt", "TxCnt", "FeeTotNtv", "HashRate", "SplyExNtv", "FlowInExNtv"] as const;
const CM_MAX_PAGES = 5; // full BTC history is one page at page_size 10000

/**
 * Asset-metrics pages → one daily series per metric, plus RealizedCapUSD = mcap / MVRV and
 * RealizedPriceUSD = realized cap / supply (`CapRealUSD` is refused on the community tier).
 */
export function parseCoinMetrics(pages: unknown[]): SeriesMap {
  const pairs: Record<string, [number, number][]> = {};
  for (const page of pages) for (const m of CM_METRICS) for (const p of parseCmPage(page, m).points) (pairs[m] ??= []).push([p.t, p.v]);
  const out: SeriesMap = Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, dailyRows(v)]));
  const mvrv = new Map((out.CapMVRVCur ?? []).map((r) => [r.t, r.v]));
  const sply = new Map((out.SplyCur ?? []).map((r) => [r.t, r.v]));
  const realCap: [number, number][] = [];
  const realPrice: [number, number][] = [];
  for (const { t, v: mcap } of out.CapMrktCurUSD ?? []) {
    const m = mvrv.get(t);
    if (m == null || m <= 0) continue;
    realCap.push([t, mcap / m]);
    const s = sply.get(t);
    if (s != null && s > 0) realPrice.push([t, mcap / m / s]);
  }
  out.RealizedCapUSD = dailyRows(realCap);
  out.RealizedPriceUSD = dailyRows(realPrice);
  return out;
}

export async function fetchCoinMetrics(fetchFn: typeof fetch): Promise<SeriesMap> {
  const q = new URLSearchParams({ assets: "btc", frequency: "1d", page_size: "10000", metrics: CM_METRICS.join(",") });
  let url: string | null = `${CM_BASE}?${q}`;
  const pages: unknown[] = [];
  for (let i = 0; url && i < CM_MAX_PAGES; i++) {
    const json = await getJson(url, fetchFn, "coinmetrics");
    pages.push(json);
    const next: string | null = parseCmPage(json, CM_METRICS[0]).next;
    // The next URL comes from the response body: only ever follow it back to the same API.
    if (next != null && !next.startsWith(`${CM_BASE}?`)) throw new Error("coinmetrics: refusing next_page_url outside the API base");
    url = next;
  }
  const out = parseCoinMetrics(pages);
  if (!out.CapMrktCurUSD?.length) throw new Error("coinmetrics: no rows");
  return out;
}

// ─── bitcoin-data.com (BGeometrics) ───
//
// A JSON array of `{d: "YYYY-MM-DD", unixTs: "<seconds>", <metricKey>: "<decimal>"}`, the value key
// differing per metric. Keyless quota is 10 requests/hour AND 15/day, so one history call per metric,
// never retried; a 429 or an exhausted hourly quota skips the rest and names them. The loader below
// fetches at most once per UTC day and keeps what it got (Postgres when configured, else in process).
// Optional BGEOMETRICS_TOKEN is sent as `?token=`.

const BG_BASE = "https://bitcoin-data.com/v1";
export const BG_METRICS = ["sth-realized-price", "true-market-mean", "lth-realized-price", "sth-sopr", "nupl", "supply-profit", "etf-flow-btc"] as const;
const BG_META_KEYS = new Set(["d", "unixTs", "delayed", "time"]);
const BgRowsSchema = z.array(z.record(z.string(), z.unknown()));

export function parseBgSeries(json: unknown): Row[] {
  const pairs: [number, number][] = [];
  for (const row of BgRowsSchema.parse(json)) {
    const sec = finite(row.unixTs);
    const t = sec != null ? sec * 1000 : typeof row.d === "string" ? Date.parse(`${row.d}T00:00:00Z`) : NaN;
    const valueKeys = Object.keys(row).filter((k) => !BG_META_KEYS.has(k));
    if (!Number.isFinite(t) || valueKeys.length !== 1) continue;
    const v = finite(row[valueKeys[0]!]);
    if (v != null) pairs.push([t, v]);
  }
  return dailyRows(pairs);
}

export async function fetchBGeometrics(fetchFn: typeof fetch, token: string | undefined): Promise<{ series: SeriesMap; error?: string }> {
  const series: SeriesMap = {};
  const errors: string[] = [];
  for (let i = 0; i < BG_METRICS.length; i++) {
    const metric = BG_METRICS[i]!;
    const url = `${BG_BASE}/${metric}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // The label, never the url: it can carry the token.
      if (!res.ok) throw new HttpError(`${metric}: HTTP ${res.status}`, res.status);
      const rows = parseBgSeries(await res.json());
      if (rows.length === 0) throw new Error(`${metric}: no rows`);
      series[metric] = rows;
      if (res.headers.get("X-RateLimit-Remaining-Hour") === "0" && i < BG_METRICS.length - 1) {
        errors.push(`hourly quota exhausted; missing ${BG_METRICS.slice(i + 1).join(", ")}`);
        break;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        errors.push(`rate limited; missing ${BG_METRICS.slice(i).join(", ")}`);
        break;
      }
      errors.push(errDetail(err));
    }
  }
  if (Object.keys(series).length === 0) throw new Error(`bgeometrics: ${errors.join("; ") || "no series"}`);
  return errors.length ? { series, error: `bgeometrics: ${errors.join("; ")}` } : { series };
}

// ─── Deribit 25Δ skew + put/call OI snapshot ───
//
// The book summary carries no greeks, so each option's delta is recomputed from its own mark_iv with
// Black-76 on the expiry forward (underlying_price), r = 0. Per expiry, OTM options only, IV is
// interpolated in |Δ| at 0.25 for each wing; skew = IV(25Δ put) − IV(25Δ call) in vol points. The 30-day
// value interpolates in T between the two expiries bracketing 30 days. History cannot be backfilled:
// one snapshot a day accumulates in storage.

const DERIBIT_BOOK_URL = "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option";
const YEAR_MS = 365 * DAY;
const TARGET_T = 30 / 365;
const BookSchema = z.object({
  result: z.array(z.object({ instrument_name: z.string(), mark_iv: z.unknown(), underlying_price: z.unknown(), open_interest: z.unknown() })),
});
const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function parseInstrument(name: string): { expiry: number; strike: number; isCall: boolean } | null {
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(name);
  if (!m || MONTHS[m[2]!] == null) return null;
  return { expiry: Date.UTC(2000 + Number(m[3]), MONTHS[m[2]!]!, Number(m[1]), 8), strike: Number(m[4]), isCall: m[5] === "C" };
}

function bsDelta(F: number, K: number, T: number, ivPct: number, isCall: boolean): number {
  const s = ivPct / 100;
  const d1 = (Math.log(F / K) + 0.5 * s * s * T) / (s * Math.sqrt(T));
  return isCall ? normCdf(d1) : normCdf(d1) - 1;
}

function ivAt25(points: { d: number; iv: number }[]): number | null {
  const sorted = [...points].sort((a, b) => a.d - b.d);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    if (a.d <= 0.25 && b.d >= 0.25) return b.d === a.d ? a.iv : a.iv + ((0.25 - a.d) / (b.d - a.d)) * (b.iv - a.iv);
  }
  return null;
}

export function computeOptionsSnapshot(json: unknown, now: number): { skew25d: number; putCallOi: number } {
  const byExpiry = new Map<number, { calls: { d: number; iv: number }[]; puts: { d: number; iv: number }[] }>();
  let putOi = 0;
  let callOi = 0;
  for (const o of BookSchema.parse(json).result) {
    const inst = parseInstrument(o.instrument_name);
    if (!inst) continue;
    const oi = finite(o.open_interest);
    if (oi != null && oi >= 0) {
      if (inst.isCall) callOi += oi;
      else putOi += oi;
    }
    const iv = finite(o.mark_iv);
    const F = finite(o.underlying_price);
    const T = (inst.expiry - now) / YEAR_MS;
    if (iv == null || iv <= 0 || F == null || F <= 0 || T <= 0) continue;
    if (inst.isCall ? inst.strike < F : inst.strike > F) continue; // OTM wings only
    const d = Math.abs(bsDelta(F, inst.strike, T, iv, inst.isCall));
    const e = byExpiry.get(inst.expiry) ?? { calls: [], puts: [] };
    (inst.isCall ? e.calls : e.puts).push({ d, iv });
    byExpiry.set(inst.expiry, e);
  }
  const skews: { T: number; skew: number }[] = [];
  for (const [expiry, e] of byExpiry) {
    const p = ivAt25(e.puts);
    const c = ivAt25(e.calls);
    if (p != null && c != null) skews.push({ T: (expiry - now) / YEAR_MS, skew: p - c });
  }
  skews.sort((a, b) => a.T - b.T);
  const below = skews.filter((s) => s.T <= TARGET_T).pop();
  const above = skews.find((s) => s.T >= TARGET_T);
  if (!below || !above) throw new Error("deribit skew: no expiries bracketing 30d");
  const skew25d = above.T === below.T ? below.skew : below.skew + ((TARGET_T - below.T) / (above.T - below.T)) * (above.skew - below.skew);
  if (callOi <= 0) throw new Error("deribit skew: zero call open interest");
  return { skew25d, putCallOi: putOi / callOi };
}

// ─── storage for what cannot be re-fetched freely ───

/** Daily rows kept between runs: bitcoin-data (quota) and the skew snapshots (no history upstream). */
export interface VectorStore {
  read(name: string, keys: readonly string[]): Promise<{ series: SeriesMap; fetchedAt: number | null }>;
  write(name: string, series: SeriesMap, at: number, error: string | null): Promise<void>;
}

export function memoryVectorStore(): VectorStore {
  const held = new Map<string, { series: SeriesMap; fetchedAt: number }>();
  return {
    async read(name) {
      const h = held.get(name);
      return h ? { series: h.series, fetchedAt: h.fetchedAt } : { series: {}, fetchedAt: null };
    },
    async write(name, series, at) {
      held.set(name, { series: mergeSeries(held.get(name)?.series ?? {}, series), fetchedAt: at });
    },
  };
}

const UPSERT_CHUNK = 5_000;
const seriesId = (name: string, key: string) => `vector.${name}.${key}`;
/** Re-written on every fetch: the trailing days bitcoin-data revises (its last ~7 are marked delayed). */
const REWRITE_DAYS = 30;

/** Postgres: observations `vector.<name>.<key>`, fetch times in collector_runs `vector:<name>`. */
const dbVectorStore: VectorStore = {
  async read(name, keys) {
    const [ranges, at] = await Promise.all([Promise.all(keys.map((k) => db.seriesRange(seriesId(name, k)))), db.lastCollectorFetch(`vector:${name}`)]);
    const series: SeriesMap = {};
    keys.forEach((k, i) => {
      if (ranges[i]!.length) series[k] = ranges[i]!.map((p) => ({ t: new Date(p.ts).getTime(), v: Number(p.value) }));
    });
    return { series, fetchedAt: at ? at.getTime() : null };
  },
  async write(name, series, at, error) {
    const keys = Object.keys(series).filter((k) => series[k]!.length);
    await db.ensureSeries(keys.map((k) => ({ id: seriesId(name, k), source: `vector:${name}`, description: `Vector input ${name} ${k}` })));
    const have = await db.seriesCoverage(keys.map((k) => seriesId(name, k)));
    const maxBy = new Map(have.map((c) => [c.seriesId, c.max.getTime()]));
    const obs = keys.flatMap((k) => {
      const since = (maxBy.get(seriesId(name, k)) ?? -Infinity) - REWRITE_DAYS * DAY;
      return series[k]!.filter((r) => r.t >= since).map((r) => ({ seriesId: seriesId(name, k), ts: new Date(r.t), value: r.v }));
    });
    for (let i = 0; i < obs.length; i += UPSERT_CHUNK) await db.upsertObservations(obs.slice(i, i + UPSERT_CHUNK));
    await db.recordCollectorRun(`vector:${name}`, new Date(at), true, error);
  },
};

// ─── loaders ───

export type Loader = (now: number) => Promise<SourceData>;

export interface VectorSourceIo {
  fetchFn: typeof fetch;
  store: VectorStore;
  bgToken?: string;
  /** BTC daily bars (stored 1d candles with the Bitstamp/Coin Metrics top-up of /api/cycles). */
  btcDaily(): Promise<DailyBar[]>;
  /** Hourly funding settlements for a coin since fromMs (stored, else live within liveDays). */
  funding(coin: string, fromMs: number, toMs: number, liveDays: number): Promise<FundingPoint[]>;
  /** Daily closes of a coin in [fromMs, toMs]. */
  closes(coin: string, fromMs: number, toMs: number): Promise<DailySeries>;
  /** Daily USD open interest of BTC since fromMs. */
  btcOi(fromMs: number, toMs: number): Promise<DailySeries>;
}

/** bitcoin-data at most once per UTC day; a failed fetch serves what storage holds, marked with the error. */
export function bgLoader(io: Pick<VectorSourceIo, "fetchFn" | "store" | "bgToken">): Loader {
  return async (now) => {
    const stored = await io.store.read("bgeometrics", BG_METRICS).catch(() => ({ series: {} as SeriesMap, fetchedAt: null }));
    const hasRows = Object.values(stored.series).some((r) => r.length);
    if (hasRows && stored.fetchedAt != null && dayStart(stored.fetchedAt) === dayStart(now)) return { series: stored.series, fetchedAt: stored.fetchedAt };
    let got: { series: SeriesMap; error?: string };
    try {
      got = await fetchBGeometrics(io.fetchFn, io.bgToken);
    } catch (err) {
      if (!hasRows) throw err;
      return { series: stored.series, fetchedAt: stored.fetchedAt ?? undefined, error: `${errDetail(err)} (serving stored rows)` };
    }
    await io.store.write("bgeometrics", got.series, now, got.error ?? null).catch((e) => console.warn(`[vector] bgeometrics store write failed: ${errDetail(e)}`));
    return { series: mergeSeries(stored.series, got.series), ...(got.error ? { error: got.error } : {}) };
  };
}

/** Today's skew snapshot on top of the stored daily snapshots. */
export function skewLoader(io: Pick<VectorSourceIo, "fetchFn" | "store">): Loader {
  return async (now) => {
    const snap = computeOptionsSnapshot(await getJson(DERIBIT_BOOK_URL, io.fetchFn, "deribit book"), now);
    const t = dayStart(now);
    const today: SeriesMap = { skew25d: [{ t, v: snap.skew25d }], putCallOi: [{ t, v: snap.putCallOi }] };
    await io.store.write("deribit-skew", today, now, null).catch((e) => console.warn(`[vector] skew store write failed: ${errDetail(e)}`));
    const stored = await io.store.read("deribit-skew", ["skew25d", "putCallOi"]).catch(() => ({ series: {} as SeriesMap }));
    return { series: mergeSeries(stored.series, today) };
  };
}

const toFundingRows = (rows: FundingPoint[]): FundingRow[] => rows.map((r) => ({ t: r.t, rate: r.rate, premium: r.premium }));
const closedOnly = (s: DailySeries, now: number): Row[] => toRows(s).filter((r) => r.t + DAY <= now);

/** The seven hl-cycles daily sources plus BTC price, BTC funding, BTC OI and the rotation alts. */
export function createVectorLoaders(io: VectorSourceIo): Record<string, Loader> {
  const deribit = createDeribitProvider(io.fetchFn);
  const fng = createFngProvider(io.fetchFn);
  return {
    "btc-price": async () => ({ daily: await io.btcDaily() }),
    coinmetrics: async () => ({ series: await fetchCoinMetrics(io.fetchFn) }),
    bgeometrics: bgLoader(io),
    fred: async (now) => {
      const ids = ["DTWEXBGS", "DGS10", "DGS2", "DFEDTARU", "SP500", "T10Y2Y"];
      const errors: string[] = [];
      const series: SeriesMap = {};
      await mapLimit(ids, 3, async (id) => {
        try {
          const pts = await fetchFred(io.fetchFn, id, new Date(now), FRED_DAYS, FRED_TIMEOUT_MS);
          series[id] = dailyRows(pts.map((p) => [Date.parse(`${p.date}T00:00:00Z`), p.value]));
        } catch (err) {
          errors.push(`${id}: ${errDetail(err)}`);
        }
      });
      if (!Object.keys(series).length) throw new Error(`fred: ${errors.join("; ")}`);
      return errors.length ? { series, error: `fred: ${errors.join("; ")}` } : { series };
    },
    defillama: async () => ({ series: { totalStablecoinMcapUSD: toRows(parseStablecoinChart(await getJson(LLAMA_STABLES_URL, io.fetchFn, "defillama"))) } }),
    "deribit-dvol": async () => ({ series: { dvol: toRows(await deribit.history!("btc_dvol", "BTC", null)) } }),
    "deribit-skew": skewLoader(io),
    feargreed: async () => ({ series: { fearGreed: toRows(await fng.history!("value", "BTC", null)) } }),
    "hl-funding": async (now) => {
      const rows = await io.funding("BTC", now - FUNDING_DAYS * DAY, now, FUNDING_DAYS);
      if (!rows.length) throw new Error("hl-funding: no BTC funding rows");
      return { funding: toFundingRows(rows) };
    },
    "okx-oi": async (now) => {
      const s = await io.btcOi(OKX_OI_EPOCH, now);
      if (!s.t.length) throw new Error("okx-oi: no BTC open interest rows");
      return { oi: toRows(s).map((r) => ({ t: r.t, oiUsd: r.v })) };
    },
    "hl-alts": async (now) => {
      const from = now - FUNDING_DAYS * DAY;
      const errors: string[] = [];
      const alts = await mapLimit([...VECTOR_ALTS], ALT_CONCURRENCY, async (coin): Promise<AltData | null> => {
        try {
          const [closes, funding] = await Promise.all([io.closes(coin, from, now), io.funding(coin, from, now, ALT_LIVE_FUNDING_DAYS)]);
          return { coin, closes: closedOnly(closes, now), funding: toFundingRows(funding) };
        } catch (err) {
          errors.push(`${coin}: ${errDetail(err)}`);
          return null;
        }
      });
      const ok = alts.filter((a): a is AltData => a != null);
      if (!ok.length) throw new Error(`hl-alts: ${errors.join("; ")}`);
      return errors.length ? { alts: ok, error: `hl-alts: ${errors.join("; ")}` } : { alts: ok };
    },
  };
}

/** Real I/O: Postgres when DATABASE_URL is set, live fetchers otherwise. */
export function defaultVectorIo(): VectorSourceIo {
  const hasDb = () => Boolean(db.databaseUrl());
  return {
    fetchFn: fetch,
    store: hasDb() ? dbVectorStore : memoryVectorStore(),
    bgToken: process.env.BGEOMETRICS_TOKEN || undefined,
    btcDaily: () => loadHistory("BTC", defaultCyclesDeps),
    async funding(coin, fromMs, toMs, liveDays) {
      if (hasDb()) {
        const stored = await defaultHtDeps.funding(coin, fromMs, toMs).catch(() => []);
        if (stored.length) return stored;
      }
      return defaultHtDeps.liveFunding(coin, Math.max(fromMs, toMs - liveDays * DAY), toMs);
    },
    closes: (coin, fromMs, toMs) => htProvider.fetch("price", coin, fromMs, toMs),
    btcOi: (fromMs, toMs) => okxProvider.fetch("oi", "BTC", fromMs, toMs),
  };
}
