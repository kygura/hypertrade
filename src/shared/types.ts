import type { z } from "zod";
import type {
  AllocationSchema,
  ScenarioSchema,
  BranchConfigSchema,
  MarketStateDomainSchema,
  MarketStateThesisSchema,
  MarketStateDataSchema,
  SectorSchema,
  RotationSchema,
  SectorsDataSchema,
  HlPerpMetaSchema,
} from "./schemas.js";

export type Allocation = z.infer<typeof AllocationSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type BranchConfig = z.infer<typeof BranchConfigSchema>;

export type MarketStateDomain = z.infer<typeof MarketStateDomainSchema>;
export type MarketStateThesis = z.infer<typeof MarketStateThesisSchema>;
export type MarketStateData = z.infer<typeof MarketStateDataSchema>;

export type Sector = z.infer<typeof SectorSchema>;
export type Rotation = z.infer<typeof RotationSchema>;
export type SectorsData = z.infer<typeof SectorsDataSchema>;

export type HlRawPerpMeta = z.infer<typeof HlPerpMetaSchema>;

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
  /** Optional so hand-built test contexts stay small; fetchPerpMetaAndCtxs always sets them. */
  maxLeverage?: number;
  dayBaseVlm?: number;
  /** Impact bid/ask: the prices a standard-size market order would fill at. */
  impactBidPx?: number | null;
  impactAskPx?: number | null;
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

