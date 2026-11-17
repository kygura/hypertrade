// Trust-boundary schema for LLM-authored simulation intents (docs/SPEC.md "Paths", decision 3).
// Zod is the authority; any hand-written JSON schema given to the model is only a hint.
import { z } from "zod";
import { BranchConfigSchema } from "./schemas.js";
import type { BranchConfig } from "./types.js";

export const SimIntentSchema = z
  .object({
    title: z.string().min(1).max(120),
    assumptions: z.array(z.string().max(300)).max(12),
    branches: z
      .array(z.object({ name: z.string().min(1).max(80), config: BranchConfigSchema.strict() }).strict())
      .min(1)
      .max(4),
  })
  .strict();

export type SimIntent = z.infer<typeof SimIntentSchema>;

// Plain mirrors of server/sim/engine.ts + montecarlo.ts result shapes, so the UI can import
// them without pulling server code (structurally compatible with the engine's types).
interface Pt {
  ts: number;
  value: number;
}

// Fields added after the first release are optional: cached results written before them still load.
export interface SimStats {
  finalValue: number;
  cagrPct: number;
  maxDrawdownPct: number;
  vsBtcPct: number;
  vsUsdcPct: number;
  twrPct?: number;
  volPct?: number;
  sharpe?: number;
  sortino?: number;
  calmar?: number;
  longestDrawdownDays?: number;
  feesUsd?: number;
  fundingUsd?: number;
  netFlowUsd?: number;
}

export interface SimRolling {
  windowDays: number;
  stepDays: number;
  points: { ts: number; returnPct: number; vsBtcPct: number; maxDrawdownPct: number }[];
  summary: { n: number; positivePct: number; beatBtcPct: number; p10: number; median: number; p90: number; worst: number; best: number };
}

export interface SimProjectionSummary {
  method: "gbm" | "bootstrap";
  investedUsd: number;
  finalP10: number;
  finalMedian: number;
  finalP90: number;
  lossPct: number;
  targetPct?: number;
  depletedPct?: number;
}

export interface SimResult {
  equity: Pt[];
  benchmarks: { btc: Pt[]; usdc: Pt[] };
  stats: SimStats;
  twr?: Pt[];
  monthly?: { month: string; returnPct: number }[];
  rolling?: SimRolling;
  montecarlo?: { median: Pt[]; p10: Pt[]; p90: Pt[]; p25?: Pt[]; p75?: Pt[]; summary?: SimProjectionSummary };
  notes?: string[];
  /** Scheduled moves as filled: index into config.schedule, the day, the value right after. */
  moves?: { step: number; date: string; valueUsd: number }[];
}

export interface SimBranchOutcome {
  name: string;
  config: BranchConfig;
  result?: SimResult;
  warnings: string[];
  error?: string;
}

export interface SimRunResult {
  intent: SimIntent;
  branches: SimBranchOutcome[];
}
