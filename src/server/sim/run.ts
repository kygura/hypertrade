// Shared simulate pipeline: backfill -> daily candles (incl. l/h) -> simulate -> Monte Carlo.
// Used by POST /branches/:id/run and the semantic-sim adapter (intent.ts).
import * as db from "../db.js";
import type { BranchConfig } from "../../shared/types.js";
import type { SimResult } from "../../shared/intent.js";
import { simulateFull, type DailyClose } from "./engine.js";
import { MIN_BOOTSTRAP_DAYS, runMonteCarlo } from "./montecarlo.js";
import { backfillBranch } from "./backfill.js";
import { branchCoins, STABLES } from "../../shared/schemas.js";

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
    const coins = [...new Set([...branchCoins(config), "BTC"])].filter((c) => !STABLES.has(c));
    const rows = await Promise.all(coins.map((coin) => db.getCandles(coin, "1d", config.startDate)));
    return Object.fromEntries(coins.map((coin, i) => [coin, rows[i]!.map((r) => ({ ts: new Date(r.ts).getTime(), c: r.c, l: r.l ?? undefined, h: r.h ?? undefined }))]));
  },
  now: () => Date.now(),
};

/** What the branch holds at the end of the replay: the last scheduled move's allocations, else the starting ones. */
export function finalAllocations(config: BranchConfig): BranchConfig["allocations"] {
  const last = [...(config.schedule ?? [])].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).at(-1);
  return last?.allocations ?? config.allocations;
}

/** Pure step: simulate + Monte Carlo (when a scenario is set) on already-loaded candles. May throw NoPriceDataError. */
export function simulateLoaded(config: BranchConfig, candles: CandlesByCoin, now: number): SimResult {
  const { result, dailyReturns } = simulateFull(config, candles);
  const scenario = config.scenario;
  if (!scenario) return result;
  if (scenario.method === "bootstrap" && dailyReturns.length < MIN_BOOTSTRAP_DAYS) {
    return { ...result, notes: [`projection skipped: resampling history needs at least ${MIN_BOOTSTRAP_DAYS} days, the branch has ${dailyReturns.length}`] };
  }
  const montecarlo = runMonteCarlo(scenario, finalAllocations(config), result.stats.finalValue, now, 1, { history: dailyReturns, cashflow: config.cashflow });
  return { ...result, montecarlo };
}

export async function runBranchConfig(config: BranchConfig, deps: RunDeps = realDeps): Promise<SimResult> {
  await deps.backfill(config);
  return simulateLoaded(config, await deps.loadCandles(config), deps.now());
}
