import { z } from "zod";
import type { DailySeries, MetricCategory } from "../types.js";
import { clip, getJson, isoDay, requestTimeout, toDaily, type CollectableProvider, type HistorySeries, type LabMetricDef } from "./series.js";

// Coin Metrics community API (keyless): the stand-in for Glassnode on-chain
// data. A metric the community tier refuses comes back 4xx and throws, so the
// caller drops it with a warning.

export const CM_BASE = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";
const PAGE_SIZE = 10_000;
/** Before any chain we cover: asking from here means the whole history. */
const CM_START = Date.UTC(2009, 0, 1);
const MAX_PAGES = 10;

const CmPageSchema = z.object({
  data: z.array(z.object({ time: z.string() }).catchall(z.unknown())),
  next_page_url: z.string().url().nullish(),
});

/** One asset-metrics page → points for `key` plus the next page url. Exported for fixture tests. */
export function parseCmPage(json: unknown, key: string): { points: Array<{ t: number; v: number }>; next: string | null } {
  const page = CmPageSchema.parse(json);
  const points: Array<{ t: number; v: number }> = [];
  for (const row of page.data) {
    const raw = row[key];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    // CM times carry nanoseconds ("…T00:00:00.000000000Z"); the day is enough.
    points.push({ t: Date.parse(`${row.time.slice(0, 10)}T00:00:00Z`), v: Number(raw) });
  }
  return { points, next: page.next_page_url ?? null };
}

/** HL coin → Coin Metrics asset id. Lowercase except the few that differ. */
const CM_ASSET: Record<string, string> = { kPEPE: "pepe", kSHIB: "shib", kBONK: "bonk" };
export const cmAsset = (coin: string): string => CM_ASSET[coin] ?? coin.toLowerCase();

const DEFS: Array<[key: string, name: string, category: MetricCategory, units: string, description: string]> = [
  ["PriceUSD", "Price (USD)", "price", "USD", "Coin Metrics reference rate, daily close."],
  ["CapMrktCurUSD", "Market cap", "price", "USD", "Current supply × price."],
  ["CapMVRVCur", "MVRV", "onchain", "ratio", "Market value / realized value."],
  ["AdrActCnt", "Active addresses", "onchain", "count", "Unique addresses active in the network that day."],
  ["TxCnt", "Transactions", "onchain", "count", "Transactions that day."],
  ["TxTfrCnt", "Transfers", "onchain", "count", "Transfers of native units that day."],
  ["HashRate", "Hash rate", "onchain", "TH/s", "Mean hash rate (proof-of-work chains)."],
  ["FeeTotNtv", "Fees (native)", "onchain", "native units", "Total fees paid that day."],
  ["SplyCur", "Supply", "onchain", "native units", "Current supply."],
  ["IssTotNtv", "Issuance (native)", "onchain", "native units", "New native units issued that day."],
  ["NVTAdj", "NVT (adjusted)", "onchain", "ratio", "Network value / adjusted transfer value."],
  ["TxTfrValAdjUSD", "Transfer value (adj, USD)", "onchain", "USD", "Adjusted USD value transferred that day."],
];

/** Levels and counts that trend; the rest (MVRV, NVT) are ratios. */
const LEVELS = new Set(["PriceUSD", "CapMrktCurUSD", "AdrActCnt", "TxCnt", "TxTfrCnt", "HashRate", "FeeTotNtv", "SplyCur", "IssTotNtv", "TxTfrValAdjUSD"]);

const METRICS: LabMetricDef[] = DEFS.map(([key, name, category, units, description]) => ({
  id: `cm:${key}`,
  provider: "cm",
  key,
  name,
  category,
  scope: "asset",
  units,
  description,
  lagDays: 1,
  ...(LEVELS.has(key) ? { stationary: false } : {}),
}));
const KEYS = new Set(DEFS.map((d) => d[0]));

export function createCmProvider(fetchFn: typeof fetch = fetch, now: () => number = Date.now): CollectableProvider {
  /** Pages ascending from fromMs; with a deadline, stops paging there and returns the prefix as `partial`. */
  async function paged(key: string, asset: string, fromMs: number, toMs: number, deadline?: number): Promise<HistorySeries> {
    if (!KEYS.has(key)) throw new Error(`unknown cm metric: ${key}`);
    const params = new URLSearchParams({
      assets: cmAsset(asset),
      metrics: key,
      frequency: "1d",
      start_time: isoDay(fromMs),
      end_time: isoDay(toMs),
      page_size: String(PAGE_SIZE),
    });
    let url: string | null = `${CM_BASE}?${params}`;
    const points: Array<{ t: number; v: number }> = [];
    let partial = false;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      if (page > 0 && deadline !== undefined && now() >= deadline) {
        partial = true;
        break;
      }
      let json: unknown;
      try {
        json = await getJson(url, fetchFn, `cm ${key} ${asset}`, requestTimeout(deadline, now()));
      } catch (err) {
        // Cut off by the budget after some pages: keep them, the collector resumes.
        if (page > 0 && deadline !== undefined && now() >= deadline) {
          partial = true;
          break;
        }
        throw err;
      }
      const parsed = parseCmPage(json, key);
      points.push(...parsed.points);
      // Only ever follow pages on the API we called.
      if (parsed.next && !parsed.next.startsWith(`${CM_BASE}?`)) throw new Error(`cm ${key} ${asset}: unexpected next_page_url ${parsed.next.slice(0, 100)}`);
      url = parsed.next;
    }
    const out: HistorySeries = clip(toDaily(points, "last"), fromMs, toMs);
    return partial ? { ...out, partial } : out;
  }
  return {
    id: "cm",
    name: "Coin Metrics (community)",
    notes: "Keyless community API, daily asset metrics; history from each chain's genesis. Some metrics are refused for some assets on the community tier.",
    metrics: () => METRICS,
    async fetch(key, asset, fromMs, toMs): Promise<DailySeries> {
      return paged(key, asset, fromMs, toMs);
    },
    history(key, asset, sinceMs, opts) {
      return paged(key, asset, sinceMs ?? CM_START, now(), opts?.deadline);
    },
  };
}

export const cmProvider = createCmProvider();
