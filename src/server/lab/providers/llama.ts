import { z } from "zod";
import type { DailySeries } from "../types.js";
import { clip, getJson, requestTimeout, toDaily, type CollectableProvider, type LabMetricDef } from "./series.js";

// DefiLlama keyless history: total USD-pegged stablecoin supply and total DeFi TVL.

export const LLAMA_STABLES_URL = "https://stablecoins.llama.fi/stablecoincharts/all";
export const LLAMA_TVL_URL = "https://api.llama.fi/v2/historicalChainTvl";

const StablesSchema = z.array(
  z.object({
    date: z.union([z.string(), z.number()]),
    totalCirculatingUSD: z.object({ peggedUSD: z.number().optional() }).optional(),
  }),
);

const TvlSchema = z.array(z.object({ date: z.union([z.string(), z.number()]), tvl: z.number() }));

/** stablecoincharts/all → daily USD-pegged circulating supply. Exported for fixture tests. */
export function parseStablecoinChart(json: unknown): DailySeries {
  return toDaily(
    StablesSchema.parse(json).flatMap((r) =>
      r.totalCirculatingUSD?.peggedUSD == null ? [] : [{ t: Number(r.date) * 1000, v: r.totalCirculatingUSD.peggedUSD }],
    ),
    "last",
  );
}

/** v2/historicalChainTvl → daily total DeFi TVL. Exported for fixture tests. */
export function parseChainTvl(json: unknown): DailySeries {
  return toDaily(
    TvlSchema.parse(json).map((r) => ({ t: Number(r.date) * 1000, v: r.tvl })),
    "last",
  );
}

const SOURCES: Record<string, { url: string; parse: (json: unknown) => DailySeries }> = {
  stablecoin_cap: { url: LLAMA_STABLES_URL, parse: parseStablecoinChart },
  defi_tvl: { url: LLAMA_TVL_URL, parse: parseChainTvl },
};

const base = { provider: "llama", category: "liquidity", scope: "global", units: "USD", lagDays: 1, stationary: false } as const;
const METRICS: LabMetricDef[] = [
  { ...base, id: "llama:stablecoin_cap", key: "stablecoin_cap", name: "Stablecoin supply", description: "Total circulating USD-pegged stablecoins (DefiLlama), daily." },
  { ...base, id: "llama:defi_tvl", key: "defi_tvl", name: "DeFi TVL", description: "Total value locked across all chains (DefiLlama), daily." },
];

export function createLlamaProvider(fetchFn: typeof fetch = fetch): CollectableProvider {
  async function history(key: string, deadline?: number): Promise<DailySeries> {
    const src = SOURCES[key];
    if (!src) throw new Error(`unknown llama metric: ${key}`);
    return src.parse(await getJson(src.url, fetchFn, `llama ${key}`, requestTimeout(deadline, Date.now())));
  }
  return {
    id: "llama",
    name: "DefiLlama",
    notes: "Keyless. stablecoins.llama.fi stablecoincharts/all and api.llama.fi v2/historicalChainTvl, daily.",
    metrics: () => METRICS,
    async fetch(key, _asset, fromMs, toMs) {
      return clip(await history(key), fromMs, toMs);
    },
    // No windowed endpoint: always the whole (small) history; the collector keeps the tail.
    history: (key, _asset, _sinceMs, opts) => history(key, opts?.deadline),
  };
}

export const llamaProvider = createLlamaProvider();
