import { z } from "zod";
import { DAY_MS, type DailySeries } from "../types.js";
import { clip, getJson, toDaily, type CollectableProvider, type LabMetricDef } from "./series.js";

// Deribit DVOL (keyless): 30-day implied volatility index, daily candles since
// March 2021, for BTC and ETH. Global metrics, so ETH vol can inform any asset.
// ht:dvol stays the collector's intraday BTC snapshot; this is the full history.

export const DERIBIT_DVOL_URL = "https://www.deribit.com/api/v2/public/get_volatility_index_data";
/** DVOL starts in March 2021. */
const DVOL_EPOCH = Date.UTC(2021, 2, 24);
/** Daily candles per request stay under Deribit's 1000-point page. */
const WINDOW_MS = 900 * DAY_MS;

/** Metric key → Deribit currency. URLs are only ever built from this allow-list. */
const CURRENCY: Record<string, string> = { btc_dvol: "BTC", eth_dvol: "ETH" };

const DvolSchema = z.object({
  result: z.object({ data: z.array(z.array(z.number()).min(5)), continuation: z.number().nullish() }),
});

/** `{ result: { data: [[ms, o, h, l, c]] } }` → daily closes. Exported for fixture tests. */
export function parseDvolHistory(json: unknown): DailySeries {
  return toDaily(
    DvolSchema.parse(json).result.data.map((r) => ({ t: r[0]!, v: r[4]! })),
    "last",
  );
}

/** Request URLs covering fromMs → nowMs in WINDOW_MS steps. */
export function dvolUrls(key: string, fromMs: number, nowMs: number): string[] {
  const currency = CURRENCY[key];
  if (!currency) throw new Error(`unknown deribit metric: ${key}`);
  const urls: string[] = [];
  for (let lo = Math.max(fromMs, DVOL_EPOCH); lo < nowMs; lo += WINDOW_MS) {
    const hi = Math.min(nowMs, lo + WINDOW_MS);
    const q = new URLSearchParams({ currency, resolution: "1D", start_timestamp: String(lo), end_timestamp: String(hi) });
    urls.push(`${DERIBIT_DVOL_URL}?${q}`);
  }
  return urls;
}

const base = { provider: "deribit", category: "derivatives", scope: "global", units: "index", lagDays: 0 } as const;
const METRICS: LabMetricDef[] = [
  { ...base, id: "deribit:btc_dvol", key: "btc_dvol", name: "BTC DVOL (history)", description: "Deribit BTC 30-day implied volatility index, daily close since 2021." },
  { ...base, id: "deribit:eth_dvol", key: "eth_dvol", name: "ETH DVOL (history)", description: "Deribit ETH 30-day implied volatility index, daily close since 2021." },
];

export function createDeribitProvider(fetchFn: typeof fetch = fetch, now: () => number = Date.now): CollectableProvider {
  async function history(key: string, fromMs: number): Promise<DailySeries> {
    const points: Array<{ t: number; v: number }> = [];
    for (const url of dvolUrls(key, fromMs, now())) {
      const s = parseDvolHistory(await getJson(url, fetchFn, `deribit ${key}`));
      for (let i = 0; i < s.t.length; i++) points.push({ t: s.t[i]!, v: s.v[i]! });
    }
    return toDaily(points, "last");
  }
  return {
    id: "deribit",
    name: "Deribit DVOL",
    notes: "Keyless. public/get_volatility_index_data, daily candles (close) from March 2021, BTC and ETH.",
    metrics: () => METRICS,
    async fetch(key, _asset, fromMs, toMs) {
      return clip(await history(key, fromMs), fromMs, toMs);
    },
    history: (key, _asset, sinceMs) => history(key, sinceMs ?? DVOL_EPOCH),
  };
}

export const deribitProvider = createDeribitProvider();
