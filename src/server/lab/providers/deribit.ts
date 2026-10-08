import { z } from "zod";
import { DAY_MS, type DailySeries } from "../types.js";
import { clip, getJson, requestTimeout, toDaily, type CollectableProvider, type HistorySeries, type LabMetricDef } from "./series.js";

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
  /** Windows ascending from fromMs; with a deadline, stops there and returns the prefix as `partial`. */
  async function history(key: string, fromMs: number, deadline?: number): Promise<HistorySeries> {
    const points: Array<{ t: number; v: number }> = [];
    let partial = false;
    const urls = dvolUrls(key, fromMs, now());
    for (let i = 0; i < urls.length; i++) {
      const cut = () => i > 0 && deadline !== undefined && now() >= deadline;
      if (cut()) {
        partial = true;
        break;
      }
      let json: unknown;
      try {
        json = await getJson(urls[i]!, fetchFn, `deribit ${key}`, requestTimeout(deadline, now()));
      } catch (err) {
        if (cut()) {
          partial = true;
          break;
        }
        throw err;
      }
      const s = parseDvolHistory(json);
      for (let j = 0; j < s.t.length; j++) points.push({ t: s.t[j]!, v: s.v[j]! });
    }
    const out: HistorySeries = toDaily(points, "last");
    return partial ? { ...out, partial } : out;
  }
  return {
    id: "deribit",
    name: "Deribit DVOL",
    notes: "Keyless. public/get_volatility_index_data, daily candles (close) from March 2021, BTC and ETH.",
    metrics: () => METRICS,
    async fetch(key, _asset, fromMs, toMs) {
      return clip(await history(key, fromMs), fromMs, toMs);
    },
    history: (key, _asset, sinceMs, opts) => history(key, sinceMs ?? DVOL_EPOCH, opts?.deadline),
  };
}

export const deribitProvider = createDeribitProvider();
