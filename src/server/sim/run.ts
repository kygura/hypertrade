// Shared simulate pipeline: backfill -> daily candles (incl. l/h) -> simulate -> Monte Carlo.
// Used by POST /branches/:id/run and the semantic-sim adapter (intent.ts).
import * as db from "../db.js";
import type { BranchConfig } from "../../shared/types.js";
import type { SimResult } from "../../shared/intent.js";
import { simulate, type DailyClose } from "./engine.js";
import { runMonteCarlo } from "./montecarlo.js";
import { backfillBranch, STABLES } from "./backfill.js";

export type CandlesByCoin = Record<string, DailyClose[]>;

export interface RunDeps {
  /** `deadline` (ms epoch): no new upstream fetch starts after it. */
  backfill(config: BranchConfig, deadline?: number): Promise<void>;
  loadCandles(config: BranchConfig): Promise<CandlesByCoin>;
  now(): number;
}

export const realDeps: RunDeps = {
  backfill: (config, deadline) => backfillBranch(config, undefined, deadline),
  async loadCandles(config) {
    const coins = new Set([...config.allocations.map((a) => a.coin), ...(config.dca ?? []).map((d) => d.coin), "BTC"]);
    const out: CandlesByCoin = {};
    for (const coin of coins) {
      if (STABLES.has(coin)) continue;
      const rows = await db.getCandles(coin, "1d", config.startDate);
      out[coin] = rows.map((r) => ({ ts: new Date(r.ts).getTime(), c: r.c, l: r.l ?? undefined, h: r.h ?? undefined }));
    }
    return out;
  },
  now: () => Date.now(),
};

/** Pure step: simulate + Monte Carlo (when a scenario is set) on already-loaded candles. May throw NoPriceDataError. */
export function simulateLoaded(config: BranchConfig, candles: CandlesByCoin, now: number): SimResult {
  const result = simulate(config, candles);
  if (!config.scenario) return result;
  return { ...result, montecarlo: runMonteCarlo(config.scenario, config.allocations, result.stats.finalValue, now) };
}

export async function runBranchConfig(config: BranchConfig, deps: RunDeps = realDeps): Promise<SimResult> {
  await deps.backfill(config);
  return simulateLoaded(config, await deps.loadCandles(config), deps.now());
}
