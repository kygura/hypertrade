// Lab — open-data rule research (SPEC.md "Lab"). Isomorphic: the base-series
// registry, transform vocabulary, rule wire shapes and the rule-to-text
// rendering are shared so the UI, the analyst and the MCP server describe a
// rule in exactly the same words.
import { z } from "zod";

// ─── base series ───

export type LabGroup = "price" | "valuation" | "network" | "mining" | "sentiment" | "liquidity" | "derivatives";

export interface LabBase {
  /** observations.series_id (or a virtual id the dataset loader resolves: px.*, fund.*). */
  id: string;
  label: string;
  group: LabGroup;
  units: string;
  /** Who publishes it. Every source is free; only FRED would need a key, and it is not used here. */
  source: string;
  description: string;
  /**
   * Days between a value's date and the first close it may be traded on.
   * On-chain dailies for day d only exist after d ends, so they are usable at
   * the close of d+1 at the earliest. Getting this wrong is lookahead bias.
   */
  lagDays: number;
  /** Level is meaningful across years (a ratio or index). Trending levels (hash rate, tx count) skip the raw transform. */
  stationary: boolean;
}

export const LAB_BASES: LabBase[] = [
  { id: "px.BTC", label: "BTC price", group: "price", units: "USD", source: "candles", description: "BTC daily close (Hyperliquid, Binance, Bitstamp layers)", lagDays: 0, stationary: false },
  { id: "cm.btc.CapMVRVCur", label: "MVRV", group: "valuation", units: "ratio", source: "coinmetrics", description: "Market value / realized value (Coin Metrics community)", lagDays: 1, stationary: true },
  { id: "cm.btc.AdrActCnt", label: "Active addresses", group: "network", units: "count", source: "coinmetrics", description: "Daily active addresses (Coin Metrics community)", lagDays: 1, stationary: false },
  { id: "cm.btc.TxCnt", label: "Transactions", group: "network", units: "count", source: "coinmetrics", description: "Daily transaction count (Coin Metrics community)", lagDays: 1, stationary: false },
  { id: "cm.btc.FeeTotNtv", label: "Fees", group: "network", units: "BTC", source: "coinmetrics", description: "Total fees paid per day, BTC (Coin Metrics community)", lagDays: 1, stationary: false },
  { id: "bc.estimated-transaction-volume-usd", label: "On-chain volume", group: "network", units: "USD", source: "blockchain.info", description: "Estimated transaction volume, USD (blockchain.com)", lagDays: 1, stationary: false },
  { id: "bc.hash-rate", label: "Hash rate", group: "mining", units: "TH/s", source: "blockchain.info", description: "Network hash rate (blockchain.com)", lagDays: 1, stationary: false },
  { id: "bc.miners-revenue", label: "Miner revenue", group: "mining", units: "USD", source: "blockchain.info", description: "Miner revenue, USD — its 365d ratio is the Puell multiple (blockchain.com)", lagDays: 1, stationary: false },
  { id: "bc.difficulty", label: "Difficulty", group: "mining", units: "", source: "blockchain.info", description: "Mining difficulty (blockchain.com)", lagDays: 1, stationary: false },
  { id: "fng.value", label: "Fear & Greed", group: "sentiment", units: "index", source: "alternative.me", description: "Crypto Fear & Greed index, 0-100 (alternative.me)", lagDays: 0, stationary: true },
  { id: "llama.stablecoin_cap_usd", label: "Stablecoin cap", group: "liquidity", units: "USD", source: "defillama", description: "USD-pegged stablecoin supply (DefiLlama)", lagDays: 1, stationary: false },
  { id: "deribit.btc_dvol", label: "DVOL", group: "derivatives", units: "index", source: "deribit", description: "BTC 30d implied volatility index (Deribit)", lagDays: 0, stationary: true },
  { id: "fund.BTC", label: "HL funding", group: "derivatives", units: "%/yr", source: "hyperliquid", description: "BTC perp funding, daily mean, annualized (Hyperliquid)", lagDays: 0, stationary: true },
];

export const LAB_GROUPS: LabGroup[] = ["price", "valuation", "network", "mining", "sentiment", "liquidity", "derivatives"];

const BASE_BY_ID = new Map(LAB_BASES.map((b) => [b.id, b]));
export const labBase = (id: string): LabBase | undefined => BASE_BY_ID.get(id);

// ─── transforms ───

export type LabTransformKind = "level" | "z" | "pct" | "ratio" | "index";

export interface LabTransform {
  id: string;
  label: string;
  kind: LabTransformKind;
  /** Longest lookback in days; the feature is undefined until it has this much history. */
  window: number;
}

export const LAB_TRANSFORMS: LabTransform[] = [
  { id: "raw", label: "", kind: "level", window: 1 },
  { id: "z90", label: "90d z-score", kind: "z", window: 90 },
  { id: "z365", label: "365d z-score", kind: "z", window: 365 },
  { id: "pct365", label: "365d percentile", kind: "pct", window: 365 },
  { id: "roc7", label: "7d change", kind: "ratio", window: 8 },
  { id: "roc30", label: "30d change", kind: "ratio", window: 31 },
  { id: "roc90", label: "90d change", kind: "ratio", window: 91 },
  { id: "ma30r", label: "vs 30d avg", kind: "ratio", window: 30 },
  { id: "ma200r", label: "vs 200d avg", kind: "ratio", window: 200 },
  { id: "ma365r", label: "vs 365d avg", kind: "ratio", window: 365 },
  { id: "x30_90", label: "30d avg vs 90d avg", kind: "ratio", window: 90 },
  { id: "rsi14", label: "RSI 14", kind: "index", window: 15 },
];

const TRANSFORM_BY_ID = new Map(LAB_TRANSFORMS.map((t) => [t.id, t]));
export const labTransform = (id: string): LabTransform | undefined => TRANSFORM_BY_ID.get(id);

/** Feature ids are `<base>|<transform>`, e.g. `cm.btc.CapMVRVCur|z365`. */
export const featureId = (base: string, transform: string) => `${base}|${transform}`;

export function parseFeatureId(id: string): { base: LabBase; transform: LabTransform } | null {
  const i = id.lastIndexOf("|");
  if (i < 0) return null;
  const base = labBase(id.slice(0, i));
  const transform = labTransform(id.slice(i + 1));
  return base && transform ? { base, transform } : null;
}

/** Transforms a base gets: trending levels skip `raw` (a 2016 threshold on hash rate means nothing in 2025). */
export function transformsFor(base: LabBase): LabTransform[] {
  return LAB_TRANSFORMS.filter((t) => t.id !== "raw" || base.stationary);
}

// ─── rules ───

export const LabDirectionSchema = z.enum(["long", "short"]);
export type LabDirection = z.infer<typeof LabDirectionSchema>;

const FeatureIdSchema = z
  .string()
  .max(120)
  .refine((s) => parseFeatureId(s) !== null, { message: "unknown feature (expected <base>|<transform> from /lab/features)" });

export const LabConditionSchema = z
  .object({
    feature: FeatureIdSchema,
    op: z.enum(["<", ">"]),
    /** Absolute threshold in the feature's own units (ratios as fractions, percentiles 0-100). */
    threshold: z.number().finite().optional(),
    /** Or a quantile level of the training window; resolved to a threshold at evaluation. */
    q: z.number().gt(0).lt(1).optional(),
  })
  .strict()
  .refine((c) => c.threshold !== undefined || c.q !== undefined, { message: "condition needs threshold or q" });
export type LabCondition = z.infer<typeof LabConditionSchema>;

export const LabRuleSchema = z
  .object({
    direction: LabDirectionSchema,
    conditions: z.array(LabConditionSchema).min(1).max(3),
  })
  .strict();
export type LabRule = z.infer<typeof LabRuleSchema>;

export const LabSearchRequestSchema = z
  .object({
    direction: LabDirectionSchema.default("long"),
    /** Base ids to search; default all available. */
    bases: z.array(z.string().max(80)).max(LAB_BASES.length).optional(),
    /** Transform ids to apply; default all. */
    transforms: z.array(z.string().max(20)).max(LAB_TRANSFORMS.length).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    costBps: z.number().min(0).max(100).default(10),
    /** Beam width for two-condition rules: quick 12, standard 30, deep 60. */
    effort: z.enum(["quick", "standard", "deep"]).default("standard"),
    maxResults: z.number().int().min(1).max(25).default(10),
  })
  .strict();
export type LabSearchRequest = z.input<typeof LabSearchRequestSchema>;
export type LabSearchOptions = z.output<typeof LabSearchRequestSchema>;

// ─── reports ───

export interface LabStats {
  from: string;
  to: string;
  days: number;
  totalReturnPct: number;
  cagrPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  /** Share of days in the market, 0-1. */
  exposure: number;
  trades: number;
  /** Share of trades (contiguous in-market runs) that closed positive, 0-1; null with no trades. */
  winRate: number | null;
  /** Buy-and-hold (long) or short-and-hold over the same window. */
  benchmark: { totalReturnPct: number; sharpe: number; maxDrawdownPct: number };
}

export interface LabRuleReport {
  rule: LabRule & { conditions: (LabCondition & { threshold: number })[] };
  text: string;
  inSample: LabStats;
  /** Out-of-fold stats from expanding-window walk-forward (thresholds refit per fold); null for fixed-threshold rules. */
  walkForward: LabStats | null;
  /** Holdout: the most recent share of history, never seen by the search. */
  outOfSample: LabStats | null;
  /** Probability the walk-forward Sharpe beats the best of N noise trials (Bailey & López de Prado). */
  deflatedSharpe: number | null;
  /** Walk-forward Sharpe at neighbouring quantile levels, min / own (1 = flat plateau, < 0 = sign flips). */
  stability: number | null;
  firingNow: boolean;
  /** Date of the last value the firing state was computed on. */
  asOf: string;
  equity: { ts: string; strategy: number; benchmark: number }[];
}

export interface LabSearchResult {
  request: LabSearchOptions;
  generatedAt: string;
  range: { from: string; to: string; trainEnd: string };
  bases: string[];
  features: number;
  /** Rule variants scored during the search (the N in the deflated Sharpe). */
  trials: number;
  elapsedMs: number;
  results: LabRuleReport[];
  warnings: string[];
}

export interface LabCatalogueEntry {
  id: string;
  createdAt: string;
  note: string | null;
  source: string;
  report: LabRuleReport;
  /** Re-evaluated on today's data: everything after createdAt is unseen by the search. */
  live: { firingNow: boolean; asOf: string; sinceSaved: LabStats | null; full: LabStats } | null;
  error?: string;
}

export interface LabPulse {
  long: { active: number; total: number };
  short: { active: number; total: number };
  /** (active long - active short) / total rules, -1..1. */
  lean: number;
}

// ─── text ───

/** Threshold in display units: ratios as %, percentiles as-is, z to 2dp. */
export function fmtThreshold(feature: string, v: number): string {
  const p = parseFeatureId(feature);
  if (!p) return String(v);
  switch (p.transform.kind) {
    case "ratio":
      return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
    case "z":
      return v.toFixed(2);
    case "pct":
    case "index":
      return v.toFixed(0);
    case "level": {
      const a = Math.abs(v);
      if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
      if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
      if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
      return a >= 10 ? v.toFixed(1) : v.toFixed(3);
    }
  }
}

export function featureLabel(feature: string): string {
  const p = parseFeatureId(feature);
  if (!p) return feature;
  return p.transform.label ? `${p.base.label} ${p.transform.label}` : p.base.label;
}

export function describeCondition(c: LabCondition): string {
  const thr = c.threshold !== undefined ? fmtThreshold(c.feature, c.threshold) : `q${Math.round((c.q ?? 0) * 100)}`;
  return `${featureLabel(c.feature)} ${c.op} ${thr}`;
}

export function describeRule(r: LabRule): string {
  return `${r.direction.toUpperCase()} when ${r.conditions.map(describeCondition).join(" AND ")}`;
}
