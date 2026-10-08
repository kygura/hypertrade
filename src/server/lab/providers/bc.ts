import { z } from "zod";
import { DAY_MS, type DailySeries } from "../types.js";
import { clip, getJson, requestTimeout, toDaily, type CollectableProvider, type LabMetricDef } from "./series.js";

// blockchain.com charts (keyless): Bitcoin network history, daily since 2009.
// Global metrics: they describe the Bitcoin network whatever asset trades.

export const BC_BASE = "https://api.blockchain.info/charts/";
/** Before the first block: asking from here means the whole history. */
const BC_GENESIS = Date.UTC(2009, 0, 3);

/** Metric key → chart name. URLs are only ever built from this allow-list. */
const CHARTS: Record<string, string> = {
  hash_rate: "hash-rate",
  miners_revenue: "miners-revenue",
  difficulty: "difficulty",
  tx_volume_usd: "estimated-transaction-volume-usd",
};

const ChartSchema = z.object({ values: z.array(z.object({ x: z.number(), y: z.number() })) });

/** `{ values: [{ x: unixSeconds, y }] }` → daily series. Zero values are kept (early chain). Exported for fixture tests. */
export function parseBlockchainChart(json: unknown): DailySeries {
  return toDaily(
    ChartSchema.parse(json).values.map((p) => ({ t: p.x * 1000, v: p.y })),
    "last",
  );
}

/** Chart URL for `key` covering fromMs → now: `timespan=all`, or just enough days. */
export function bcUrl(key: string, fromMs: number, nowMs: number): string {
  const chart = CHARTS[key];
  if (!chart) throw new Error(`unknown bc metric: ${key}`);
  const span = fromMs <= BC_GENESIS ? "all" : `${Math.max(1, Math.ceil((nowMs - fromMs) / DAY_MS) + 1)}days`;
  return `${BC_BASE}${chart}?timespan=${span}&format=json&sampled=false`;
}

const base = { provider: "bc", scope: "global", lagDays: 1, stationary: false } as const;
const METRICS: LabMetricDef[] = [
  { ...base, id: "bc:hash_rate", key: "hash_rate", name: "BTC hash rate (blockchain.com)", category: "onchain", units: "TH/s", description: "Estimated Bitcoin network hash rate, daily (blockchain.com)." },
  { ...base, id: "bc:miners_revenue", key: "miners_revenue", name: "BTC miners revenue", category: "onchain", units: "USD", description: "Block rewards + fees paid to Bitcoin miners that day, in USD (blockchain.com)." },
  { ...base, id: "bc:difficulty", key: "difficulty", name: "BTC difficulty", category: "onchain", description: "Bitcoin mining difficulty (blockchain.com)." },
  { ...base, id: "bc:tx_volume_usd", key: "tx_volume_usd", name: "BTC transaction volume (USD)", category: "onchain", units: "USD", description: "Estimated USD value of Bitcoin transactions that day (blockchain.com)." },
];

export function createBcProvider(fetchFn: typeof fetch = fetch, now: () => number = Date.now): CollectableProvider {
  const history = async (key: string, fromMs: number, deadline?: number): Promise<DailySeries> =>
    parseBlockchainChart(await getJson(bcUrl(key, fromMs, now()), fetchFn, `bc ${key}`, requestTimeout(deadline, now())));
  return {
    id: "bc",
    name: "blockchain.com charts",
    notes: "Keyless. api.blockchain.info/charts (hash-rate, miners-revenue, difficulty, estimated-transaction-volume-usd), daily from 2009. Bitcoin network data: global metrics.",
    metrics: () => METRICS,
    async fetch(key, _asset, fromMs, toMs) {
      return clip(await history(key, fromMs), fromMs, toMs);
    },
    history: (key, _asset, sinceMs, opts) => history(key, sinceMs ?? BC_GENESIS, opts?.deadline),
  };
}

export const bcProvider = createBcProvider();
