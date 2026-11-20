// What GET /api/eval serves (docs/EVAL.md §8): per asset, today's regime, the path fan with level odds, and how each
// champion spec (champions.ts) has done over the last year and what it holds today. Data comes from the Lab registry,
// which the daily /cron/lab-collect keeps current, so this needs no cron of its own; results are cached per UTC day.
import type { RegistryDeps } from "../lab/providers/registry.js";
import { CHAMPIONS } from "./champions.js";
import { loadPanels } from "./load.js";
import { evaluate, type Metrics } from "./objective.js";
import { EVAL_ASSETS, type EvalPanel } from "./panel.js";
import { simulatePaths, type PathResult } from "./paths.js";
import { labelRegimes, type Regime } from "./regimes.js";
import { positions, specKey, type StrategySpec } from "./strategies.js";

export interface ChampionView {
  name: string;
  why: string;
  key: string;
  spec: StrategySpec;
  /** Position on the last day (information, not an order). */
  now: number;
  /** Last 365 days at the spec's own size. */
  lastYear: Pick<Metrics, "sharpe" | "maxDD" | "totalReturn" | "exposure" | "ivCarry">;
}

export interface AssetView {
  asset: string;
  asOf: string;
  spot: number;
  regime: Regime;
  ivSource: EvalPanel["ivSource"];
  sthSource: EvalPanel["sthSource"];
  sthRp: number | null;
  paths: PathResult;
  champions: ChampionView[];
}

export interface EvalView {
  generatedAt: string;
  horizon: number;
  assets: AssetView[];
  warnings: string[];
}

export interface EvalOptions {
  horizon?: number;
  /** Levels per asset (upper-case ticker); default: ±10/20%, the 200-day mean and the STH cost basis. */
  levels?: Record<string, number[]>;
  races?: Record<string, Array<[number, number]>>;
  n?: number;
}

export function assetView(panel: EvalPanel, o: EvalOptions = {}): AssetView {
  const regimes = labelRegimes(panel);
  const last = panel.price.length - 1;
  const paths = simulatePaths(panel, { horizon: o.horizon ?? 60, n: o.n ?? 4000, levels: o.levels?.[panel.asset], races: o.races?.[panel.asset], keepPaths: 12 });
  const from = Math.max(1, last - 365);
  const champions = CHAMPIONS.filter((c) => !c.assets || c.assets.includes(panel.asset)).map((c): ChampionView => {
    const pos = positions(c.spec, panel, regimes);
    const m = evaluate(panel, pos, regimes, from, last + 1);
    return {
      name: c.name,
      why: c.why,
      key: specKey(c.spec),
      spec: c.spec,
      now: Math.round((pos[last] ?? 0) * 1000) / 1000,
      lastYear: { sharpe: m.sharpe, maxDD: m.maxDD, totalReturn: m.totalReturn, exposure: m.exposure, ivCarry: m.ivCarry },
    };
  });
  const sth = panel.sthRp[last];
  return {
    asset: panel.asset,
    asOf: paths.asOf,
    spot: panel.price[last]!,
    regime: regimes[last]!,
    ivSource: panel.ivSource,
    sthSource: panel.sthSource,
    sthRp: Number.isFinite(sth) ? sth! : null,
    paths,
    champions,
  };
}

const cache = new Map<string, { at: number; p: Promise<EvalView> }>();
const CACHE_MS = 60 * 60_000;

export async function buildEvalView(o: EvalOptions = {}, deps: RegistryDeps & { now?: () => number } = {}): Promise<EvalView> {
  const now = (deps.now ?? Date.now)();
  const key = JSON.stringify([new Date(now).toISOString().slice(0, 10), o]);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.p;
  const p = (async () => {
    const { panels, warnings } = await loadPanels(EVAL_ASSETS, deps);
    return { generatedAt: new Date(now).toISOString(), horizon: o.horizon ?? 60, assets: panels.map((pn) => assetView(pn, o)), warnings };
  })();
  cache.set(key, { at: now, p });
  p.catch(() => cache.delete(key));
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return p;
}
