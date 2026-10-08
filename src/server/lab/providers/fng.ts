import { z } from "zod";
import { DAY_MS, type DailySeries } from "../types.js";
import { clip, getJson, requestTimeout, toDaily, type CollectableProvider, type LabMetricDef } from "./series.js";

// alternative.me Crypto Fear & Greed, full daily history (2018→), keyless.

export const FNG_URL = "https://api.alternative.me/fng/?limit=0&format=json";
/** The newest `days` daily values (limit counts back from today). */
export const fngUrl = (days: number): string => `https://api.alternative.me/fng/?limit=${Math.max(1, Math.floor(days))}&format=json`;

const FngHistorySchema = z.object({
  data: z.array(z.object({ value: z.string(), timestamp: z.string() })),
});

/** Raw /fng/?limit=0 payload → daily series. Exported for fixture tests. */
export function parseFngHistory(json: unknown): DailySeries {
  const rows = FngHistorySchema.parse(json).data;
  return toDaily(
    rows.map((r) => ({ t: Number(r.timestamp) * 1000, v: Number(r.value) })),
    "last",
  );
}

const METRICS: LabMetricDef[] = [
  {
    id: "fng:value",
    provider: "fng",
    key: "value",
    name: "Fear & Greed index",
    category: "sentiment",
    scope: "global",
    units: "index 0-100",
    description: "alternative.me Crypto Fear & Greed index, daily since 2018.",
    lagDays: 0,
  },
];

export function createFngProvider(fetchFn: typeof fetch = fetch, now: () => number = Date.now): CollectableProvider {
  return {
    id: "fng",
    name: "alternative.me Fear & Greed",
    notes: "Keyless. alternative.me /fng/?limit=0, daily history from Feb 2018.",
    metrics: () => METRICS,
    async fetch(key, _asset, fromMs, toMs) {
      if (key !== "value") throw new Error(`unknown fng metric: ${key}`);
      return clip(parseFngHistory(await getJson(FNG_URL, fetchFn, "fng")), fromMs, toMs);
    },
    async history(key, _asset, sinceMs, opts) {
      if (key !== "value") throw new Error(`unknown fng metric: ${key}`);
      const url = sinceMs == null ? FNG_URL : fngUrl(Math.ceil((now() - sinceMs) / DAY_MS) + 2);
      return parseFngHistory(await getJson(url, fetchFn, "fng", requestTimeout(opts?.deadline, now())));
    },
  };
}

export const fngProvider = createFngProvider();
