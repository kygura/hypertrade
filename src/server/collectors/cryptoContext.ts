// Keyless crypto market-context collector, ported from marketstate/src/crypto-context.ts:
// CoinGecko global (mcap, BTC dominance), alternative.me Fear & Greed, DefiLlama
// stablecoin cap, Deribit BTC DVOL. Per-source try/catch so one dead API never
// discards the others (SPEC.md: never fail the whole run over one tool).
import { z } from "zod";
import { ensureSeries, recordCollectorRun, upsertObservations, type Observation, type SeriesDef } from "../db";
import type { CollectorResult } from "./types";

const COLLECTOR = "crypto-context";

type SeriesPoint = { seriesId: string; value: number; units: string; description: string };

const CoinGeckoSchema = z.object({
  data: z.object({
    total_market_cap: z.object({ usd: z.number() }),
    market_cap_percentage: z.object({ btc: z.number() }),
  }),
});

export function parseCoinGecko(json: unknown): SeriesPoint[] {
  const p = CoinGeckoSchema.parse(json);
  return [
    { seriesId: "cg.total_mcap_usd", value: p.data.total_market_cap.usd, units: "USD", description: "Total crypto market cap (CoinGecko)" },
    { seriesId: "cg.btc_dominance", value: p.data.market_cap_percentage.btc, units: "%", description: "BTC market cap dominance (CoinGecko)" },
  ];
}

const FngSchema = z.object({ data: z.array(z.object({ value: z.string() })).min(1) });

export function parseFng(json: unknown): SeriesPoint[] {
  const parsed = FngSchema.parse(json);
  const value = Number(parsed.data[0]!.value);
  if (Number.isNaN(value)) throw new Error("fear/greed value is not numeric");
  return [{ seriesId: "fng.value", value, units: "index", description: "Fear & Greed index (alternative.me)" }];
}

// Only peggedUSD is read; z.object strips unknown keys so odd fields elsewhere
// (other pegs, missing circulating) can't fail the parse of a 400+ asset payload.
const StablecoinsSchema = z.object({
  peggedAssets: z.array(z.object({ pegType: z.string(), circulating: z.object({ peggedUSD: z.number().optional() }) })),
});

export function parseStablecoins(json: unknown): SeriesPoint[] {
  const parsed = StablecoinsSchema.parse(json);
  const cap = parsed.peggedAssets
    .filter((a) => a.pegType === "peggedUSD")
    .reduce((sum, a) => sum + (a.circulating.peggedUSD ?? 0), 0);
  return [{ seriesId: "llama.stablecoin_cap_usd", value: cap, units: "USD", description: "USD-pegged stablecoin market cap (DefiLlama)" }];
}

// Data points are [timestamp, open, high, low, close].
const DeribitSchema = z.object({ result: z.object({ data: z.array(z.array(z.number())).min(1) }) });

export function parseDeribit(json: unknown): SeriesPoint[] {
  const parsed = DeribitSchema.parse(json);
  const close = parsed.result.data.at(-1)?.[4];
  if (close === undefined) throw new Error("DVOL data point missing close");
  return [{ seriesId: "deribit.btc_dvol", value: close, units: "index", description: "BTC implied volatility index (Deribit DVOL)" }];
}

const SOURCES: Record<string, { url: string; parse: (json: unknown) => SeriesPoint[] }> = {
  coingecko: { url: "https://api.coingecko.com/api/v3/global", parse: parseCoinGecko },
  fng: { url: "https://api.alternative.me/fng/?limit=1", parse: parseFng },
  defillama: { url: "https://stablecoins.llama.fi/stablecoins?includePrices=false", parse: parseStablecoins },
  deribit: {
    url: `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=${Date.now() - 2 * 3_600_000}&end_timestamp=${Date.now()}`,
    parse: parseDeribit,
  },
};

async function getJson(url: string, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** db.ts calls, injectable so tests never need a live DATABASE_URL. */
export type CryptoContextDbDeps = { ensureSeries: typeof ensureSeries; upsertObservations: typeof upsertObservations; recordCollectorRun: typeof recordCollectorRun };
const defaultDeps: CryptoContextDbDeps = { ensureSeries, upsertObservations, recordCollectorRun };

export async function collectCryptoContext(fetchFn: typeof fetch = fetch, deps: CryptoContextDbDeps = defaultDeps): Promise<CollectorResult> {
  const startedAt = new Date();
  const settled = await Promise.allSettled(
    Object.entries(SOURCES).map(async ([name, src]) => {
      try {
        return src.parse(await getJson(src.url, fetchFn));
      } catch (err) {
        throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  const points: SeriesPoint[] = [];
  const errors: string[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") points.push(...s.value);
    else errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
  }

  if (points.length === 0) {
    const error = errors.join("; ") || "all sources failed";
    await deps.recordCollectorRun(COLLECTOR, startedAt, false, error);
    return { ok: false, error, written: 0 };
  }

  const seriesDefs: SeriesDef[] = points.map((p) => ({ id: p.seriesId, source: p.seriesId.split(".")[0], units: p.units, description: p.description }));
  const observations: Observation[] = points.map((p) => ({ seriesId: p.seriesId, ts: startedAt, value: p.value }));
  await deps.ensureSeries(seriesDefs);
  const written = await deps.upsertObservations(observations);

  const error = errors.length ? errors.join("; ") : undefined;
  await deps.recordCollectorRun(COLLECTOR, startedAt, true, error ?? null);
  return { ok: true, error, written };
}
