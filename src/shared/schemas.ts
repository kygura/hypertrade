// Zod schemas for everything crossing a trust boundary: branch config coming
// from the API/DB, routine-written data/*.json, and raw Hyperliquid responses.
// Types in ./types.ts are inferred from these where the shape is data, not code.
import { z } from "zod";

// ─── Branch model (SPEC.md "Branch model") ───

// side/leverage default to long/1 (a spot leg); short or leverage > 1 makes it a
// perp leg. Refined here rather than on BranchConfigSchema so that one stays a
// plain ZodObject for its callers.
// Hyperliquid coin names: letters/digits, optionally "dex:"-prefixed (HIP-3), e.g. kPEPE, xyz:TSLA.
const CoinSchema = z.string().max(24).regex(/^([A-Za-z0-9]+:)?[A-Za-z0-9]+$/, "invalid coin name");

export const AllocationSchema = z
  .object({
    coin: CoinSchema,
    weightPct: z.number().finite().min(0),
    side: z.enum(["long", "short"]).optional(),
    leverage: z.number().min(1).max(50).optional(),
  })
  .strict()
  .refine((a) => !["USDC", "USDT"].includes(a.coin.toUpperCase()) || (a.side !== "short" && (a.leverage ?? 1) === 1), {
    message: "stablecoins cannot be short or levered",
  });

export const DcaSchema = z
  .object({
    coin: CoinSchema,
    amountUsd: z.number().finite().positive(),
    every: z.enum(["weekly", "monthly"]),
  })
  .strict();

export const ScenarioAssumptionSchema = z
  .object({
    coin: z.string(),
    annualReturnPct: z.number().finite(),
    annualVolPct: z.number().finite(),
  })
  .strict();

// horizonDays is capped because runMonteCarlo is synchronous: no deadline can interrupt it.
export const ScenarioSchema = z
  .object({
    horizonDays: z.number().int().min(1).max(3650),
    assumptions: z.array(ScenarioAssumptionSchema),
    paths: z.number().int().min(1),
  })
  .strict();

export const RebalanceSchema = z.enum(["none", "monthly", "weekly", "threshold5pct"]);

export const BranchConfigSchema = z.object({
  description: z.string().optional(),
  startDate: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid date" }),
  initialCapitalUsd: z.number().finite().positive().max(1e12),
  allocations: z.array(AllocationSchema).max(10),
  rebalance: RebalanceSchema,
  scenario: ScenarioSchema.optional(),
  dca: z.array(DcaSchema).max(8).optional(),
});

// ─── Routine contract (SPEC.md "Routine Contract") ───

export const MarketStateSignalSchema = z.object({
  label: z.string(),
  value: z.string(),
  direction: z.string(),
});

export const MarketStateDomainSchema = z.object({
  domain: z.string(),
  summary: z.string(),
  signals: z.array(MarketStateSignalSchema),
});

export const MarketStateThesisSchema = z.object({
  observe: z.string(),
  infer: z.string(),
  forecast: z.string(),
  disclaimer: z.string(),
});

export const MarketStateDataSchema = z.object({
  generated_at: z.string(),
  headline: z.string(),
  tldr: z.string(),
  domains: z.array(MarketStateDomainSchema),
  thesis: MarketStateThesisSchema,
  risks: z.array(z.string()),
});

export const SectorSchema = z.object({
  id: z.string(),
  label: z.string(),
  mindshare_score: z.number().min(0).max(1),
  momentum: z.number().min(-1).max(1),
  rationale: z.string(),
  tokens: z.array(z.string()),
  sources: z.array(z.string()),
});

export const RotationSchema = z.object({
  from: z.string(),
  to: z.string(),
  confidence: z.number(),
  trigger: z.string(),
  note: z.string(),
});

export const SectorsDataSchema = z.object({
  generated_at: z.string(),
  sectors: z.array(SectorSchema),
  rotations: z.array(RotationSchema),
});

// ─── Hyperliquid raw response shapes ───
// Pattern lifted from marketstate/src/hyperliquid.ts (the better-typed of the
// two ported sources): numeric fields come back as strings and some are
// nullable for delisted/thin markets, so the schema is the parse boundary —
// callers work with the numeric AssetCtx/Candle types in ./types.ts instead.

export const HlUniverseAssetSchema = z.object({
  szDecimals: z.number(),
  name: z.string(),
  maxLeverage: z.number(),
  marginTableId: z.number().optional(),
  isDelisted: z.boolean().optional(),
});

export const HlPerpMetaSchema = z.object({
  universe: z.array(HlUniverseAssetSchema),
});

export const HlAssetCtxSchema = z.object({
  funding: z.string(),
  openInterest: z.string(),
  prevDayPx: z.string(),
  dayNtlVlm: z.string(),
  premium: z.string().nullable(),
  oraclePx: z.string(),
  markPx: z.string(),
  midPx: z.string().nullable().optional(),
  impactPxs: z.array(z.string()).nullable().optional(),
  dayBaseVlm: z.string(),
});

// metaAndAssetCtxs response is a 2-tuple: [{universe}, assetCtx[]], assetCtx
// aligned to universe by array index (not by name).
export const HlMetaAndAssetCtxsResponseSchema = z.tuple([HlPerpMetaSchema, z.array(HlAssetCtxSchema)]);

export const HlAllMidsSchema = z.record(z.string(), z.string());

export const HlCandleSchema = z.object({
  t: z.number(),
  T: z.number(),
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
  v: z.string(),
  s: z.string().optional(),
  i: z.string().optional(),
  n: z.number().optional(),
});

export const HlCandlesResponseSchema = z.array(HlCandleSchema);
