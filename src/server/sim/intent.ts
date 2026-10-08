// Middleware adapter between untrusted LLM intents and the engine (SPEC.md "Paths", decision 4).
// Deterministic, no LLM, no network: all I/O comes in through deps.
import { SimIntentSchema, type SimBranchOutcome, type SimIntent, type SimRunResult } from "../../shared/intent.js";
import type { BranchConfig } from "../../shared/types.js";
import { STABLES } from "./backfill.js";
import { simulateLoaded, type RunDeps } from "./run.js";

export interface IntentDeps extends RunDeps {
  maxLeverage?(coin: string): number | undefined;
}

const PERP_CAVEAT = "perp legs: no funding, no fees, liquidation on daily lows/highs only";
const fmt = (n: number) => String(Math.round(n * 100) / 100);

async function runBranch(
  name: string,
  input: BranchConfig,
  deps: IntentDeps,
): Promise<SimBranchOutcome> {
  const warnings: string[] = [];
  const config: BranchConfig = {
    ...input,
    allocations: input.allocations.map((a) => ({ ...a, coin: a.coin.toUpperCase() })),
    dca: input.dca?.map((d) => ({ ...d, coin: d.coin.toUpperCase() })),
  };
  if (!config.dca) delete config.dca;
  try {
    const sum = config.allocations.reduce((s, a) => s + a.weightPct, 0);
    if (!(sum > 0)) return { name, config, warnings, error: "allocation weights must sum to more than 0" };
    if (Math.abs(sum - 100) > 0.01) {
      const before = config.allocations.map((a) => `${a.coin} ${fmt(a.weightPct)}`).join(", ");
      config.allocations = config.allocations.map((a) => ({ ...a, weightPct: (a.weightPct / sum) * 100 }));
      const after = config.allocations.map((a) => `${a.coin} ${fmt(a.weightPct)}`).join(", ");
      warnings.push(`weights summed to ${fmt(sum)}%, normalized to 100% (${before} -> ${after})`);
    }
    config.allocations = config.allocations.map((a) => {
      const max = deps.maxLeverage?.(a.coin);
      if (max === undefined || (a.leverage ?? 1) <= max) return a;
      warnings.push(`${a.coin} leverage ${a.leverage}x clamped to ${max}x (max on Hyperliquid)`);
      return { ...a, leverage: max };
    });
    if (config.dca && config.rebalance !== "none") {
      warnings.push(`rebalance "${config.rebalance}" forced to "none" because DCA is present`);
      config.rebalance = "none";
    }

    await deps.backfill(config);
    const candles = await deps.loadCandles(config);

    // Listing clamp: the engine extrapolates flat before a coin's first candle, which flatters CAGR.
    const firsts = [...config.allocations.map((a) => a.coin), ...(config.dca ?? []).map((d) => d.coin)]
      .filter((c) => !STABLES.has(c) && candles[c]?.length)
      .map((c) => candles[c]![0]!.ts);
    const listing = Math.max(...firsts, -Infinity);
    if (Date.parse(config.startDate) < listing) {
      const iso = new Date(listing).toISOString().slice(0, 10);
      warnings.push(`startDate ${config.startDate} moved to ${iso}, the first day all coins have price data`);
      config.startDate = iso;
    }

    const perp = config.allocations.some((a) => a.side === "short" || (a.leverage ?? 1) > 1);
    if (perp) {
      warnings.push(PERP_CAVEAT);
      if (config.scenario) {
        delete config.scenario;
        warnings.push("projection skipped — Monte Carlo models unlevered long-only portfolios");
      }
    }
    return { name, config, result: simulateLoaded(config, candles, deps.now()), warnings };
  } catch (err) {
    return { name, config, warnings, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Never throws for a bad branch (that branch gets `error`). An invalid intent returns `{ error }`
 * (zod message) so callers can hand it back to the model. */
export async function runIntent(intent: unknown, deps: IntentDeps): Promise<SimRunResult | { error: string }> {
  const parsed = SimIntentSchema.safeParse(intent);
  if (!parsed.success) {
    return { error: `invalid intent: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  const branches: SimBranchOutcome[] = [];
  for (const b of parsed.data.branches) branches.push(await runBranch(b.name, b.config, deps));
  return { intent: parsed.data as SimIntent, branches };
}
