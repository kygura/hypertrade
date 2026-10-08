// Free daily history for the Lab: on-chain (Coin Metrics community,
// blockchain.com), sentiment (alternative.me), liquidity (DefiLlama) and
// implied vol (Deribit). All keyless. First sync pulls full history; after
// that each source refetches a short tail once a day. Per-source try/catch:
// one dead API never blocks the others (SPEC.md).
import { z } from "zod";
import * as db from "../db.js";
import type { Observation, SeriesDef, SyncState } from "../db.js";
import type { CollectorResult } from "../collectors/types.js";

const COLLECTOR = "lab";
/** sync_state.coin for Lab sources; sync_state.series is the source key. */
export const LAB_SYNC_COIN = "_lab";
const DAY_MS = 86_400_000;
/** Refetch a source at most this often (its upstream updates daily). */
export const REFRESH_MS = 20 * 3_600_000;
/** After a failed sync, wait this long before trying the source again. */
export const RETRY_MS = 3_600_000;
/** Overlap on incremental fetches: upstream revises recent days. */
const OVERLAP_MS = 7 * DAY_MS;
const OBS_CHUNK = 5000;

export type HistPoint = { ts: number; value: number };
type FetchFn = typeof fetch;

async function getJson(url: string, fetchFn: FetchFn): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const finite = (p: HistPoint) => Number.isFinite(p.ts) && Number.isFinite(p.value);

// ─── blockchain.com charts ───

const BlockchainChartSchema = z.object({ values: z.array(z.object({ x: z.number(), y: z.number() })) });

/** `{ values: [{ x: unixSeconds, y }] }` */
export function parseBlockchainChart(json: unknown): HistPoint[] {
  return BlockchainChartSchema.parse(json).values.map((v) => ({ ts: v.x * 1000, value: v.y })).filter(finite);
}

export const BLOCKCHAIN_CHARTS = ["hash-rate", "miners-revenue", "difficulty", "estimated-transaction-volume-usd"] as const;

// ─── Coin Metrics community API ───

const CoinMetricsSchema = z.object({
  data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  next_page_url: z.string().optional(),
});

/** `{ data: [{ asset, time, <metric>: "1.23" }], next_page_url? }` — values arrive as strings. */
export function parseCoinMetrics(json: unknown, metric: string): { points: HistPoint[]; next?: string } {
  const p = CoinMetricsSchema.parse(json);
  const points = p.data
    .map((row) => ({ ts: Date.parse(String(row.time)), value: Number(row[metric]) }))
    .filter((x) => finite(x) && x.value !== 0);
  return { points, next: p.next_page_url };
}

export const COINMETRICS_METRICS = ["CapMVRVCur", "AdrActCnt", "TxCnt", "FeeTotNtv"] as const;
const CM_BASE = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";
const CM_MAX_PAGES = 4;

// ─── alternative.me Fear & Greed ───

const FngHistorySchema = z.object({ data: z.array(z.object({ value: z.string(), timestamp: z.string() })) });

/** `{ data: [{ value: "40", timestamp: "1551157200" }] }`, newest first. */
export function parseFngHistory(json: unknown): HistPoint[] {
  return FngHistorySchema.parse(json)
    .data.map((d) => ({ ts: Number(d.timestamp) * 1000, value: Number(d.value) }))
    .filter(finite)
    .sort((a, b) => a.ts - b.ts);
}

// ─── DefiLlama stablecoin supply ───

const StableHistorySchema = z.array(
  z.object({ date: z.union([z.string(), z.number()]), totalCirculatingUSD: z.record(z.string(), z.number()).optional() }),
);

/** `[{ date: "1609459200", totalCirculatingUSD: { peggedUSD, ... } }]` — only USD pegs count, as in the live collector. */
export function parseStablecoinHistory(json: unknown): HistPoint[] {
  return StableHistorySchema.parse(json)
    .map((d) => ({ ts: Number(d.date) * 1000, value: d.totalCirculatingUSD?.peggedUSD ?? NaN }))
    .filter((p) => finite(p) && p.value > 0);
}

// ─── Deribit DVOL ───

const DvolSchema = z.object({
  result: z.object({ data: z.array(z.array(z.number())), continuation: z.number().nullable().optional() }),
});

/** `{ result: { data: [[ms, o, h, l, c]], continuation } }` — the close is the day's value. */
export function parseDvolHistory(json: unknown): { points: HistPoint[]; continuation: number | null } {
  const p = DvolSchema.parse(json);
  return {
    points: p.result.data.map((r) => ({ ts: r[0]!, value: r[4]! })).filter(finite),
    continuation: p.result.continuation ?? null,
  };
}

/** DVOL starts in March 2021. */
const DVOL_EPOCH = Date.UTC(2021, 2, 24);
const DVOL_WINDOW = 900 * DAY_MS;

// ─── source table ───

export interface LabSource {
  key: string;
  series: SeriesDef;
  fetch: (fetchFn: FetchFn, sinceMs: number | null, nowMs: number) => Promise<HistPoint[]>;
}

export const LAB_SOURCES: LabSource[] = [
  ...BLOCKCHAIN_CHARTS.map(
    (chart): LabSource => ({
      key: `bc.${chart}`,
      series: { id: `bc.${chart}`, source: "blockchain.info", units: chart === "hash-rate" ? "TH/s" : chart === "difficulty" ? "" : "USD", description: `blockchain.com chart: ${chart}` },
      fetch: async (fetchFn, since) => {
        const span = since === null ? "all" : "60days";
        return parseBlockchainChart(await getJson(`https://api.blockchain.info/charts/${chart}?timespan=${span}&format=json&sampled=false`, fetchFn));
      },
    }),
  ),
  ...COINMETRICS_METRICS.map(
    (metric): LabSource => ({
      key: `cm.btc.${metric}`,
      series: { id: `cm.btc.${metric}`, source: "coinmetrics", units: metric === "CapMVRVCur" ? "ratio" : metric === "FeeTotNtv" ? "BTC" : "count", description: `Coin Metrics community: btc ${metric}` },
      // One metric per request: the community tier rejects a whole request if any metric in it is not free.
      fetch: async (fetchFn, since) => {
        const start = since === null ? "" : `&start_time=${new Date(since).toISOString().slice(0, 10)}`;
        let url: string | undefined = `${CM_BASE}?assets=btc&metrics=${metric}&frequency=1d&page_size=10000${start}`;
        const out: HistPoint[] = [];
        for (let page = 0; url && page < CM_MAX_PAGES; page++) {
          const { points, next } = parseCoinMetrics(await getJson(url, fetchFn), metric);
          out.push(...points);
          url = next;
        }
        return out;
      },
    }),
  ),
  {
    key: "fng.value",
    series: { id: "fng.value", source: "fng", units: "index", description: "Fear & Greed index (alternative.me)" },
    fetch: async (fetchFn, since) => parseFngHistory(await getJson(`https://api.alternative.me/fng/?limit=${since === null ? 0 : 60}&format=json`, fetchFn)),
  },
  {
    key: "llama.stablecoin_cap_usd",
    series: { id: "llama.stablecoin_cap_usd", source: "llama", units: "USD", description: "USD-pegged stablecoin market cap (DefiLlama)" },
    fetch: async (fetchFn) => parseStablecoinHistory(await getJson("https://stablecoins.llama.fi/stablecoincharts/all", fetchFn)),
  },
  {
    key: "deribit.btc_dvol",
    series: { id: "deribit.btc_dvol", source: "deribit", units: "index", description: "BTC implied volatility index (Deribit DVOL)" },
    fetch: async (fetchFn, since, now) => {
      const out: HistPoint[] = [];
      for (let lo = since ?? DVOL_EPOCH; lo < now; lo += DVOL_WINDOW) {
        const hi = Math.min(now, lo + DVOL_WINDOW);
        const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=1D&start_timestamp=${lo}&end_timestamp=${hi}`;
        out.push(...parseDvolHistory(await getJson(url, fetchFn)).points);
      }
      return out;
    },
  },
];

// ─── collector ───

export type LabCollectDeps = {
  getSyncState: (coin: string, series: string) => Promise<SyncState>;
  saveSyncState: (s: SyncState) => Promise<void>;
  ensureSeries: (defs: SeriesDef[]) => Promise<void>;
  upsertObservations: (rows: Observation[]) => Promise<number>;
  recordCollectorRun: (collector: string, startedAt: Date, ok: boolean, error?: string | null) => Promise<void>;
};
const defaultDeps: LabCollectDeps = db;

export interface LabCollectOptions {
  now?: number;
  /** Stop starting new sources after this epoch ms (the cron's budget). */
  deadline?: number;
  /** Ignore the once-a-day gate (CLI backfill). */
  force?: boolean;
  /** Only these source keys. */
  only?: string[];
}

/**
 * Syncs every Lab source that is due. A source is due when it never synced
 * or last synced more than REFRESH_MS ago; incremental runs keep only points
 * newer than the last sync minus a week.
 */
export async function collectLab(fetchFn: FetchFn = fetch, deps: LabCollectDeps = defaultDeps, opts: LabCollectOptions = {}): Promise<CollectorResult & { synced: string[]; skipped: number }> {
  const startedAt = new Date(opts.now ?? Date.now());
  const now = startedAt.getTime();
  const errors: string[] = [];
  const synced: string[] = [];
  let skipped = 0;
  let written = 0;

  const sources = LAB_SOURCES.filter((s) => !opts.only || opts.only.includes(s.key));
  // Three at a time: polite to free APIs, still quick on a full backfill.
  const queue = [...sources];
  async function worker() {
    for (let src = queue.shift(); src; src = queue.shift()) {
      if (opts.deadline && Date.now() > opts.deadline) {
        skipped++;
        continue;
      }
      const state = await deps.getSyncState(LAB_SYNC_COIN, src.key);
      // sync_state.ext is the candle sync's per-layer map; Lab sources keep
      // their last attempt there so a dead upstream is not hit every 15 min.
      const attemptedAt = (state.ext as { lab?: { attemptedAt?: number } }).lab?.attemptedAt ?? null;
      const fresh = state.syncedAt !== null && now - state.syncedAt < REFRESH_MS;
      const backingOff = state.error !== null && attemptedAt !== null && now - attemptedAt < RETRY_MS;
      if (!opts.force && (fresh || backingOff)) {
        skipped++;
        continue;
      }
      const ext = { ...state.ext, lab: { attemptedAt: now } } as unknown as SyncState["ext"];
      const since = opts.force || state.syncedAt === null ? null : state.syncedAt - OVERLAP_MS;
      try {
        const points = await src.fetch(fetchFn, since, now);
        const floor = since ?? -Infinity;
        const rows: Observation[] = points.filter((p) => p.ts >= floor && p.ts <= now).map((p) => ({ seriesId: src.series.id, ts: new Date(p.ts), value: p.value }));
        if (rows.length === 0 && since === null) throw new Error("no history returned");
        await deps.ensureSeries([src.series]);
        for (let i = 0; i < rows.length; i += OBS_CHUNK) written += await deps.upsertObservations(rows.slice(i, i + OBS_CHUNK));
        await deps.saveSyncState({ ...state, ext, syncedAt: now, error: null });
        synced.push(src.key);
      } catch (err) {
        const msg = `${src.key}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        await deps.saveSyncState({ ...state, ext, error: msg.slice(0, 500) }).catch(() => {});
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  const ok = errors.length < sources.length - skipped || sources.length === skipped;
  const error = errors.length ? errors.join("; ") : undefined;
  await deps.recordCollectorRun(COLLECTOR, startedAt, ok, error ?? null);
  return { ok, error, written, synced, skipped };
}
