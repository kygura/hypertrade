import { z } from "zod";

// LAB.md contract. Shared by the engine (pure), providers (I/O), the service,
// the tool registry and the UI (via the tool results). Keep wire shapes here.

export const DAY_MS = 86_400_000;

/** UTC-daily series: t[i] is a UTC midnight in ms, ascending, unique; v[i] finite. */
export interface DailySeries {
  t: number[];
  v: number[];
}

/** YYYY-MM-DD naming a real calendar day (2025-02-30 is refused). */
export const DaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const ms = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
  }, "not a calendar date");

/** A ticker (BTC, kPEPE): letters and digits only, so it is safe in any provider URL. */
export const ASSET_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const AssetSchema = z.string().regex(ASSET_PATTERN, "expected a ticker of 1–20 letters or digits, e.g. BTC");

export type Direction = "long" | "short";
export type Objective = "sharpe" | "return";
export const TRANSFORMS = ["raw", "z", "rsi", "ma_ratio", "roc", "vol", "pctile"] as const;
export type Transform = (typeof TRANSFORMS)[number];

export type MetricCategory =
  | "price"
  | "derivatives"
  | "onchain"
  | "sentiment"
  | "macro"
  | "liquidity"
  | "social";

export interface MetricDef {
  /** `<provider>:<key>`, e.g. `cm:CapMVRVCur`, `ht:funding`. */
  id: string;
  provider: string;
  key: string;
  name: string;
  category: MetricCategory;
  /** `asset` metrics need an asset; `global` ones ignore it. */
  scope: "asset" | "global";
  /** Assets the metric exists for (lower/upper case as the provider uses); omitted = any. */
  assets?: string[];
  units?: string;
  description: string;
  /** Publication lag in days; the engine shifts the series forward by this. */
  lagDays: number;
  /**
   * False for level series that trend or random-walk (price, market cap,
   * supply): their `raw` value is not comparable across years, so the search
   * skips the `raw` transform for them. Default true.
   */
  stationary?: boolean;
}

export interface FetchOptions {
  /** The caller runs under a wall-clock deadline: keep optional work (ht's backfill) short. */
  deadline?: boolean;
}

export interface LabProvider {
  id: string;
  name: string;
  /** Free text: source, key requirements, history depth. */
  notes: string;
  metrics(): MetricDef[];
  /** Daily series for [fromMs, toMs]; empty series when there is no data. Throws on transport errors. */
  fetch(key: string, asset: string, fromMs: number, toMs: number, opts?: FetchOptions): Promise<DailySeries>;
}

// ------------------------------------------------------------------ rules

/** Feature id: `${metricId}|${transform}|${window}` (window 0 for raw). */
export interface FeatureSpec {
  metric: string;
  transform: Transform;
  window: number;
}

export const ConditionSchema = z.object({
  feature: z.string().min(3),
  op: z.enum(["<", ">="]),
  threshold: z.number().finite(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const RuleSchema = z.object({
  asset: AssetSchema,
  direction: z.enum(["long", "short"]),
  horizonDays: z.number().int().min(1).max(180),
  conditions: z.array(ConditionSchema).min(1).max(2),
  /** Price metric the rule trades; defaults to `ht:price`. */
  price: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export interface PerfStats {
  from: string; // YYYY-MM-DD
  to: string;
  days: number;
  totalReturn: number; // fraction
  cagr: number; // fraction
  sharpe: number;
  maxDrawdown: number; // fraction, ≤ 0
  hitRate: number | null; // closed trades with net return > 0; null when no trades
  trades: number;
  tradesPerYear: number;
  exposure: number; // share of days in market
  /** True when the window holds no trade: its Sharpe 0 is "not tested", not "no edge". */
  untested?: boolean;
}

export interface SensitivityPoint {
  condition: number; // index into rule.conditions
  kind: "threshold" | "window";
  /** quantile shift (±0.05, ±0.10) or the swapped window. */
  shift: number;
  rule: Rule;
  sharpe: number;
  totalReturn: number;
}

export interface Sensitivity {
  base: { sharpe: number; totalReturn: number };
  stability: number; // 0..1
  points: SensitivityPoint[];
}

/** Save-bar verdict levels, best first (LAB.md §7 "Verdict"). */
export const VERDICT_LEVELS = ["robust", "candidate", "fragile", "weak", "fails_holdout"] as const;
export type VerdictLevel = (typeof VERDICT_LEVELS)[number];

export interface Verdict {
  level: VerdictLevel;
  /** Failed checks with their numbers, e.g. "deflated Sharpe 0.71 < 0.9"; [] for a clean robust. */
  reasons: string[];
}

export interface RuleEvaluation {
  id: string; // stable hash of the rule
  rule: Rule;
  /** Human-readable, e.g. "cm:CapMVRVCur z(90) < -1.12 AND ht:funding raw ≥ 0.0003". */
  text: string;
  precision: number;
  support: number;
  inSample: PerfStats;
  walkForward: PerfStats | null;
  /** Sharpe of each walk-forward test block, oldest first (reported, never ranked on); [] without walk-forward. Absent on evaluations stored before it existed. */
  walkForwardFolds?: number[];
  /**
   * Deflated Sharpe (Bailey & López de Prado) of the concatenated walk-forward
   * returns: probability the true Sharpe beats the best of N noise variants,
   * N = the search's effectiveTrials (1 for an explicit rule unless `trials`
   * is given). Null without walk-forward; absent on evaluations stored before
   * it existed.
   */
  deflatedSharpe?: number | null;
  holdout: PerfStats | null;
  benchmark: { inSample: PerfStats; holdout: PerfStats | null };
  sensitivity?: Sensitivity;
  firingNow: boolean;
  /** Latest feature values used by the conditions, with their date. */
  latest: { date: string; values: Record<string, number | null> };
  equity?: Array<{ t: number; strategy: number; benchmark: number }>;
  /** Save-bar verdict; absent on evaluations stored before it existed (the service recomputes it on read). */
  verdict?: { level: VerdictLevel; reasons: string[] };
}

// ------------------------------------------------------------------ search

export const SearchConfigSchema = z.object({
  asset: AssetSchema,
  direction: z.enum(["long", "short"]).default("long"),
  metrics: z.array(z.string().min(3)).min(1).max(40),
  transforms: z.array(z.enum(TRANSFORMS)).min(1).default(["raw", "z", "rsi", "ma_ratio", "roc", "vol", "pctile"]),
  windows: z.array(z.number().int().min(2).max(365)).min(1).max(6).default([7, 30, 90]),
  horizonDays: z.number().int().min(1).max(180).default(14),
  labelQuantile: z.number().min(0.05).max(0.5).default(0.3),
  customZones: z
    .array(z.object({ from: DaySchema, to: DaySchema }))
    .max(50)
    .optional(),
  objective: z.enum(["sharpe", "return"]).default("sharpe"),
  trials: z.number().int().min(1).max(200).default(40),
  folds: z.number().int().min(2).max(6).default(3),
  minSupport: z.number().int().min(5).default(30),
  slippageBps: z.number().min(0).max(200).default(10),
  topK: z.number().int().min(1).max(50).default(10),
  from: DaySchema.optional(),
  to: DaySchema.optional(),
  price: z.string().optional(),
  seed: z.number().int().default(42),
  /** Candidate rules must be in the market on this share of search-region days or more… */
  minExposure: z.number().min(0).max(1).default(0.05),
  /** …and at most this share (always-in is the benchmark, not a rule). */
  maxExposure: z.number().min(0).max(1).default(0.95),
  /** …and enter at least this many trades per year of search region (and at least 3 in total). */
  minTradesPerYear: z.number().min(0).max(365).default(0.5),
  /** Drop final rules whose deflated Sharpe is below this (0–1). Default: no filter. */
  minDeflatedSharpe: z.number().min(0).max(1).optional(),
  /**
   * Drop returned rules whose verdict is below this level. Applied after
   * selection to the top K only (it never reaches deeper candidates, so the
   * holdout still picks nothing). Default: no filter.
   */
  minVerdict: z.enum(VERDICT_LEVELS).optional(),
});
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type SearchConfigInput = z.input<typeof SearchConfigSchema>;

/** Aligned engine input: every series on the price calendar, NaN where missing. */
export interface LabDataset {
  asset: string;
  t: number[]; // daily UTC ms, ascending
  price: number[];
  /** metricId → values aligned to t (already lag-shifted), NaN = missing. */
  metrics: Record<string, number[]>;
  /** metricId → MetricDef.stationary; a metric mapped to false gets no `raw` feature in a search. Omitted = stationary. */
  stationary?: Record<string, boolean>;
}

export interface TrialRecord {
  trial: number;
  params: { featureFrac: number; minLeaf: number; bootstrapFrac: number; trees: number };
  score: number; // walk-forward objective
  rules: number;
}

export interface SearchResult {
  config: SearchConfig;
  dataRange: { from: string; to: string; days: number; holdoutFrom: string };
  featureCount: number;
  trialsRun: number;
  /** Distinct rule variants scored across all trials and the final refit (raw N). */
  variantsScored?: number;
  /**
   * Correlation-adjusted number of independent trials, the N the deflated
   * Sharpe uses: participation ratio of the variants' search-region return
   * correlations (LAB.md §7), ≤ variantsScored. Absent on runs stored before it existed.
   */
  effectiveTrials?: number;
  bestTrial: TrialRecord | null;
  trials: TrialRecord[];
  rules: RuleEvaluation[];
  featureImportance: Array<{ feature: string; score: number }>;
  warnings: string[];
  durationMs: number;
}

// ------------------------------------------------------------------ catalogue

export interface CatalogueEntry {
  id: string; // rule id
  name: string;
  note: string | null;
  origin: "user" | "agent" | "seed";
  runId: string | null;
  rule: Rule;
  /** Evaluation at save time. */
  saved: RuleEvaluation;
  savedAt: string; // ISO
}

export interface CatalogueHealth {
  decayed: Array<{ id: string; name: string; liveDays: number; liveSharpe: number; holdoutSharpe: number | null }>;
  overlaps: Array<{ a: string; b: string; jaccard: number }>;
  gaps: Array<{ asset: string; direction: Direction }>;
  live: Record<string, PerfStats | null>;
}

export interface PulseAsset {
  asset: string;
  longActive: number;
  longTotal: number;
  shortActive: number;
  shortTotal: number;
  lean: number; // -1..1
  rules: Array<{ id: string; name: string; direction: Direction; firing: boolean; text: string }>;
}

export interface MarketPulse {
  asOf: string;
  assets: PulseAsset[];
  warnings: string[];
}
