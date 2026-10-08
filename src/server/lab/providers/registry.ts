import { UpstreamError } from "../../mcp/types.js";
import { parseDay } from "../engine/util.js";
import { DAY_MS, type DailySeries, type FetchOptions, type LabDataset, type LabProvider, type MetricCategory, type MetricDef } from "../types.js";
import { cmProvider } from "./cm.js";
import { fngProvider } from "./fng.js";
import { htProvider } from "./ht.js";
import { llamaProvider } from "./llama.js";
import { dayStart } from "./series.js";
import { mapLimit, msg } from "../util.js";

// Provider registry and dataset loader: resolves metric ids, fetches with a
// short TTL cache, and aligns everything to the price calendar for the engine.

export const PROVIDERS: LabProvider[] = [htProvider, cmProvider, fngProvider, llamaProvider];

const DEFAULT_PRICE = "ht:price";
const FALLBACK_PRICE = "cm:PriceUSD";
const DEFAULT_FROM = Date.UTC(2010, 0, 1);
const FFILL_DAYS = 3;
const CONCURRENCY = 4;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;

export interface RegistryDeps {
  providers?: LabProvider[];
  cache?: Map<string, { at: number; p: Promise<DailySeries> }>;
  now?: () => number;
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
  const p = provider.fetch(def.key, asset, fromMs, toMs, opts);
  cache.set(key, { at: now, p });
  p.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return p;
}

/**
 * Values of `s` on `calendar`, with `s` shifted forward by `lagDays` (a value
 * stamped day t is known on day t + lag). Gaps are forward-filled for at most
 * three days; beyond that, and before the series starts, NaN.
 */
export function alignToCalendar(s: DailySeries, calendar: number[], lagDays = 0): number[] {
  const shift = lagDays * DAY_MS;
  const out = new Array<number>(calendar.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < calendar.length; i++) {
    const day = calendar[i]!;
    while (j < s.t.length && s.t[j]! + shift <= day) j++;
    if (j === 0) continue;
    if (day - (s.t[j - 1]! + shift) <= FFILL_DAYS * DAY_MS) out[i] = s.v[j - 1]!;
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
  const toMs = cfg.to ? parseDay(cfg.to) : dayStart((deps.now ?? Date.now)());
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
    // Labels need a positive price; drop anything else from the calendar.
    const keep = s.v.map((v) => Number.isFinite(v) && v > 0);
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
    const aligned = alignToCalendar(r.s, t, r.def.lagDays);
    if (aligned.every((v) => Number.isNaN(v))) {
      warnings.push(`${r.def.id}: no data for ${cfg.asset} in range; dropped`);
      continue;
    }
    metrics[r.def.id] = aligned;
  }
  return { dataset: { asset: cfg.asset, t, price: pv, metrics }, warnings };
}
