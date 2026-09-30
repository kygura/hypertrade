// Hyperliquid perp collector. Reuses src/shared/hl-client.ts (already parses
// metaAndAssetCtxs into numeric AssetCtx[], premium included) instead of
// re-porting marketstate's fetch/parse — same wire call, one parser.
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import type { AssetCtx } from "../../shared/types.js";
import { ensureSeries, recordCollectorRun, upsertObservations, type Observation, type SeriesDef } from "../db.js";
import type { CollectorResult } from "./types.js";

const TOP_N = 20;
const COLLECTOR = "hyperliquid";

/** Pure transform: raw asset contexts -> series defs + observations. Exported for fixture tests. */
export function buildHyperliquidObservations(ctxs: AssetCtx[], ts: Date) {
  // OI-weighted funding skew, notional OI ranking: delisted and zero-OI assets
  // (thin/post-delist markets) are excluded as noise, mirroring marketstate.
  const live = ctxs
    .filter((c) => !c.isDelisted && c.openInterest > 0)
    .map((c) => ({ ...c, notionalOi: c.openInterest * c.markPx }));

  let totalOiUsd = 0;
  let weightedFundingSum = 0;
  for (const c of live) {
    totalOiUsd += c.notionalOi;
    weightedFundingSum += c.funding * c.notionalOi;
  }
  const fundingSkew = totalOiUsd > 0 ? weightedFundingSum / totalOiUsd : 0;

  const top = [...live].sort((a, b) => b.notionalOi - a.notionalOi).slice(0, TOP_N);

  const seriesDefs: SeriesDef[] = [
    { id: "hl.total_oi_usd", source: COLLECTOR, units: "USD", description: "Total perp notional open interest (Hyperliquid)" },
    { id: "hl.funding_skew", source: COLLECTOR, units: "fraction", description: "OI-weighted average funding rate (Hyperliquid)" },
  ];
  const observations: Observation[] = [
    { seriesId: "hl.total_oi_usd", ts, value: totalOiUsd },
    { seriesId: "hl.funding_skew", ts, value: fundingSkew },
  ];

  for (const c of top) {
    seriesDefs.push(
      { id: `hl.oi.${c.name}`, source: COLLECTOR, units: "USD", description: `${c.name} open interest (Hyperliquid)` },
      { id: `hl.funding.${c.name}`, source: COLLECTOR, units: "fraction", description: `${c.name} perp funding rate (Hyperliquid)` },
      { id: `hl.premium.${c.name}`, source: COLLECTOR, units: "fraction", description: `${c.name} mark-vs-oracle premium (Hyperliquid)` },
    );
    observations.push(
      { seriesId: `hl.oi.${c.name}`, ts, value: c.notionalOi },
      { seriesId: `hl.funding.${c.name}`, ts, value: c.funding },
      { seriesId: `hl.premium.${c.name}`, ts, value: c.premium },
    );
  }

  return { seriesDefs, observations, totalOiUsd, fundingSkew, topCoins: top.map((c) => c.name) };
}

/** db.ts calls, injectable so tests never need a live DATABASE_URL. */
export type HlDbDeps = { ensureSeries: typeof ensureSeries; upsertObservations: typeof upsertObservations; recordCollectorRun: typeof recordCollectorRun };
const defaultDeps: HlDbDeps = { ensureSeries, upsertObservations, recordCollectorRun };

export async function collectHyperliquid(fetchFn: typeof fetch = fetch, deps: HlDbDeps = defaultDeps): Promise<CollectorResult> {
  const startedAt = new Date();
  try {
    const { ctxs } = await fetchPerpMetaAndCtxs(fetchFn);
    const { seriesDefs, observations } = buildHyperliquidObservations(ctxs, startedAt);
    await deps.ensureSeries(seriesDefs);
    const written = await deps.upsertObservations(observations);
    await deps.recordCollectorRun(COLLECTOR, startedAt, true);
    return { ok: true, written };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await deps.recordCollectorRun(COLLECTOR, startedAt, false, error);
    return { ok: false, error, written: 0 };
  }
}
