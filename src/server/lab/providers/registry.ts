import { databaseUrl, seriesCoverage, seriesRange } from "../../db.js";
import { UpstreamError } from "../../mcp/types.js";
import { parseDay } from "../engine/util.js";
import { DAY_MS, type DailySeries, type FetchOptions, type LabDataset, type LabProvider, type MetricCategory, type MetricDef } from "../types.js";
import { bcProvider } from "./bc.js";
import { cmProvider } from "./cm.js";
import { deribitProvider } from "./deribit.js";
import { fngProvider } from "./fng.js";
import { htProvider } from "./ht.js";
import { llamaProvider } from "./llama.js";
import { clip, dayStart, isCollectable, labSeriesId, toDaily, type LabMetricDef } from "./series.js";
import { mapLimit, msg } from "../util.js";

// Provider registry and dataset loader: resolves metric ids, fetches with a
// short TTL cache, and aligns everything to the price calendar for the engine.

export const PROVIDERS: LabProvider[] = [htProvider, cmProvider, fngProvider, llamaProvider, bcProvider, deribitProvider];

const DEFAULT_PRICE = "ht:price";
const FALLBACK_PRICE = "cm:PriceUSD";
const DEFAULT_FROM = Date.UTC(2010, 0, 1);
const FFILL_DAYS = 3;
const CONCURRENCY = 4;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
/** Stored history whose last point is at most this old (before the range end) is used as is. */
const STORED_FRESH_MS = 2 * DAY_MS;
/** A stale stored series is topped up live from its last point minus this (upstream revises recent days). */
const STORED_OVERLAP_MS = 7 * DAY_MS;

/** Collected lab.* history (src/server/lab/collect.ts writes it); injectable so tests need no DB. */
export interface LabSeriesStore {
  hasDb(): boolean;
  coverage(id: string): Promise<{ min: number; max: number } | null>;
  /** Stored points of one series in [fromMs, toMs]. */
  range(id: string, fromMs: number, toMs: number): Promise<Array<{ t: number; v: number }>>;
}

export const dbSeriesStore: LabSeriesStore = {
  hasDb: () => Boolean(databaseUrl()),
  async coverage(id) {
    const [c] = await seriesCoverage([id]);
    return c ? { min: new Date(c.min).getTime(), max: new Date(c.max).getTime() } : null;
  },
  async range(id, fromMs, toMs) {
    return (await seriesRange(id, new Date(fromMs), new Date(toMs))).map((p) => ({ t: new Date(p.ts).getTime(), v: Number(p.value) }));
  },
};

export interface RegistryDeps {
  providers?: LabProvider[];
  cache?: Map<string, { at: number; p: Promise<DailySeries> }>;
  now?: () => number;
  store?: LabSeriesStore;
}

const sharedCache = new Map<string, { at: number; p: Promise<DailySeries> }>();

export function allMetrics(
  filter: { provider?: string; category?: MetricCategory; asset?: string } = {},
  providers: LabProvider[] = PROVIDERS,
): MetricDef[] {
  return providers
    .filter((p) => !filter.provider || p.id === filter.provider)
    .flatMap((p) => p.metrics())
    .filter((m) => !filter.category || m.category === filter.category)
    .filter((m) => !filter.asset || !m.assets || m.assets.some((a) => a.toLowerCase() === filter.asset!.toLowerCase()));
}

export function getMetric(id: string, providers: LabProvider[] = PROVIDERS): MetricDef | undefined {
  const pid = id.split(":")[0];
  return providers.find((p) => p.id === pid)?.metrics().find((m) => m.id === id);
}

function resolve(id: string, providers: LabProvider[]): { def: MetricDef; provider: LabProvider } {
  const provider = providers.find((p) => p.id === id.split(":")[0]);
  const def = provider?.metrics().find((m) => m.id === id);
  if (!provider || !def) throw new Error(`unknown metric: ${id}`);
  return { def, provider };
}

/** Raw (un-shifted) daily series for one metric over [fromMs, toMs], cached for 10 minutes. */
export function fetchMetric(id: string, asset: string, fromMs: number, toMs: number, deps: RegistryDeps = {}, opts?: FetchOptions): Promise<DailySeries> {
  const { def, provider } = resolve(id, deps.providers ?? PROVIDERS);
  const cache = deps.cache ?? sharedCache;
  const now = (deps.now ?? Date.now)();
  const key = `${id}|${def.scope === "global" ? "*" : asset}|${fromMs}|${toMs}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.p;
  const p = storedFirst(provider, def, asset, fromMs, toMs, deps.store ?? dbSeriesStore, now, opts);
  cache.set(key, { at: now, p });
  p.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

/** Union by day; `b` wins where both have a value. */
function mergeDaily(a: DailySeries, b: DailySeries): DailySeries {
  const m = new Map<number, number>();
  a.t.forEach((t, i) => m.set(t, a.v[i]!));
  b.t.forEach((t, i) => m.set(t, b.v[i]!));
  const t = [...m.keys()].sort((x, y) => x - y);
  return { t, v: t.map((d) => m.get(d)!) };
}

/**
 * Collected history first, live for what it lacks. A lab.* series is written
 * by the cron collector, whose first sync stores the source's whole history
 * oldest-first, so a stored series already reaches back as far as the source
 * does (a cut-short backfill shows up as a stale tail). Fresh (last point
 * within 2 days of the range end) → stored only; stale → live from the last
 * stored point minus a week, merged over it. Not collectable, no DB, nothing
 * stored or a DB error → live, as before.
 */
async function storedFirst(
  provider: LabProvider,
  def: MetricDef,
  asset: string,
  fromMs: number,
  toMs: number,
  store: LabSeriesStore,
  nowMs: number,
  opts?: FetchOptions,
): Promise<DailySeries> {
  const live = (lo: number) => provider.fetch(def.key, asset, lo, toMs, opts);
  if (!isCollectable(provider) || !store.hasDb()) return live(fromMs);
  const id = labSeriesId(def, asset);
  let stored: DailySeries;
  let lastMs: number;
  try {
    const cov = await store.coverage(id);
    if (!cov) return live(fromMs);
    lastMs = cov.max;
    stored = clip(toDaily(await store.range(id, fromMs, toMs + DAY_MS - 1), "last"), fromMs, toMs);
  } catch {
    return live(fromMs);
  }
  if (lastMs >= Math.min(dayStart(toMs), dayStart(nowMs)) - STORED_FRESH_MS) return stored;
  return mergeDaily(stored, await live(Math.max(fromMs, lastMs - STORED_OVERLAP_MS)));
}

/**
 * Values of `s` on `calendar`, with `s` shifted forward by `lagDays` (a value
 * stamped day t is known on day t + lag). Gaps are forward-filled for at most
 * `maxFillDays` (default three; weekly series declare 8); beyond that, and
 * before the series starts, NaN.
 */
export function alignToCalendar(s: DailySeries, calendar: number[], lagDays = 0, maxFillDays = FFILL_DAYS): number[] {
  const shift = lagDays * DAY_MS;
  const out = new Array<number>(calendar.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < calendar.length; i++) {
    const day = calendar[i]!;
    while (j < s.t.length && s.t[j]! + shift <= day) j++;
    if (j === 0) continue;
    if (day - (s.t[j - 1]! + shift) <= maxFillDays * DAY_MS) out[i] = s.v[j - 1]!;
  }
  return out;
}

export interface LoadConfig {
  asset: string;
  metrics: string[];
  price?: string;
  from?: string; // YYYY-MM-DD
  to?: string;
  /** Under a request deadline: providers skip slow optional work. */
  deadline?: boolean;
}

/** Fetches price + metrics and aligns them to the price calendar. Per-metric failures become warnings. */
export async function loadDataset(cfg: LoadConfig, deps: RegistryDeps = {}): Promise<{ dataset: LabDataset; warnings: string[] }> {
  const providers = deps.providers ?? PROVIDERS;
  const defs = [...new Set(cfg.metrics)].map((id) => resolve(id, providers).def); // throws on unknown ids up front
  const priceId = cfg.price ?? DEFAULT_PRICE;
  resolve(priceId, providers);
  const fromMs = cfg.from ? parseDay(cfg.from) : DEFAULT_FROM;
  const nowMs = (deps.now ?? Date.now)();
  const toMs = cfg.to ? parseDay(cfg.to) : dayStart(nowMs);
  const warnings: string[] = [];
  const opts: FetchOptions = { deadline: cfg.deadline };

  // Each attempt's failure is kept: a transport error is not "no history".
  const reasons: string[] = [];
  const tryPrice = async (id: string): Promise<{ t: number[]; v: number[]; error?: string }> => {
    let s: DailySeries;
    try {
      s = await fetchMetric(id, cfg.asset, fromMs, toMs, deps, opts);
    } catch (err) {
      reasons.push(`${id}: ${msg(err)}`);
      return { t: [], v: [], error: msg(err) };
    }
    // Labels need a positive price; drop anything else from the calendar, and
    // today's bar too: it is still forming, so the calendar (and "firing now")
    // ends at the last completed UTC day.
    const today = dayStart(nowMs);
    const keep = s.v.map((v, i) => Number.isFinite(v) && v > 0 && s.t[i]! < today);
    const out = { t: s.t.filter((_, i) => keep[i]), v: s.v.filter((_, i) => keep[i]) };
    if (!out.t.length) reasons.push(`${id}: ${s.t.length ? "no positive prices" : "no history"}`);
    return out;
  };
  let price = await tryPrice(priceId);
  if (price.t.length === 0 && !cfg.price) {
    warnings.push(price.error ? `${priceId} unavailable (${price.error}); using ${FALLBACK_PRICE}` : `${priceId} has no history for ${cfg.asset}; using ${FALLBACK_PRICE}`);
    price = await tryPrice(FALLBACK_PRICE);
  }
  if (price.t.length === 0) throw new UpstreamError(`no price history for ${cfg.asset}: ${reasons.join("; ")}`);
  const { t, v: pv } = price;

  const metrics: Record<string, number[]> = {};
  const stationary: Record<string, boolean> = {};
  const results = await mapLimit(defs, CONCURRENCY, async (def) => {
    try {
      return { def, s: await fetchMetric(def.id, cfg.asset, fromMs, toMs, deps, opts) };
    } catch (err) {
      warnings.push(`${def.id}: ${msg(err)}; dropped`);
      return null;
    }
  });
  for (const r of results) {
    if (!r) continue;
    const aligned = alignToCalendar(r.s, t, r.def.lagDays, (r.def as LabMetricDef).maxFillDays);
    if (aligned.every((v) => Number.isNaN(v))) {
      warnings.push(`${r.def.id}: no data for ${cfg.asset} in range; dropped`);
      continue;
    }
    metrics[r.def.id] = aligned;
    if (r.def.stationary !== undefined) stationary[r.def.id] = r.def.stationary;
  }
  return { dataset: { asset: cfg.asset, t, price: pv, metrics, stationary }, warnings };
}
