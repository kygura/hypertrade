// Trust-boundary schema for LLM-authored simulation intents (SPEC.md "Paths", decision 3).
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

export interface SimResult {
  equity: Pt[];
  benchmarks: { btc: Pt[]; usdc: Pt[] };
  stats: { finalValue: number; cagrPct: number; maxDrawdownPct: number; vsBtcPct: number; vsUsdcPct: number };
  montecarlo?: { median: Pt[]; p10: Pt[]; p90: Pt[] };
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
