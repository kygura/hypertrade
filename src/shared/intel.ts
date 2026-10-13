import { z } from "zod";
import { ClaimSchema } from "./claims.js";

// Intel contract (SPEC.md § Intel I0/I2): zod schemas and inferred types for
// every /api/intel request and response and the domain objects behind them.
// Server and UI both import this file. Request schemas are strict: they sit
// on trust boundaries (operator input, LLM output parsed into DSL/intents).

// ─── Primitives ───

/** Hyperliquid coin name, optionally "dex:"-prefixed (same rule as schemas.ts CoinSchema). */
export const AssetSchema = z.string().trim().max(24).regex(/^([A-Za-z0-9]+:)?[A-Za-z0-9]+$/, "invalid asset");
/** Graph node / event entity: a coin, protocol, stablecoin or macro series ("Jito", "USDC", "DXY"). */
export const EntitySchema = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N} ._:/&+-]+$/u, "invalid entity");
const Iso = z.string().datetime({ offset: true });
const Num = z.number().finite();
const Pos = z.number().finite().positive();
const Text = (max: number) => z.string().trim().min(1).max(max);

export const SideSchema = z.enum(["long", "short"]);
export type Side = z.infer<typeof SideSchema>;

/** Public https URL. IP literals and local hostnames are refused: watches and catalysts get fetched server-side. */
export const HttpsUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((s) => {
    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase();
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        host.includes(".") &&
        !/^[\d.]+$/.test(host) &&
        !host.startsWith("[") &&
        !/(^|\.)(localhost|local|internal|home|lan)$/.test(host)
      );
    } catch {
      return false;
    }
  }, "must be a public https URL");

export const EvmAddressSchema = z.string().trim().regex(/^0x[0-9a-fA-F]{40}$/, "invalid EVM address");

export const SourceHealthSchema = z.object({
  source: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

/** Every LLM call's record (SPEC I0.6); stored with each alert, brief and report. */
export const LlmTraceSchema = z.object({
  promptVersion: z.string(),
  tier: z.enum(["cheap", "strong"]),
  /** Null when no provider was called (cache hit, not configured, cap). */
  model: z.string().nullable(),
  inputs: z.unknown(),
  output: z.unknown(),
  usage: z.unknown(),
  ms: Num,
  cached: z.boolean().optional(),
  attempts: z.number().int().optional(),
  /** Claim lines dropped by the validator (I0.7). */
  dropped: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type LlmTrace = z.infer<typeof LlmTraceSchema>;

// ─── Positions and watchlist (I0.2) ───

export const PositionSourceSchema = z.enum(["manual", "hl", "desk"]);
export type PositionSource = z.infer<typeof PositionSourceSchema>;

export const ExposurePositionSchema = z.object({
  id: z.string(),
  source: PositionSourceSchema,
  asset: z.string(),
  side: SideSchema,
  size: Num,
  entryPx: Num,
  /** Entry price when no mark was available (unrealizedPnl is then null). */
  markPx: Num,
  stopPx: Num.nullable(),
  leverage: Num,
  venue: z.string(),
  notionalUsd: Num,
  unrealizedPnl: Num.nullable(),
});
export type ExposurePosition = z.infer<typeof ExposurePositionSchema>;

export const PositionSourceStatusSchema = SourceHealthSchema.extend({ source: PositionSourceSchema });
export type PositionSourceStatus = z.infer<typeof PositionSourceStatusSchema>;

export const PositionsResponseSchema = z.object({
  positions: z.array(ExposurePositionSchema),
  sources: z.array(PositionSourceStatusSchema),
  totalNotionalUsd: Num,
});
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>;

export const ManualPositionInputSchema = z
  .object({
    asset: AssetSchema,
    side: SideSchema,
    size: Pos,
    entryPx: Pos,
    stopPx: Pos.optional(),
    leverage: z.number().finite().min(1).max(50).default(1),
    venue: Text(40).default("manual"),
  })
  .strict();
export type ManualPositionInput = z.input<typeof ManualPositionInputSchema>;
export type ManualPositionData = z.output<typeof ManualPositionInputSchema>;

export const ManualPositionSchema = z.object({
  id: z.string(),
  asset: z.string(),
  side: SideSchema,
  size: Num,
  entryPx: Num,
  stopPx: Num.nullable(),
  leverage: Num,
  venue: z.string(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type ManualPosition = z.infer<typeof ManualPositionSchema>;

export const WatchlistItemSchema = z
  .object({
    asset: AssetSchema,
    tags: z.array(z.string().trim().min(1).max(32)).max(10).default([]),
  })
  .strict();
export type WatchlistItem = z.output<typeof WatchlistItemSchema>;

export const WatchlistPutSchema = z
  .object({ items: z.array(WatchlistItemSchema).max(100) })
  .strict()
  .refine((w) => new Set(w.items.map((i) => i.asset)).size === w.items.length, { message: "duplicate asset", path: ["items"] });
export type WatchlistPut = z.input<typeof WatchlistPutSchema>;

export const WatchlistResponseSchema = z.object({
  items: z.array(WatchlistItemSchema),
  /** True when the list is DESK_WATCHLIST because intel_watchlist is empty. */
  fallback: z.boolean(),
});
export type WatchlistResponse = z.infer<typeof WatchlistResponseSchema>;

export const ReviewSchema = z.object({
  id: z.string(),
  ts: Iso,
  via: z.enum(["ui", "deeplink"]),
  briefId: z.string().nullable(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const ReviewsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
export const ReviewsResponseSchema = z.object({ reviews: z.array(ReviewSchema) });

// ─── Snapshots and diffs (I0.3–I0.5) ───

export const SNAPSHOT_METRICS = [
  "price",
  "oi_usd",
  "funding",
  "premium",
  "basis",
  "vol24h",
  "depth_bid_1",
  "depth_ask_1",
  "depth_bid_2",
  "depth_ask_2",
  "spread_bps",
] as const;
export const SnapshotMetricSchema = z.enum(SNAPSHOT_METRICS);
export type SnapshotMetric = z.infer<typeof SnapshotMetricSchema>;

export const SnapshotRowSchema = z.object({
  asset: z.string(),
  ts: Iso,
  price: Num,
  vol24h: Num.nullable(),
  funding: Num.nullable(),
  oiUsd: Num.nullable(),
  premium: Num.nullable(),
  basis: Num.nullable(),
  depthBid1: Num.nullable(),
  depthAsk1: Num.nullable(),
  depthBid2: Num.nullable(),
  depthAsk2: Num.nullable(),
  spreadBps: Num.nullable(),
});
export type SnapshotRow = z.infer<typeof SnapshotRowSchema>;

/** How DiffItem.delta reads: percent change, basis points, USD, or the raw metric unit. */
export const DeltaUnitSchema = z.enum(["pct", "bps", "usd", "abs"]);
export type DeltaUnit = z.infer<typeof DeltaUnitSchema>;

export const DiffItemSchema = z.object({
  asset: z.string(),
  metric: SnapshotMetricSchema,
  /** True when any position source holds the asset (false: watchlist only). */
  held: z.boolean(),
  /** Baseline value (at baselineTs). */
  from: Num,
  /** Current value (at ts). */
  to: Num,
  delta: Num,
  deltaUnit: DeltaUnitSchema,
  z: Num,
  materiality: Num,
  exposureWeight: Num,
  stopProximity: Num,
  /** Distance from mark to the nearest known stop, in percent and in ATR14(1h); absent without a stop. */
  stopDistPct: Num.optional(),
  stopDistAtr: Num.optional(),
  ts: Iso,
  baselineTs: Iso,
});
export type DiffItem = z.infer<typeof DiffItemSchema>;

// ─── Exposure graph (I0.8) ───

export const EDGE_TYPES = ["direct", "settles_on", "collateral", "depends_on_stable", "primary_venue", "bridge", "narrative", "macro_beta"] as const;
export const EdgeTypeSchema = z.enum(EDGE_TYPES);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;
/** Path weight factor per edge type (SPEC I0.8). */
export const EDGE_TYPE_WEIGHT: Record<EdgeType, number> = {
  direct: 1,
  collateral: 0.8,
  settles_on: 0.6,
  depends_on_stable: 0.6,
  bridge: 0.5,
  primary_venue: 0.4,
  narrative: 0.4,
  macro_beta: 0.3,
};

export const EdgeOriginSchema = z.enum(["seed", "llm", "user"]);
export type EdgeOrigin = z.infer<typeof EdgeOriginSchema>;

export const EdgeSchema = z.object({
  id: z.string(),
  src: z.string(),
  dst: z.string(),
  type: EdgeTypeSchema,
  weight: Num,
  /** Evidence URL (required for llm edges), or a label for seed edges. */
  source: z.string().nullable(),
  lastVerified: Iso.nullable(),
  origin: EdgeOriginSchema,
});
export type Edge = z.infer<typeof EdgeSchema>;

export const UserEdgeInputSchema = z
  .object({
    src: EntitySchema,
    dst: EntitySchema,
    type: EdgeTypeSchema,
    weight: z.number().finite().min(0).max(1).optional(),
    source: HttpsUrlSchema.optional(),
  })
  .strict()
  .refine((e) => e.src !== e.dst, { message: "src and dst must differ" });
export type UserEdgeInput = z.input<typeof UserEdgeInputSchema>;

export const EdgeKeySchema = z.object({ src: EntitySchema, dst: EntitySchema, type: EdgeTypeSchema }).strict();
export type EdgeKey = z.infer<typeof EdgeKeySchema>;

export const PathEdgeSchema = z.object({ from: z.string(), to: z.string(), type: EdgeTypeSchema });
export type PathEdge = z.infer<typeof PathEdgeSchema>;

export const GraphPathSchema = z.object({
  /** Where the walk started (event entity or the asset asked about). */
  from: z.string(),
  /** The held or watched asset it reaches. */
  to: z.string(),
  edges: z.array(PathEdgeSchema).min(1).max(2),
  hops: z.number().int().min(1).max(2),
  weight: Num,
});
export type GraphPath = z.infer<typeof GraphPathSchema>;

export const GraphQuerySchema = z.object({ asset: EntitySchema });
export const GraphResponseSchema = z.object({ asset: z.string(), edges: z.array(EdgeSchema), paths: z.array(GraphPathSchema) });
export type GraphResponse = z.infer<typeof GraphResponseSchema>;

// ─── Events, clusters, catalysts (I0.9, I0.10, I0.13) ───

export const EVENT_TYPES = [
  "exploit",
  "depeg",
  "listing",
  "delisting",
  "unlock",
  "governance",
  "upgrade",
  "regulatory",
  "macro",
  "partnership",
  "outage",
  "liquidation",
  "other",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventOriginSchema = z.enum(["rss", "governance", "calendar", "websearch", "x", "telegram", "manual", "docwatch"]);
export type EventOrigin = z.infer<typeof EventOriginSchema>;

export const MagnitudeSchema = z.enum(["low", "med", "high"]);
export type Magnitude = z.infer<typeof MagnitudeSchema>;

export const ClaimTagSchema = z.enum(["observed", "hypothesis"]);

export const EventSourceSchema = z.object({ label: Text(120), url: z.string().trim().max(2000).optional() }).strict();
export type EventSource = z.infer<typeof EventSourceSchema>;

export const CatalystInfoSchema = z
  .object({
    size: Text(120).optional(),
    /** Always a hypothesis (SPEC I0.13). */
    directionHypothesis: z.enum(["up", "down", "unclear"]).optional(),
  })
  .strict();
export type CatalystInfo = z.infer<typeof CatalystInfoSchema>;

/** What the LLM extracts from a headline cluster (cheap tier). */
export const EventExtractionSchema = z
  .object({
    type: EventTypeSchema,
    entities: z.array(EntitySchema).max(20),
    assets: z.array(AssetSchema).max(20),
    magnitude: MagnitudeSchema,
    summary: Text(600),
    scheduledAt: Iso.nullable(),
    catalyst: CatalystInfoSchema.nullable(),
  })
  .strict();
export type EventExtraction = z.infer<typeof EventExtractionSchema>;

export const IntelEventSchema = z.object({
  id: z.string(),
  /** Source identity (feed guid, proposal id, url hash); upserts key on it. */
  key: z.string(),
  clusterId: z.string().nullable(),
  type: EventTypeSchema,
  title: z.string(),
  summary: z.string().nullable(),
  entities: z.array(z.string()),
  assets: z.array(z.string()),
  magnitude: MagnitudeSchema,
  sources: z.array(EventSourceSchema),
  origin: EventOriginSchema,
  firstSeen: Iso,
  scheduledAt: Iso.nullable(),
  catalyst: CatalystInfoSchema.nullable(),
  tag: ClaimTagSchema,
});
export type IntelEvent = z.infer<typeof IntelEventSchema>;

export const ClusterSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  entities: z.array(z.string()),
  extraction: EventExtractionSchema.nullable(),
  firstSeen: Iso,
  lastSeen: Iso,
  mappedAt: Iso.nullable(),
});
export type Cluster = z.infer<typeof ClusterSchema>;

export const CatalystSchema = z.object({
  eventId: z.string(),
  title: z.string(),
  type: EventTypeSchema,
  assets: z.array(z.string()),
  scheduledAt: Iso,
  origin: EventOriginSchema,
  catalyst: CatalystInfoSchema.nullable(),
  tag: ClaimTagSchema,
  sources: z.array(EventSourceSchema),
  /** Held or watched assets among `assets`. */
  exposed: z.array(z.string()),
});
export type Catalyst = z.infer<typeof CatalystSchema>;

export const ManualCatalystInputSchema = z
  .object({
    title: Text(200),
    assets: z.array(AssetSchema).min(1).max(10),
    scheduledAt: Iso,
    type: EventTypeSchema.default("other"),
    size: Text(120).optional(),
    directionHypothesis: z.enum(["up", "down", "unclear"]).optional(),
    url: HttpsUrlSchema.optional(),
  })
  .strict();
export type ManualCatalystInput = z.input<typeof ManualCatalystInputSchema>;

export const EventsQuerySchema = z.object({ since: Iso.optional(), type: EventTypeSchema.optional() });
export const EventsResponseSchema = z.object({ events: z.array(IntelEventSchema) });
export const CatalystsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) });
export const CatalystsResponseSchema = z.object({ catalysts: z.array(CatalystSchema) });

// ─── Alerts and feedback (I0.11, I0.12) ───

export const AlertKindSchema = z.enum(["mapper", "catalyst", "docwatch", "terminal"]);
export type AlertKind = z.infer<typeof AlertKindSchema>;
export const CatalystWindowSchema = z.enum(["24h", "1h"]);
export type CatalystWindow = z.infer<typeof CatalystWindowSchema>;

export const PricedInSchema = z.object({
  pricePct: Num,
  /** Null when only candles were available (no OI history at first_seen). */
  oiPct: Num.nullable(),
  since: Iso,
});
export type PricedIn = z.infer<typeof PricedInSchema>;

export const AlertSchema = z.object({
  id: z.string(),
  kind: AlertKindSchema,
  /** Dedupe reference: cluster id (mapper), event id (catalyst), watch change id (docwatch), brief id (terminal). */
  ref: z.string(),
  /** Catalyst alerts only (T−24 h / T−1 h). */
  window: CatalystWindowSchema.nullable(),
  asset: z.string(),
  title: z.string(),
  eventType: z.string().nullable(),
  line: ClaimSchema,
  path: z.array(PathEdgeSchema),
  edgeType: EdgeTypeSchema.nullable(),
  hops: z.number().int().min(0).max(2),
  /** Π(edge type weight) × 0.5^(hops−1); 1 for a direct hit (SPEC I0.8). */
  pathWeight: Num,
  /** Evidence behind the triggering event or change. */
  sources: z.array(EventSourceSchema),
  materiality: Num,
  pricedIn: PricedInSchema.nullable(),
  route: z.enum(["push", "batch"]),
  feedback: z.union([z.literal(-1), z.literal(1)]).nullable(),
  createdAt: Iso,
  trace: LlmTraceSchema.optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const AlertsQuerySchema = z.object({ since: Iso.optional(), kind: AlertKindSchema.optional() });
export const AlertsResponseSchema = z.object({ alerts: z.array(AlertSchema) });
export const AlertFeedbackInputSchema = z.object({ vote: z.union([z.literal(1), z.literal(-1)]) }).strict();
export type AlertFeedbackInput = z.infer<typeof AlertFeedbackInputSchema>;

export const FeedbackBucketSchema = z.object({
  eventType: z.string().nullable(),
  edgeType: EdgeTypeSchema.nullable(),
  hops: z.number().int(),
  up: z.number().int(),
  down: z.number().int(),
  total: z.number().int(),
});
export type FeedbackBucket = z.infer<typeof FeedbackBucketSchema>;

// ─── Terminal brief (I0.14) ───

export const BriefSurfaceSchema = z.enum(["ui", "cron"]);
export type BriefSurface = z.infer<typeof BriefSurfaceSchema>;

/** Last run per ingest source (collector_runs `intel:<source>`). */
export const IngestHealthSchema = z.object({
  source: z.string(),
  ok: z.boolean(),
  lastRunAt: Iso.nullable(),
  error: z.string().optional(),
});
export type IngestHealth = z.infer<typeof IngestHealthSchema>;

export const BriefSchema = z.object({
  id: z.string(),
  createdAt: Iso,
  surface: BriefSurfaceSchema,
  /** Baseline snapshot time the diff ran against. */
  since: Iso,
  items: z.array(DiffItemSchema),
  alerts: z.array(AlertSchema),
  catalysts: z.array(CatalystSchema),
  lines: z.array(ClaimSchema),
  /** Nothing cleared the thresholds. */
  silent: z.boolean(),
  /** Thresholds in force (INTEL_MIN_Z, INTEL_PUSH_MATERIALITY). */
  threshold: z.object({ minZ: Num, pushMateriality: Num }).optional(),
  ingest: z.array(IngestHealthSchema).optional(),
  /** Asset × metric pairs that had a z (diffed), cleared or not. */
  diffedCount: z.number().int().nonnegative().optional(),
  trace: LlmTraceSchema.optional(),
});
export type Brief = z.infer<typeof BriefSchema>;
export const BriefLatestResponseSchema = z.object({ brief: BriefSchema.nullable() });
export const BriefLatestQuerySchema = z.object({ surface: BriefSurfaceSchema.optional() });
/** POST /brief body (optional): `deeplink` when the open came from Telegram's `/?review=1`. */
export const BriefRequestSchema = z.object({ via: ReviewSchema.shape.via.default("ui") }).strict();
export type BriefRequest = z.input<typeof BriefRequestSchema>;

// ─── Journal (I0.15) ───

export const SessionSchema = z.enum(["asia", "eu", "us", "off"]);
export type Session = z.infer<typeof SessionSchema>;

export const TradeSchema = z.object({
  /** `<venue>:<coin>:<open fill tid>` */
  id: z.string(),
  venue: z.enum(["hl", "desk"]),
  asset: z.string(),
  side: SideSchema,
  openedAt: Iso,
  /** Null while the round trip is still open. */
  closedAt: Iso.nullable(),
  size: Num,
  entryPx: Num,
  exitPx: Num.nullable(),
  pnlUsd: Num,
  feesUsd: Num,
  holdMs: Num.nullable(),
  session: SessionSchema,
  stopPx: Num.nullable(),
  r: Num.nullable(),
  /** Max adverse / favourable excursion from 1h candles, in maeUnit (R when a stop is known, else percent). */
  mae: Num.nullable(),
  mfe: Num.nullable(),
  maeUnit: z.enum(["r", "pct"]),
  entryState: z.object({ fundingZ: Num.nullable(), oiZ: Num.nullable(), change24hPct: Num.nullable() }),
  tag: z.string().nullable(),
  note: z.string().nullable(),
  noteSummary: ClaimSchema.nullable(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const TagStatsSchema = z.object({
  tag: z.string(),
  trades: z.number().int(),
  winRate: Num,
  avgR: Num.nullable(),
  avgHoldMs: Num.nullable(),
  avgMaePct: Num.nullable(),
  avgMfePct: Num.nullable(),
  expectancyUsd: Num,
  expectancyR: Num.nullable(),
});
export type TagStats = z.infer<typeof TagStatsSchema>;

export const JournalQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
export const JournalResponseSchema = z.object({ trades: z.array(TradeSchema), stats: z.array(TagStatsSchema), sources: z.array(SourceHealthSchema) });
export type JournalResponse = z.infer<typeof JournalResponseSchema>;

export const TradeIdSchema = z.string().max(120).regex(/^(hl|desk):([A-Za-z0-9]+:)?[A-Za-z0-9]+:[A-Za-z0-9_-]+$/, "invalid trade id");
export const TradeNoteInputSchema = z.object({ note: z.string().trim().max(500) }).strict();
export const TradeNoteSchema = z.object({
  tradeId: z.string(),
  note: z.string().nullable(),
  tag: z.string().nullable(),
  summary: ClaimSchema.nullable(),
  updatedAt: Iso,
});
export type TradeNote = z.infer<typeof TradeNoteSchema>;
export const JournalTagResponseSchema = z.object({ tagged: z.number().int() });

export const ReportFindingSchema = z.object({
  tag: z.string(),
  tradeIds: z.array(z.string()),
  trades: z.number().int(),
  expectancyUsd: Num,
  expectancyR: Num.nullable(),
  line: ClaimSchema.nullable(),
});
export type ReportFinding = z.infer<typeof ReportFindingSchema>;

export const JournalReportSchema = z.object({
  id: z.string(),
  kind: z.literal("journal_weekly"),
  createdAt: Iso,
  periodDays: z.number().int(),
  leaks: z.array(ReportFindingSchema),
  edges: z.array(ReportFindingSchema),
  lines: z.array(ClaimSchema),
  trace: LlmTraceSchema.optional(),
});
export type JournalReport = z.infer<typeof JournalReportSchema>;

export const FeedbackReportSchema = z.object({
  id: z.string(),
  kind: z.literal("feedback_weekly"),
  createdAt: Iso,
  buckets: z.array(FeedbackBucketSchema.extend({ suggestion: z.string() })),
});
export type FeedbackReport = z.infer<typeof FeedbackReportSchema>;

export const ReportSchema = z.discriminatedUnion("kind", [JournalReportSchema, FeedbackReportSchema]);
export type Report = z.infer<typeof ReportSchema>;
export type ReportKind = Report["kind"];

// ─── Theses (I0.16) ───

const CmpOpSchema = z.enum([">", ">=", "<", "<="]);
const SeriesIdSchema = z.string().trim().max(80).regex(/^[A-Za-z0-9_.:-]+$/, "invalid series id");
const HoursSchema = z.number().int().min(1).max(2160);

export const ThesisCheckSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("metric_threshold"), series: SeriesIdSchema, op: CmpOpSchema, value: Num }).strict(),
  z.object({ kind: z.literal("price_vs_level"), asset: AssetSchema, op: CmpOpSchema, level: Pos }).strict(),
  z.object({ kind: z.literal("funding_sign"), asset: AssetSchema, sign: z.enum(["positive", "negative"]) }).strict(),
  z.object({ kind: z.literal("oi_change"), asset: AssetSchema, window_h: HoursSchema, op: CmpOpSchema, pct: Num }).strict(),
  z.object({ kind: z.literal("event_exists"), query: Text(200), since_h: HoursSchema }).strict(),
  z.object({ kind: z.literal("unknown"), reason: Text(300).optional() }).strict(),
]);
export type ThesisCheck = z.infer<typeof ThesisCheckSchema>;

/** What a check evaluated to, and where the number came from. */
export const ThesisEvidenceSchema = z
  .object({
    value: z.union([Num, z.string(), z.null()]),
    source: z.object({ label: Text(120), url: z.string().trim().max(2000).optional() }).strict(),
    ts: Iso,
  })
  .strict();
export type ThesisEvidence = z.infer<typeof ThesisEvidenceSchema>;

export const ThesisClaimSchema = z
  .object({
    /** claim: stated in the thesis; assumption: an unstated premise it relies on. */
    kind: z.enum(["claim", "assumption"]),
    text: Text(600),
    check: ThesisCheckSchema,
    status: z.enum(["supported", "contradicted", "unknown"]),
    evidence: ThesisEvidenceSchema.optional(),
  })
  .strict();
export type ThesisClaim = z.infer<typeof ThesisClaimSchema>;

export const ThesisSchema = z.object({
  id: z.string(),
  text: z.string(),
  assets: z.array(z.string()),
  claims: z.array(ThesisClaimSchema),
  /** Levels/conditions that would invalidate the thesis; status once code could evaluate them. */
  invalidation: z.array(z.object({ text: z.string(), status: z.enum(["triggered", "clear", "unknown"]).optional() })),
  /** "What has to be true for this to be wrong", claim-tagged. */
  wrongIf: z.array(ClaimSchema),
  createdAt: Iso,
  checkedAt: Iso.nullable(),
  trace: LlmTraceSchema.optional(),
});
export type Thesis = z.infer<typeof ThesisSchema>;

export const ThesisInputSchema = z.object({ text: Text(4000) }).strict();
export const ThesesResponseSchema = z.object({ theses: z.array(ThesisSchema) });

// ─── Screener DSL (I0.17) ───

type ColKind = "num" | "text" | "ts";
/** Per-table column allowlist. Only these names ever reach the compiled SQL. */
export const SCREENER_TABLES = {
  snapshots: {
    assetCol: "asset",
    cols: {
      asset: "text", ts: "ts", price: "num", vol24h: "num", funding: "num", oi_usd: "num", premium: "num", basis: "num",
      depth_bid_1: "num", depth_ask_1: "num", depth_bid_2: "num", depth_ask_2: "num", spread_bps: "num",
    },
  },
  funding: { assetCol: "coin", cols: { coin: "text", ts: "ts", rate: "num", premium: "num" } },
  candles: { assetCol: "coin", cols: { coin: "text", tf: "text", ts: "ts", o: "num", h: "num", l: "num", c: "num", v: "num" } },
  observations: { assetCol: null, cols: { series_id: "text", ts: "ts", value: "num" } },
} as const satisfies Record<string, { assetCol: string | null; cols: Record<string, ColKind> }>;
export type ScreenerSource = keyof typeof SCREENER_TABLES;
export const ScreenerSourceSchema = z.enum(["snapshots", "funding", "candles", "observations"]);

const ColNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "invalid column");
export const ScreenerOpSchema = z.enum(["=", "!=", ">", ">=", "<", "<="]);
/** String filter values are bound parameters anyway; the charset keeps them to coin/series/tf names. */
const FilterValueSchema = z.union([Num, z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, "invalid filter value")]);

export const ScreenerDslSchema = z
  .object({
    source: ScreenerSourceSchema,
    select: z.array(ColNameSchema).min(1).max(20),
    filters: z.array(z.object({ col: ColNameSchema, op: ScreenerOpSchema, value: FilterValueSchema }).strict()).max(20).default([]),
    /** Percent change of a numeric column over the trailing window, e.g. OI up > 10% in 24 h. */
    changes: z
      .array(z.object({ col: ColNameSchema, window_h: HoursSchema, op: CmpOpSchema, pct: Num }).strict())
      .max(5)
      .default([]),
    assets: z.array(AssetSchema).min(1).max(50).optional(),
    since_h: HoursSchema.default(24),
    orderBy: z.object({ col: ColNameSchema, dir: z.enum(["asc", "desc"]).default("desc") }).strict().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict()
  .superRefine((d, ctx) => {
    const table = SCREENER_TABLES[d.source];
    const kind = (c: string): ColKind | undefined => (table.cols as Record<string, ColKind>)[c];
    const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    d.select.forEach((c, i) => kind(c) || bad(["select", i], `unknown column for ${d.source}: ${c}`));
    d.filters.forEach((f, i) => {
      const k = kind(f.col);
      if (!k) return bad(["filters", i, "col"], `unknown column for ${d.source}: ${f.col}`);
      if (k === "num" && typeof f.value !== "number") bad(["filters", i, "value"], "numeric column needs a number");
      if (k === "text" && (typeof f.value !== "string" || (f.op !== "=" && f.op !== "!="))) bad(["filters", i], "text column takes = or != with a string");
      if (k === "ts") bad(["filters", i, "col"], "filter time with since_h");
    });
    d.changes.forEach((c, i) => kind(c.col) === "num" || bad(["changes", i, "col"], `not a numeric column for ${d.source}: ${c.col}`));
    if (d.assets && !table.assetCol) bad(["assets"], `${d.source} has no asset column; filter series_id instead`);
    if (d.orderBy && !kind(d.orderBy.col)) bad(["orderBy", "col"], `unknown column for ${d.source}: ${d.orderBy.col}`);
  });
export type ScreenerDsl = z.output<typeof ScreenerDslSchema>;
export type ScreenerDslInput = z.input<typeof ScreenerDslSchema>;

const SqlParamSchema = z.union([z.string(), z.number()]);
export const QueryParseRequestSchema = z.object({ question: Text(500) }).strict();
export const QueryParseResponseSchema = z.object({ dsl: ScreenerDslSchema, sql: z.string(), params: z.array(SqlParamSchema), trace: LlmTraceSchema.optional() });
export type QueryParseResponse = z.infer<typeof QueryParseResponseSchema>;
export const QueryRunRequestSchema = z.object({ dsl: ScreenerDslSchema }).strict();
export const QueryResultSchema = z.object({
  sql: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  ms: Num,
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

// ─── Order copilot (I0.18) ───

export const OrderStopSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("price"), px: Pos }).strict(),
  z.object({ type: z.literal("pct"), pct: z.number().finite().gt(0).max(50) }).strict(),
  z.object({ type: z.literal("prev_day_low") }).strict(),
  z.object({ type: z.literal("prev_day_high") }).strict(),
  z.object({ type: z.literal("atr_mult"), mult: z.number().finite().gt(0).max(10) }).strict(),
]);
export type OrderStop = z.infer<typeof OrderStopSchema>;

export const OrderIntentSchema = z
  .object({
    asset: AssetSchema,
    side: SideSchema,
    leverage: z.number().finite().min(1).max(50),
    size: z.union([z.object({ usd: Pos }).strict(), z.object({ pctBook: z.number().finite().gt(0).max(100) }).strict()]),
    entry: z.discriminatedUnion("type", [z.object({ type: z.literal("market") }).strict(), z.object({ type: z.literal("limit"), px: Pos }).strict()]),
    stop: OrderStopSchema,
    target: Pos.optional(),
  })
  .strict();
export type OrderIntent = z.infer<typeof OrderIntentSchema>;

export const OrderPreviewRequestSchema = z.union([
  z.object({ text: Text(500) }).strict(),
  z.object({ intent: OrderIntentSchema }).strict(),
]);
export type OrderPreviewRequest = z.infer<typeof OrderPreviewRequestSchema>;

/**
 * The Desk governor's Verdict (src/server/desk/types.ts) plus the copilot's
 * reading of it: reject when not approved, clip when approved with a
 * "clipped" warning, approve otherwise. Built by toOrderVerdict.
 */
export const OrderVerdictSchema = z.object({
  decision: z.enum(["approve", "clip", "reject"]),
  approved: z.boolean(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  /** The governor's clip warning, when it reduced the order. */
  clip: z.string().optional(),
  sizing: z.record(Num).optional(),
  equityUsd: Num,
  checkedAt: Iso,
});
export type OrderVerdict = z.infer<typeof OrderVerdictSchema>;

/** Maps a governor Verdict (structurally) onto OrderVerdict. Pure. */
export function toOrderVerdict(v: { approved: boolean; reasons: string[]; warnings: string[]; sizing?: object; equityUsd: number; checkedAt: string }): OrderVerdict {
  const clip = v.warnings.find((w) => /\bclipped\b/.test(w));
  return {
    decision: !v.approved ? "reject" : clip ? "clip" : "approve",
    approved: v.approved,
    reasons: v.reasons,
    warnings: v.warnings,
    ...(clip ? { clip } : {}),
    ...(v.sizing ? { sizing: v.sizing as Record<string, number> } : {}),
    equityUsd: v.equityUsd,
    checkedAt: v.checkedAt,
  };
}

export const OrderPreviewSchema = z.object({
  intent: OrderIntentSchema,
  resolved: z.object({
    stopPx: Num,
    entryPx: Num,
    size: Num,
    notionalUsd: Num,
    liqPx: Num.nullable(),
    riskPct: Num,
    riskUsd: Num,
  }),
  verdict: OrderVerdictSchema,
  warnings: z.array(z.string()),
  venue: z.string(),
  /** Binds confirm to this preview's marks and time (409 when stale); DeskService.previewOperatorOrder's hash. */
  previewHash: z.string(),
  /** Venue mark the verdict was sized at (null when the coin is not listed). */
  markPx: Num.nullable(),
  /** Confirm after this is refused (preview TTL). */
  expiresAt: Iso,
  trace: LlmTraceSchema.optional(),
});
export type OrderPreview = z.infer<typeof OrderPreviewSchema>;

export const OrderConfirmRequestSchema = z
  .object({ intent: OrderIntentSchema, previewHash: z.string().regex(/^[A-Za-z0-9_.:-]{8,200}$/, "invalid preview hash") })
  .strict();
export const OrderConfirmResponseSchema = z.object({ proposalId: z.string(), status: z.string(), verdict: OrderVerdictSchema, execution: z.unknown().optional() });
export type OrderConfirmResponse = z.infer<typeof OrderConfirmResponseSchema>;

// ─── Doc/contract watcher (I0.19) ───

export const CHAINS = ["ethereum", "arbitrum", "base", "optimism", "polygon", "bsc", "avalanche", "hyperevm"] as const;
export const ChainSchema = z.enum(CHAINS);
export type Chain = z.infer<typeof ChainSchema>;

const watchCommon = { asset: AssetSchema.optional(), label: Text(80) };
export const WatchInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), target: HttpsUrlSchema, ...watchCommon }).strict(),
  z.object({ kind: z.literal("evm_contract"), target: EvmAddressSchema, chain: ChainSchema, ...watchCommon }).strict(),
  z.object({ kind: z.literal("evm_wallet"), target: EvmAddressSchema, chain: ChainSchema, ...watchCommon }).strict(),
]);
export type WatchInput = z.infer<typeof WatchInputSchema>;

export const WatchKindSchema = z.enum(["url", "evm_contract", "evm_wallet"]);
export const WatchSchema = z.object({
  id: z.string(),
  kind: WatchKindSchema,
  target: z.string(),
  chain: ChainSchema.nullable(),
  asset: z.string().nullable(),
  label: z.string(),
  lastHash: z.string().nullable(),
  lastSnapshot: z.unknown(),
  checkedAt: Iso.nullable(),
  error: z.string().nullable(),
  createdAt: Iso,
});
export type Watch = z.infer<typeof WatchSchema>;

export const WatchChangeSchema = z.object({
  id: z.string(),
  watchId: z.string(),
  ts: Iso,
  fromHash: z.string().nullable(),
  toHash: z.string(),
  /** Line diff (url pages); null for evm watches, whose changes are in facts. */
  diff: z.string().nullable(),
  /** Code-detected changes, one plain line each ("implementation slot 0xab… → 0xcd…", "nonce 41 → 42"). */
  facts: z.array(z.string()),
  detail: z.unknown(),
  /** LLM summary of what changed and why it matters, claim-tagged. */
  lines: z.array(ClaimSchema),
  /** Exposed assets the mapper alerted for this change. */
  alertedAssets: z.array(z.string()),
  trace: LlmTraceSchema.optional(),
});
export type WatchChange = z.infer<typeof WatchChangeSchema>;

export const WatchesResponseSchema = z.object({ watches: z.array(WatchSchema) });
export const WatchChangesResponseSchema = z.object({ changes: z.array(WatchChangeSchema) });
