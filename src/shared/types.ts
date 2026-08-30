import type { z } from "zod";
import type {
  AllocationSchema,
  ScenarioAssumptionSchema,
  ScenarioSchema,
  BranchConfigSchema,
  MarketStateSignalSchema,
  MarketStateDomainSchema,
  MarketStateThesisSchema,
  MarketStateDataSchema,
  SectorSchema,
  RotationSchema,
  SectorsDataSchema,
  MetricSummarySchema,
  HlPerpMetaSchema,
  HlAssetCtxSchema,
  HlCandleSchema,
} from "./schemas";

export type Allocation = z.infer<typeof AllocationSchema>;
export type ScenarioAssumption = z.infer<typeof ScenarioAssumptionSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type BranchConfig = z.infer<typeof BranchConfigSchema>;

export type MarketStateSignal = z.infer<typeof MarketStateSignalSchema>;
export type MarketStateDomain = z.infer<typeof MarketStateDomainSchema>;
export type MarketStateThesis = z.infer<typeof MarketStateThesisSchema>;
export type MarketStateData = z.infer<typeof MarketStateDataSchema>;

export type Sector = z.infer<typeof SectorSchema>;
export type Rotation = z.infer<typeof RotationSchema>;
export type SectorsData = z.infer<typeof SectorsDataSchema>;

export type MetricSummary = z.infer<typeof MetricSummarySchema>;

export type HlRawPerpMeta = z.infer<typeof HlPerpMetaSchema>;
export type HlRawAssetCtx = z.infer<typeof HlAssetCtxSchema>;
export type HlRawCandle = z.infer<typeof HlCandleSchema>;

/** {ts, value} pair used throughout stats.ts / baseline math. */
export interface Observation {
  ts: number;
  value: number;
}

/** Computed (numeric, post-parse) per-asset Hyperliquid context. */
export interface AssetCtx {
  name: string;
  szDecimals: number;
  markPx: number;
  oraclePx: number;
  midPx: number;
  dayNtlVlm: number;
  prevDayPx: number;
  openInterest: number;
  funding: number;
  premium: number;
  dayChange: number; // fraction
  isDelisted: boolean;
}

/** Computed (numeric, post-parse) OHLCV candle. */
export interface Candle {
  t: number; // open ms
  T: number; // close ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type AllMids = Record<string, string>;
