import { z } from "zod";
import type { DailySeries, LabProvider, MetricDef } from "../types.js";
import { clip, getJson, toDaily } from "./series.js";

// alternative.me Crypto Fear & Greed, full daily history (2018→), keyless.

export const FNG_URL = "https://api.alternative.me/fng/?limit=0&format=json";

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

const METRICS: MetricDef[] = [
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

export function createFngProvider(fetchFn: typeof fetch = fetch): LabProvider {
  return {
    id: "fng",
    name: "alternative.me Fear & Greed",
    notes: "Keyless. alternative.me /fng/?limit=0, daily history from Feb 2018.",
    metrics: () => METRICS,
    async fetch(key, _asset, fromMs, toMs) {
      if (key !== "value") throw new Error(`unknown fng metric: ${key}`);
      return clip(parseFngHistory(await getJson(FNG_URL, fetchFn, "fng")), fromMs, toMs);
    },
  };
}

export const fngProvider = createFngProvider();
