// Middleware adapter between untrusted LLM intents and the engine (docs/SPEC.md "Paths", decision 4).
// Deterministic, no LLM, no network: all I/O comes in through deps.
import { SimIntentSchema, type SimBranchOutcome, type SimIntent, type SimRunResult } from "../../shared/intent.js";
import type { Allocation, BranchConfig } from "../../shared/types.js";
import { branchCoins, isPerp, STABLES } from "../../shared/schemas.js";
import { finalAllocations, simulateLoaded, type RunDeps } from "./run.js";
import { NoPriceDataError } from "./engine.js";
import { UpstreamError } from "../mcp/types.js";

export interface IntentDeps extends RunDeps {
  maxLeverage?(coin: string): number | undefined;
  /** Canonical Hyperliquid name for a coin (case-insensitive), undefined when HL does not list it.
   * Absent when the universe is unavailable: coins are then just uppercased. */
  resolveCoin?(coin: string): string | undefined;
}

const PERP_CAVEAT = "perp legs: liquidation on daily lows/highs only, at 100% margin loss";
const COST_CAVEAT = "no fees, no funding charged (set costs to include them)";
const fmt = (n: number) => String(Math.round(n * 100) / 100);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

class BranchError extends Error {}

/** Duplicate check, weight normalization and leverage clamp for one set of allocations (the start or a move). */
function tidyAllocations(allocations: Allocation[], where: string, deps: IntentDeps, warnings: string[]): Allocation[] {
  // Two spot legs on one coin would share one quantity in the engine and be counted twice.
  // (A spot leg plus a perp leg on the same coin, i.e. a hedge, is fine.)
  const spot = allocations.filter((a) => !isPerp(a)).map((a) => a.coin);
  const dup = spot.find((c, i) => spot.indexOf(c) !== i);
  if (dup) throw new BranchError(`duplicate coin ${dup}${where}`);
  const sum = allocations.reduce((s, a) => s + a.weightPct, 0);
  if (!(sum > 0)) throw new BranchError(`allocation weights${where} must sum to more than 0`);
  let out = allocations;
  if (Math.abs(sum - 100) > 0.01) {
    const before = out.map((a) => `${a.coin} ${fmt(a.weightPct)}`).join(", ");
    out = out.map((a) => ({ ...a, weightPct: (a.weightPct / sum) * 100 }));
    const after = out.map((a) => `${a.coin} ${fmt(a.weightPct)}`).join(", ");
    warnings.push(`weights${where} summed to ${fmt(sum)}%, normalized to 100% (${before} -> ${after})`);
  }
  return out.map((a) => {
    const max = deps.maxLeverage?.(a.coin);
    if (max === undefined || (a.leverage ?? 1) <= max) return a;
    warnings.push(`${a.coin} leverage ${a.leverage}x${where} clamped to ${max}x (max on Hyperliquid)`);
    return { ...a, leverage: max };
  });
}

async function runBranch(
  name: string,
  input: BranchConfig,
  deps: IntentDeps,
  deadline: number,
): Promise<SimBranchOutcome> {
  const warnings: string[] = [];
  const unknown: string[] = [];
  const norm = (coin: string) => {
    const up = coin.toUpperCase();
    if (STABLES.has(up) || !deps.resolveCoin) return up;
    const hit = deps.resolveCoin(coin);
    if (!hit) unknown.push(coin);
    return hit ?? up;
  };
  const config: BranchConfig = {
    ...input,
    allocations: input.allocations.map((a) => ({ ...a, coin: norm(a.coin) })),
    dca: input.dca?.map((d) => ({ ...d, coin: norm(d.coin) })),
    schedule: input.schedule?.map((s) => ({
      ...s,
      allocations: s.allocations.map((a) => ({ ...a, coin: norm(a.coin) })),
      ...(s.ref && { ref: norm(s.ref) }),
    })),
  };
  if (!config.dca?.length) delete config.dca;
  if (!config.schedule?.length) delete config.schedule;
  if (Date.now() >= deadline) return { name, config, warnings, error: "deadline exceeded" };
  if (unknown.length) return { name, config, warnings, error: `unknown coin ${unknown[0]}` };
  try {
    config.allocations = tidyAllocations(config.allocations, "", deps, warnings);
    if (config.schedule) {
      const sorted = [...config.schedule].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      if (sorted.some((s, i) => s !== config.schedule![i])) warnings.push("scheduled moves sorted by date");
      config.schedule = sorted.map((s) => ({ ...s, allocations: tidyAllocations(s.allocations, ` (move on ${s.date})`, deps, warnings) }));
      for (const s of config.schedule) {
        if (s.until && Date.parse(s.until) < Date.parse(s.date)) throw new BranchError(`move on ${s.date}: until ${s.until} is before date`);
      }
    }
    if (config.endDate && Date.parse(config.endDate) <= Date.parse(config.startDate)) throw new BranchError(`endDate ${config.endDate} is not after startDate`);
    if (config.dca && config.rebalance !== "none") {
      warnings.push(`rebalance "${config.rebalance}" forced to "none" because DCA is present`);
      config.rebalance = "none";
    }

    await deps.backfill(config, deadline);
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
    // The same clamp per move: a move cannot buy a coin before its first candle.
    const firstTs = (coins: string[]) =>
      Math.max(...coins.filter((c) => !STABLES.has(c) && candles[c]?.length).map((c) => candles[c]![0]!.ts), -Infinity);
    config.schedule = config.schedule?.map((s) => {
      const first = firstTs(branchCoins({ allocations: s.allocations, schedule: [s] }));
      if (Date.parse(s.date) >= first) return s;
      if (s.until && Date.parse(s.until) < first) throw new BranchError(`move on ${s.date}: a coin has no price data before ${day(first)}`);
      warnings.push(`move on ${s.date} moved to ${day(first)}, the first day all its coins have price data`);
      return { ...s, date: day(first) };
    });

    const phases = [config.allocations, ...(config.schedule ?? []).map((s) => s.allocations)];
    const perp = phases.some((p) => p.some(isPerp));
    if (perp) {
      warnings.push(PERP_CAVEAT);
      if (!config.costs) warnings.push(COST_CAVEAT);
      if (config.scenario && config.scenario.method !== "bootstrap") {
        delete config.scenario;
        warnings.push("projection skipped — the assumption (gbm) projection models unlevered long-only portfolios; use method bootstrap for perp legs");
      }
    }
    if (perp && config.scenario && !finalAllocations(config).some(isPerp) && config.scenario.method === "bootstrap") {
      warnings.push("projection resamples the whole history, including the levered phases, though the branch ends without a perp leg");
    }
    const result = simulateLoaded(config, candles, deps.now());
    const filled = new Map((result.moves ?? []).map((m) => [m.step, m.date]));
    config.schedule?.forEach((s, i) => {
      const at = filled.get(i);
      const label = s.note ? `"${s.note}"` : `move on ${s.date}`;
      if (!at) warnings.push(`${label} not filled: no day of the replay in its window, or a later move on the same day replaced it`);
      else if (s.until) {
        warnings.push(`${label} filled ${at}, the ${s.at === "high" ? "highest" : "lowest"} ${s.ref ?? "BTC"} close between ${s.date} and ${s.until} (hindsight timing, a best case)`);
      }
    });
    return { name, config, result, warnings };
  } catch (err) {
    if (err instanceof BranchError) return { name, config, warnings, error: err.message };
    if (err instanceof NoPriceDataError || err instanceof UpstreamError) return { name, config, warnings, error: err.message };
    // Anything else is a bug or an unexpected upstream failure: log it, don't hand internals to the model.
    console.error(`[sim] branch "${name}" failed:`, err);
    return { name, config, warnings, error: "internal error" };
  }
}

/** Never throws for a bad branch (that branch gets `error`; branches not started by `deadline`, ms epoch,
 * get "deadline exceeded"). An invalid intent returns `{ error }`
 * (zod message) so callers can hand it back to the model. */
export async function runIntent(intent: unknown, deps: IntentDeps, deadline = Infinity): Promise<SimRunResult | { error: string }> {
  const parsed = SimIntentSchema.safeParse(intent);
  if (!parsed.success) {
    return { error: `invalid intent: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  const branches: SimBranchOutcome[] = [];
  for (const b of parsed.data.branches) branches.push(await runBranch(b.name, b.config, deps, deadline));
  return { intent: parsed.data as SimIntent, branches };
}
