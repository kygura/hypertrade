// Zod schemas for everything crossing a trust boundary: branch config coming
// from the API/DB, routine-written data/*.json, and raw Hyperliquid responses.
// Types in ./types.ts are inferred from these where the shape is data, not code.
import { z } from "zod";

// ─── Branch model (docs/SPEC.md "Branch model") ───

// side/leverage default to long/1 (a spot leg); short or leverage > 1 makes it a
// perp leg. Refined here rather than on BranchConfigSchema so that one stays a
// plain ZodObject for its callers.
// Hyperliquid coin names: letters/digits, optionally "dex:"-prefixed (HIP-3), e.g. kPEPE, xyz:TSLA.
export const STABLES = new Set(["USDC", "USDT"]);
/** A perp leg is short or leveraged; everything else is spot. */
export const isPerp = (a: { side?: string; leverage?: number }) => a.side === "short" || (a.leverage ?? 1) > 1;

const CoinSchema = z.string().max(24).regex(/^([A-Za-z0-9]+:)?[A-Za-z0-9]+$/, "invalid coin name");

export const AllocationSchema = z
  .object({
    coin: CoinSchema,
    weightPct: z.number().finite().min(0),
    side: z.enum(["long", "short"]).optional(),
    leverage: z.number().min(1).max(50).optional(),
  })
  .strict()
  .refine((a) => !STABLES.has(a.coin.toUpperCase()) || (a.side !== "short" && (a.leverage ?? 1) === 1), {
    message: "stablecoins cannot be short or levered",
  });

const DcaSchema = z
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
// method "gbm" (default) draws from the typed assumptions; "bootstrap" resamples blocks of the
// branch's own simulated daily returns, so it also covers short and levered legs.
export const ScenarioSchema = z
  .object({
    horizonDays: z.number().int().min(1).max(3650),
    assumptions: z.array(ScenarioAssumptionSchema),
    paths: z.number().int().min(1),
    method: z.enum(["gbm", "bootstrap"]).optional(),
    blockDays: z.number().int().min(1).max(90).optional(),
    targetUsd: z.number().finite().positive().max(1e13).optional(),
  })
  .strict();

/** Trading costs: feeBps on every traded notional (entry, rebalance, DCA, cash flows); fundingAprPct
 * charged daily on perp notional (longs pay a positive rate, shorts receive it). */
export const CostsSchema = z
  .object({
    feeBps: z.number().finite().min(0).max(500),
    fundingAprPct: z.number().finite().min(-200).max(200).optional(),
  })
  .strict();

/** External cash on a schedule: positive adds money at the target weights, negative withdraws pro rata. */
export const CashflowSchema = z
  .object({
    amountUsd: z.number().finite().refine((n) => n !== 0, { message: "amount must not be 0" }),
    every: z.enum(["weekly", "monthly"]),
  })
  .strict();

const RebalanceSchema = z.enum(["none", "monthly", "weekly", "threshold5pct"]);

const DateSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid date" });

/** A dated move: at that day's close the whole portfolio is closed (perp legs realize) and re-opened at
 * `allocations`, weights as percent of the value at that moment. With `until`, the move fills instead on the day
 * between `date` and `until` where `ref` (default BTC) closes lowest (`at` "low", the default) or highest: hindsight
 * timing, an upper bound on what a real entry or exit would get. */
export const ScheduleStepSchema = z
  .object({
    date: DateSchema,
    until: DateSchema.optional(),
    at: z.enum(["low", "high"]).optional(),
    ref: CoinSchema.optional(),
    allocations: z.array(AllocationSchema).min(1).max(10),
    note: z.string().max(120).optional(),
  })
  .strict();

export const BranchConfigSchema = z.object({
  description: z.string().optional(),
  startDate: DateSchema,
  /** Last day of the replay; default today. */
  endDate: DateSchema.optional(),
  initialCapitalUsd: z.number().finite().positive().max(1e12),
  allocations: z.array(AllocationSchema).max(10),
  rebalance: RebalanceSchema,
  scenario: ScenarioSchema.optional(),
  dca: z.array(DcaSchema).max(8).optional(),
  costs: CostsSchema.optional(),
  cashflow: CashflowSchema.optional(),
  /** Length of the rolling start-date windows; default 365, 0 turns them off. */
  rollingWindowDays: z.number().int().min(0).max(1825).optional(),
  /** Dated moves after the start, applied in date order. */
  schedule: z.array(ScheduleStepSchema).max(12).optional(),
});

/** Every coin a branch touches (allocations, DCA, scheduled moves and their reference coins), uppercased as stored. */
export function branchCoins(config: {
  allocations: { coin: string }[];
  dca?: { coin: string }[];
  schedule?: { allocations: { coin: string }[]; ref?: string; until?: string }[];
}): string[] {
  const coins = [...config.allocations, ...(config.dca ?? [])].map((a) => a.coin);
  for (const s of config.schedule ?? []) {
    coins.push(...s.allocations.map((a) => a.coin));
    if (s.until) coins.push(s.ref ?? "BTC");
  }
  return [...new Set(coins)];
}

// ─── Routine contract (docs/SPEC.md "Routine Contract") ───

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

const HlUniverseAssetSchema = z.object({
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
