import { z } from "zod";
import { AgentRecordSchema, MoveWindowSchema } from "./agentRecords.js";
import { AssetSchema, NARRATIVE_STAGES } from "./intel.js";
import { ClusterSchema } from "./platform.js";

// Moves contract (docs/SPEC.md § Moves): a coin's move over a window split into beta (BTC, ETH ex-BTC, sector
// ex-majors) and a residual, with the positioning, liquidation and attention facts beside it. Attribution is
// explained after the fact; the checklists are condition checks, not forecasts. Every percentage is a log-%
// (100 · Σ ln returns) unless a field says otherwise, because only log returns add up across factors and hours.
// What a person reads is converted with `simplePct`. Server and UI both import this file.

/**
 * A log-% as the ordinary percent change it stands for: a −69.6 log-% move is a −50.1% price change. The parts of
 * a move converted this way compound to the total ((1+a)(1+b)… − 1); they do not add.
 */
export const simplePct = (logPct: number): number => Math.expm1(logPct / 100) * 100;

export { MOVE_WINDOWS, MoveWindowSchema, WINDOW_HOURS } from "./agentRecords.js";
export type { MoveWindow } from "./agentRecords.js";

const Iso = z.string().datetime({ offset: true });
const Num = z.number().finite();
const Count = z.number().int().nonnegative();

const LayerStateSchema = z.object({
  state: z.enum(["ok", "partial", "unavailable"]),
  reason: z.string().nullable(),
});
export type LayerState = z.infer<typeof LayerStateSchema>;

/** `BTC`, `ETH`, `ETHX` (ETH ex-BTC) or `sector:<id>` (equal-weight basket ex-majors). */
const FactorMoveSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pct: Num,
  /** Coins in the factor (1 for BTC and ETH). */
  n: Count,
});
export type FactorMove = z.infer<typeof FactorMoveSchema>;

const BetaFitSchema = z.object({
  factor: z.enum(["BTC", "ETH", "SECTOR"]),
  beta: Num.nullable(),
  contributionPct: Num.nullable(),
  /** Bars in the estimation window the fit used. */
  n: Count,
  /** Why the factor was not fitted; null when it was. */
  reason: z.string().nullable(),
});
export type BetaFit = z.infer<typeof BetaFitSchema>;

export const AttributionSchema = z.object({
  window: MoveWindowSchema,
  from: Iso,
  to: Iso,
  /** Bars of the window that had a return. */
  hours: Count,
  /** btcPct + ethPct + (sectorPct ?? 0) + residualPct === totalPct. */
  totalPct: Num,
  btcPct: Num,
  ethPct: Num,
  sectorPct: Num.nullable(),
  residualPct: Num,
  /** The residual summed over OI-drop hours, news hours and the rest; a null bucket's hours fall into `other`. */
  residualFlowPct: Num.nullable(),
  residualNewsPct: Num.nullable(),
  residualOtherPct: Num,
  flowHours: Count.nullable(),
  newsHours: Count.nullable(),
  /** Σ residual over the window / (σ1h · √hours); null without a σ. */
  residualZ: Num.nullable(),
  /** Robust σ of the hourly residual on the estimation window, in %. */
  sigma1hPct: Num.nullable(),
  r2: Num.nullable(),
  estimation: z.object({ from: Iso, to: Iso, n: Count }),
  betas: z.array(BetaFitSchema),
});
export type Attribution = z.infer<typeof AttributionSchema>;

const CROWDING_KEYS = ["funding_z", "funding_apr", "oi_build", "premium"] as const;
const CrowdingCheckSchema = z.object({
  key: z.enum(CROWDING_KEYS),
  side: z.enum(["long", "short"]),
  value: Num.nullable(),
  threshold: Num,
  /** Null when the check cannot be evaluated (missing history). */
  met: z.boolean().nullable(),
});
export type CrowdingCheck = z.infer<typeof CrowdingCheckSchema>;

export const PositioningSchema = z.object({
  fundingHourly: Num,
  fundingAprPct: Num,
  fundingZ: Num.nullable(),
  fundingN: Count,
  premiumBps: Num.nullable(),
  oiUsd: Num,
  oiChg24hPct: Num.nullable(),
  oiChg72hPct: Num.nullable(),
  oiN: Count,
  oiToVolume: Num.nullable(),
  checks: z.array(CrowdingCheckSchema),
  /** Checks met per side, and how many could be evaluated per side. */
  longMet: Count,
  shortMet: Count,
  of: Count,
});
export type Positioning = z.infer<typeof PositioningSchema>;

export const LiqProximitySchema = z.object({
  state: LayerStateSchema,
  nearestLong: ClusterSchema.nullable(),
  nearestShort: ClusterSchema.nullable(),
  /** Robust σ of hourly returns · √24, in %. */
  sigma24hPct: Num.nullable(),
  /** Distance to the nearest cluster in 24h sigmas. */
  longSigmas: Num.nullable(),
  shortSigmas: Num.nullable(),
  coverageRatio: Num.nullable(),
});
export type LiqProximity = z.infer<typeof LiqProximitySchema>;

export const AttentionSchema = z.object({
  state: LayerStateSchema,
  news24h: Count.nullable(),
  news72h: Count.nullable(),
  newsDailyMean7d: Num.nullable(),
  /** news24h / max(0.5, daily mean of the prior 7 days). */
  newsRatio: Num.nullable(),
  mentions24h: Num.nullable(),
  mentionsChg24hPct: Num.nullable(),
  mentionsAsOf: Iso.nullable(),
  sectorId: z.string().nullable(),
  sectorStage: z.enum(NARRATIVE_STAGES).nullable(),
});
export type Attention = z.infer<typeof AttentionSchema>;

const SetupCheckSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  value: z.union([Num, z.string()]).nullable(),
  threshold: z.string(),
  met: z.boolean().nullable(),
});
export type SetupCheck = z.infer<typeof SetupCheckSchema>;

/** A condition check, not a forecast. `of` counts evaluable checks only. */
export const SetupChecklistSchema = z.object({
  kind: z.enum(["enter", "fade"]),
  side: z.enum(["long", "short"]).nullable(),
  checks: z.array(SetupCheckSchema),
  met: Count,
  of: Count,
  /** The shipped signal definition that tests this checklist's daily version, if any. */
  definitionId: z.string().nullable(),
});
export type SetupChecklist = z.infer<typeof SetupChecklistSchema>;

export const MoveRowSchema = z.object({
  coin: AssetSchema,
  sector: z.object({ id: z.string().min(1), label: z.string().min(1) }).nullable(),
  mark: Num,
  dayNtlVlm: Num,
  attribution: AttributionSchema.nullable(),
  /** Why `attribution` is null, e.g. `needs 120 of 168 hourly bars before the window — has 74`. */
  attributionReason: z.string().nullable(),
  positioning: PositioningSchema,
  liq: LiqProximitySchema,
  attention: AttentionSchema,
  setups: z.array(SetupChecklistSchema),
  /** A pre-decision platform opportunity for the coin, if one exists. */
  opportunityId: z.string().nullable(),
});
export type MoveRow = z.infer<typeof MoveRowSchema>;

export const MovesResponseSchema = z.object({
  /** `pending`: the first run is still loading candles (see `progress`). */
  state: z.enum(["ok", "pending", "unavailable"]),
  reason: z.string().nullable(),
  /** Close of the last closed 1h bar the numbers are computed to. */
  asOf: Iso.nullable(),
  computedAt: Iso,
  window: MoveWindowSchema,
  progress: z.object({ loaded: Count, total: Count }).nullable(),
  universe: z.object({ coins: Count, dropped: z.array(z.object({ coin: z.string(), reason: z.string() })) }),
  sectorsAsOf: Iso.nullable(),
  factors: z.array(FactorMoveSchema),
  layers: z.object({
    beta: LayerStateSchema,
    flow: LayerStateSchema,
    attention: LayerStateSchema,
    liq: LayerStateSchema,
    agents: LayerStateSchema,
  }),
  rows: z.array(MoveRowSchema),
});
export type MovesResponse = z.infer<typeof MovesResponseSchema>;

const MoveSeriesPointSchema = z.object({
  /** Bar open, epoch ms. */
  t: z.number().int(),
  cumTotalPct: Num,
  cumFittedPct: Num,
  cumResidualPct: Num,
  flowHour: z.boolean(),
  newsHour: z.boolean(),
});
export type MoveSeriesPoint = z.infer<typeof MoveSeriesPointSchema>;

const MoveHeadlineSchema = z.object({
  title: z.string(),
  firstSeen: Iso,
  url: z.string().nullable(),
  assets: z.array(z.string()),
});

export const MoveDetailSchema = MoveRowSchema.extend({
  state: z.enum(["ok", "unavailable"]),
  reason: z.string().nullable(),
  asOf: Iso.nullable(),
  window: MoveWindowSchema,
  layers: MovesResponseSchema.shape.layers,
  series: z.array(MoveSeriesPointSchema),
  /** Empty for guests. */
  headlines: z.array(MoveHeadlineSchema),
  /** The latest agent record for the coin; null for guests or when none exists. */
  record: AgentRecordSchema.nullable(),
});
export type MoveDetail = z.infer<typeof MoveDetailSchema>;
