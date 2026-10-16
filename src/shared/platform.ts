import { z } from "zod";
import { AssetSchema, SideSchema } from "./intel.js";

// Platform contract (SPEC.md § Platform P0/P2): zod schemas and inferred types
// for every /api/platform response and the rows behind them. Server and UI
// both import this file. Request schemas are strict: they sit on the operator
// trust boundary.

const Iso = z.string().datetime({ offset: true });
const Num = z.number().finite();
const NonNeg = z.number().finite().nonnegative();
const Pos = z.number().finite().positive();
const Text = (max: number) => z.string().trim().min(1).max(max);

/** Lowercase 0x-prefixed 20-byte Hyperliquid account address. */
export const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/, "invalid address");
/** Outcome horizon from PLATFORM_OUTCOME_HORIZONS ("1h", "4h", "24h", "72h"). */
export const HorizonSchema = z.string().regex(/^\d+[mhd]$/, "invalid horizon");

// ─── Opportunities ───

/** Only directional has a cost model this phase (P0.10); extend the enum with a cost model. */
export const TradeTypeSchema = z.enum(["directional"]);
export type TradeType = z.infer<typeof TradeTypeSchema>;

export const OpportunityStatusSchema = z.enum(["new", "investigating", "calculated", "ready", "approved", "rejected", "expired", "open", "closed"]);
export type OpportunityStatus = z.infer<typeof OpportunityStatusSchema>;

/** P0.11 status machine. Anything not listed is illegal. */
export const OPPORTUNITY_TRANSITIONS: Readonly<Record<OpportunityStatus, readonly OpportunityStatus[]>> = {
  new: ["investigating", "calculated"],
  investigating: ["calculated"],
  calculated: ["ready"],
  ready: ["approved", "rejected", "expired"],
  approved: ["open", "rejected"],
  open: ["closed"],
  rejected: [],
  expired: [],
  closed: [],
};
/** Statuses that hold the (coin, direction, setupKind) dedupe slot. Must match 011_platform.sql's partial index. */
export const LIVE_STATUSES: readonly OpportunityStatus[] = ["new", "investigating", "calculated", "ready", "approved", "open"];
/** Transitions only an operator click may make (P0.11, Intel I4). */
export const OPERATOR_ONLY: readonly OpportunityStatus[] = ["approved", "rejected"];

export const EdgeBasisSchema = z.enum(["unvalidated", "ledger"]);
export const LiquidityTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type LiquidityTier = z.infer<typeof LiquidityTierSchema>;
export const ActorSchema = z.enum(["operator", "system"]);

export const CostsSchema = z.object({ feeBps: NonNeg, slippageBps: NonNeg, fundingBps: Num, absorbableUsd: NonNeg });
export type Costs = z.infer<typeof CostsSchema>;

export const OpportunitySchema = z.object({
  id: z.string().uuid(),
  coin: AssetSchema,
  direction: SideSchema,
  setupKind: Text(64),
  tradeType: TradeTypeSchema,
  status: OpportunityStatusSchema,
  score: Num,
  scoreVersion: Text(32),
  netEdgeBps: Num.nullable(),
  grossEdgeBps: Num.nullable(),
  edgeBasis: EdgeBasisSchema,
  costs: CostsSchema.nullable(),
  tags: z.array(Text(64)),
  liquidityTier: LiquidityTierSchema,
  /** classifyRegime output (src/server/desk/analytics.ts FlowRegime). */
  regime: Text(40),
  invalidation: Text(500),
  /** Code-computed ticket levels (never LLM output). entryPx is the mark at creation. */
  entryPx: Pos.nullable(),
  stopPx: Pos.nullable(),
  targetPx: Pos.nullable(),
  invalidationPx: Pos.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  snoozedUntil: Iso.nullable(),
  /** `${coin}|${direction}|${setupKind}`: one live opportunity per key (P0.11). */
  dedupeKey: Text(160),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

/** Named features (z-scores and raw ratios; null without enough history) and the raw inputs they came from. */
export const FeatureVectorSchema = z.object({
  features: z.record(Num.nullable()),
  inputs: z.record(z.unknown()),
});
export type FeatureVector = z.infer<typeof FeatureVectorSchema>;

// ─── Ledger (P0.12) ───

const PAYLOADS = {
  created: z.object({ features: FeatureVectorSchema, market: z.record(z.unknown()), score: Num, scoreVersion: Text(32) }),
  status: z.object({ from: OpportunityStatusSchema, to: OpportunityStatusSchema, actor: ActorSchema }),
  costs: CostsSchema.extend({ grossEdgeBps: Num.nullable(), netEdgeBps: Num.nullable(), edgeBasis: EdgeBasisSchema }),
  research: z.object({ researchId: Text(64), model: Text(120), promptVersion: Text(32), sources: z.array(z.string().url()) }),
  decision: z.object({ decision: z.enum(["approve", "reject"]), reason: Text(2000).nullable(), operator: Text(64) }),
  outcome: z.object({ horizon: HorizonSchema, entryBasis: z.enum(["mark", "fill"]), entryPx: Pos, horizonPx: Pos, grossReturn: Num, netReturn: Num }),
};
const stored = { id: z.number().int().positive(), opportunityId: z.string().uuid(), createdAt: Iso };
const entry = <K extends keyof typeof PAYLOADS>(kind: K) => z.object({ ...stored, kind: z.literal(kind), payload: PAYLOADS[kind] });
const newEntry = <K extends keyof typeof PAYLOADS>(kind: K) => z.object({ opportunityId: stored.opportunityId, kind: z.literal(kind), payload: PAYLOADS[kind] });

export const LedgerEntrySchema = z.discriminatedUnion("kind", [entry("created"), entry("status"), entry("costs"), entry("research"), entry("decision"), entry("outcome")]);
/** What the ledger is given (the store assigns id and createdAt). Stores parse every append with this. */
export const NewLedgerEntrySchema = z.discriminatedUnion("kind", [
  newEntry("created"), newEntry("status"), newEntry("costs"), newEntry("research"), newEntry("decision"), newEntry("outcome"),
]);
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type LedgerKind = LedgerEntry["kind"];
export type LedgerPayload<K extends LedgerKind> = Extract<LedgerEntry, { kind: K }>["payload"];
export type NewLedgerEntry = z.infer<typeof NewLedgerEntrySchema>;

export const LedgerStatsSchema = z.object({
  setupKind: Text(64),
  horizon: HorizonSchema,
  regime: Text(40).nullable(),
  tier: LiquidityTierSchema.nullable(),
  n: z.number().int().nonnegative(),
  hitRate: Num.nullable(),
  meanNet: Num.nullable(),
  /** 95% t-interval of the mean net return; null below n = 5 (P0.14). */
  ci95: z.tuple([Num, Num]).nullable(),
});
export type LedgerStats = z.infer<typeof LedgerStatsSchema>;

// ─── Positions and liquidation map ───

export const PositionSchema = z.object({
  address: AddressSchema,
  coin: AssetSchema,
  /** Signed size in coins: > 0 long, < 0 short. */
  szi: Num.refine((n) => n !== 0, "szi must be non-zero"),
  entryPx: Pos,
  positionValue: NonNeg,
  liquidationPx: Pos.nullable(),
  leverage: Pos.nullable(),
  /** Poll time of the address (the row's age for coverage). */
  updatedAt: Iso,
});
export type Position = z.infer<typeof PositionSchema>;

export const AddressRowSchema = z.object({
  address: AddressSchema,
  firstSeenAt: Iso,
  /** Last time the WS saw it trade. */
  lastSeenAt: Iso,
  polledAt: Iso.nullable(),
  /** Total position value at the last poll. */
  notionalUsd: NonNeg,
  positionCount: z.number().int().nonnegative(),
  /** Smallest |mark − liquidationPx| / mark across its positions at the last poll. */
  minLiqDistance: NonNeg.nullable(),
});
export type AddressRow = z.infer<typeof AddressRowSchema>;

/**
 * Fixed log-price grid (P0.7): bucket `idx` covers [(1+r)^idx, (1+r)^(idx+1)) with r = bucketBps / 1e4,
 * so cells line up across snapshots whatever the mark did.
 */
export const bucketIndex = (px: number, bucketBps: number) => Math.floor(Math.log(px) / Math.log(1 + bucketBps / 1e4));
export const bucketBounds = (idx: number, bucketBps: number) => ({ priceLo: (1 + bucketBps / 1e4) ** idx, priceHi: (1 + bucketBps / 1e4) ** (idx + 1) });

/** One stored grid cell. Longs liquidate below mark, shorts above. */
export const LiqCellSchema = z.object({ idx: z.number().int(), longUsd: NonNeg, shortUsd: NonNeg });
export type LiqCell = z.infer<typeof LiqCellSchema>;
/** A live cell with its price edges (bucketBounds). */
export const LiqBucketSchema = LiqCellSchema.extend({ priceLo: Pos, priceHi: Pos });
export type LiqBucket = z.infer<typeof LiqBucketSchema>;

export const CoverageSchema = z.object({
  trackedNotional: NonNeg,
  oiNotional: NonNeg,
  /** trackedNotional / oiNotional; 0 when OI is 0. */
  ratio: NonNeg,
  addresses: z.number().int().nonnegative(),
  pollAgeP50Sec: NonNeg.nullable(),
  pollAgeP90Sec: NonNeg.nullable(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const LiqMapSchema = z.object({
  coin: AssetSchema,
  ts: Iso,
  mark: Pos,
  bucketBps: Pos,
  buckets: z.array(LiqBucketSchema),
  coverage: CoverageSchema,
});
export type LiqMap = z.infer<typeof LiqMapSchema>;

/** A 15-min liqmap_snapshots row. */
export const LiqMapSnapshotSchema = z.object({ coin: AssetSchema, ts: Iso, mark: Pos, bucketBps: Pos, buckets: z.array(LiqCellSchema) });
export type LiqMapSnapshot = z.infer<typeof LiqMapSnapshotSchema>;

export const LiqMapHistorySchema = z.object({
  coin: AssetSchema,
  bucketBps: Pos,
  snapshots: z.array(LiqMapSnapshotSchema.pick({ ts: true, mark: true, buckets: true })),
});
export type LiqMapHistory = z.infer<typeof LiqMapHistorySchema>;

// ─── Health ───

export const LoopHealthSchema = z.object({ name: Text(32), lastBeatAt: Iso.nullable(), expectedIntervalSec: Pos, ok: z.boolean(), error: z.string().nullable() });
export const PlatformHealthSchema = z.object({
  ok: z.boolean(),
  ts: Iso,
  store: z.enum(["pg", "memory"]),
  loops: z.array(LoopHealthSchema),
  ws: z.object({ state: z.enum(["connecting", "open", "closed", "off"]), lastMessageAgeSec: NonNeg.nullable() }),
  scanAgeSec: NonNeg.nullable(),
  crawler: z.object({ pollsPerMin: NonNeg, addresses: z.number().int().nonnegative() }),
  llmSpendUsdToday: NonNeg.nullable(),
});
export type PlatformHealth = z.infer<typeof PlatformHealthSchema>;

// ─── /api/platform requests ───

const Limit = z.coerce.number().int().min(1).max(500);
export const FeedQuerySchema = z.object({
  status: z.string().optional().transform((s, ctx) => {
    if (!s) return undefined;
    const r = z.array(OpportunityStatusSchema).safeParse(s.split(","));
    if (!r.success) ctx.addIssue({ code: "custom", message: "invalid status" });
    return r.success ? r.data : undefined;
  }),
  tier: z.coerce.number().pipe(LiquidityTierSchema).optional(),
  limit: Limit.default(50),
}).strict();
export const LiqMapQuerySchema = z.object({
  coin: AssetSchema,
  /** Half-width around mark, as a fraction (0.2 = ±20%). */
  range: z.coerce.number().positive().max(1).default(0.2),
  bucketBps: z.coerce.number().int().min(1).max(1000).default(25),
}).strict();
export const LiqMapHistoryQuerySchema = z.object({ coin: AssetSchema, hours: z.coerce.number().int().min(1).max(14 * 24).default(24) }).strict();
export const LedgerStatsQuerySchema = z.object({
  setupKind: Text(64).optional(),
  regime: Text(40).optional(),
  tier: z.coerce.number().pipe(LiquidityTierSchema).optional(),
}).strict();
export const RejectBodySchema = z.object({ reason: Text(2000) }).strict();
export const SnoozeBodySchema = z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60) }).strict();

// ─── /api/platform responses ───

export const FeedRowSchema = OpportunitySchema.pick({
  id: true, coin: true, direction: true, setupKind: true, tradeType: true, status: true, score: true,
  netEdgeBps: true, edgeBasis: true, tags: true, liquidityTier: true, createdAt: true, updatedAt: true, snoozedUntil: true,
});
export type FeedRow = z.infer<typeof FeedRowSchema>;
/** GET /opportunities: sorted by score, highest first. */
export const FeedResponseSchema = z.object({ opportunities: z.array(FeedRowSchema), scanAgeSec: NonNeg.nullable() });
export type FeedResponse = z.infer<typeof FeedResponseSchema>;

export const SignalSchema = z.object({ name: Text(64), value: Num.nullable(), z: Num.nullable() });
/** Governor verdict as the desk returns it (src/ui/lib/desk.ts Verdict); extra fields pass through. */
export const RiskVerdictSchema = z.object({ approved: z.boolean(), reasons: z.array(z.string()), warnings: z.array(z.string()) }).passthrough();
/** GET /opportunities/:id. Costs, absorbableUsd and invalidation ride on `opportunity`. */
export const OpportunityDetailSchema = z.object({
  opportunity: OpportunitySchema,
  signals: z.array(SignalSchema),
  bearCase: z.string().nullable(),
  stats: LedgerStatsSchema.nullable(),
  risk: z.object({ before: RiskVerdictSchema, after: RiskVerdictSchema }).nullable(),
  /** Pre-filled ticket. sizeUsd comes from the governor preview only; null without one. */
  ticket: z.object({ side: SideSchema, entryPx: Pos.nullable(), stopPx: Pos.nullable(), targetPx: Pos.nullable(), sizeUsd: Pos.nullable(), sizeSource: z.literal("governor") }),
});
export type OpportunityDetail = z.infer<typeof OpportunityDetailSchema>;

/** GET /liqmap. */
export const LiqMapResponseSchema = LiqMapSchema;
/** GET /liqmap/history. */
export const LiqMapHistoryResponseSchema = LiqMapHistorySchema;
/** GET /ledger/stats. */
export const LedgerStatsResponseSchema = z.object({ stats: z.array(LedgerStatsSchema) });
export type LedgerStatsResponse = z.infer<typeof LedgerStatsResponseSchema>;
/** GET /ledger/:opportunityId: entries in insertion order. */
export const LedgerEntriesResponseSchema = z.object({ opportunityId: z.string().uuid(), entries: z.array(LedgerEntrySchema) });
export type LedgerEntriesResponse = z.infer<typeof LedgerEntriesResponseSchema>;
/** GET /health. */
export const PlatformHealthResponseSchema = PlatformHealthSchema;
