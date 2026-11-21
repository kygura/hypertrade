import { SearchConfigSchema, type SearchConfigInput, type SearchResult } from "../types.js";
import { runSearch } from "./search.js";
import { isPlanted, synthetic, trendFor } from "./testkit.js";
import { verdictOf } from "./verdict.js";

// Empirical calibration of the deflated-Sharpe cut-off of the save bar
// (docs/LAB.md "Calibration"). Pure-noise and planted-rule synthetic searches are
// run once each; every candidate threshold is then applied to their top-K
// rules. Noise is searched at each `benchSharpes` level: the same metrics that
// predict nothing, on a price that drifts enough to give buy-and-hold that
// annualised Sharpe, so the bar is shown not to pass beta.
// Run `bun src/server/lab/engine/calibrate.ts` to print the table.

export interface CalibrationOptions {
  thresholds: number[];
  noiseSeeds: number[];
  plantedSeeds: number[];
  drifts: number[];
  /** Buy-and-hold Sharpe levels the noise (and planted) searches run at; default [0]. */
  benchSharpes?: number[];
  days?: number;
  config?: Partial<SearchConfigInput>;
}

interface CalibrationRow {
  threshold: number;
  /** Per buy-and-hold Sharpe: noise searches where some top-K rule is "robust", and whose top-ranked rule is. */
  noise: Array<{ benchSharpe: number; any: number; top1: number }>;
  /** Per drift and buy-and-hold Sharpe: searches whose top-K holds the planted rule, and where that rule is "robust". */
  planted: Array<{ drift: number; benchSharpe: number; found: number; robust: number; anyRobust: number }>;
}

export interface Calibration {
  rows: CalibrationRow[];
  noiseRuns: number;
  plantedRuns: number;
  effectiveTrials: { min: number; max: number };
  variantsScored: { min: number; max: number };
}

/** The search configuration of the engine tests: 4 synthetic metrics, 3 transforms × 3 windows, 2-day horizon, 16 trials. */
const CALIBRATION_CONFIG: Partial<SearchConfigInput> = { transforms: ["raw", "z", "pctile"], horizonDays: 2, trials: 16 };

export function calibrate(o: CalibrationOptions): Calibration {
  const days = o.days ?? 2500;
  const sharpes = o.benchSharpes ?? [0];
  const search = (seed: number, drift: number, benchSharpe: number) => {
    const data = synthetic({ seed, drift, days, trend: trendFor(benchSharpe) });
    const config = SearchConfigSchema.parse({ asset: "SYN", metrics: Object.keys(data.metrics), ...CALIBRATION_CONFIG, ...o.config, seed });
    return { data, res: runSearch(config, data) };
  };
  const all: SearchResult[] = [];
  const noise = sharpes.map((sh) => o.noiseSeeds.map((s) => search(s, 0, sh).res));
  all.push(...noise.flat());
  const cells = o.drifts.flatMap((drift) => sharpes.map((benchSharpe) => ({ drift, benchSharpe })));
  const planted = cells.map(({ drift, benchSharpe }) =>
    o.plantedSeeds.map((s) => {
      const { data, res } = search(s, drift, benchSharpe);
      all.push(res);
      return { res, hit: res.rules.find((r) => isPlanted(r, data)) };
    }),
  );
  const robust = (r: SearchResult["rules"][number] | undefined, t: number) => !!r && verdictOf(r, t).level === "robust";
  const rows = o.thresholds.map((t) => ({
    threshold: t,
    noise: sharpes.map((benchSharpe, k) => ({
      benchSharpe,
      any: noise[k]!.filter((res) => res.rules.some((r) => robust(r, t))).length,
      top1: noise[k]!.filter((res) => robust(res.rules[0], t)).length,
    })),
    planted: cells.map((c, k) => ({
      ...c,
      found: planted[k]!.filter((p) => p.hit).length,
      robust: planted[k]!.filter((p) => robust(p.hit, t)).length,
      anyRobust: planted[k]!.filter((p) => p.res.rules.some((r) => robust(r, t))).length,
    })),
  }));
  const range = (xs: number[]) => ({ min: Math.min(...xs), max: Math.max(...xs) });
  return {
    rows,
    noiseRuns: o.noiseSeeds.length,
    plantedRuns: o.plantedSeeds.length,
    effectiveTrials: range(all.map((r) => r.effectiveTrials ?? 0)),
    variantsScored: range(all.map((r) => r.variantsScored ?? 0)),
  };
}

/**
 * The selection rule: among thresholds whose noise any-of-top-K pass rate is
 * ≤ maxNoiseRate at every buy-and-hold Sharpe, the one with the most planted
 * rules robust (summed over drifts); ties go to the higher threshold. Null when none qualifies.
 */
function chooseThreshold(c: Calibration, maxNoiseRate = 1 / 20): number | null {
  let best: { t: number; score: number } | null = null;
  for (const r of c.rows) {
    if (r.noise.some((x) => x.any > maxNoiseRate * c.noiseRuns)) continue;
    const score = r.planted.reduce((a, p) => a + p.robust, 0);
    if (!best || score > best.score || (score === best.score && r.threshold > best.t)) best = { t: r.threshold, score };
  }
  return best?.t ?? null;
}

/** Markdown tables of a calibration: noise searches per buy-and-hold Sharpe, then planted searches per drift and buy-and-hold Sharpe. */
function calibrationTable(c: Calibration): string {
  const first = c.rows[0];
  const bh = (s: number) => (s ? `, B&H Sharpe ≈ ${s}` : "");
  const table = (head: string[], cells: (r: CalibrationRow) => string[]) =>
    [`| ${["DSR ≥", ...head].join(" | ")} |`, `|${["", ...head].map(() => "---").join("|")}|`, ...c.rows.map((r) => `| ${[r.threshold.toFixed(2), ...cells(r)].join(" | ")} |`)].join("\n");
  const noise = table(
    (first?.noise ?? []).flatMap((x) => [`noise${bh(x.benchSharpe)}: any top-10 robust`, `noise${bh(x.benchSharpe)}: top-1 robust`]),
    (r) => r.noise.flatMap((x) => [`${x.any}/${c.noiseRuns}`, `${x.top1}/${c.noiseRuns}`]),
  );
  const planted = table(
    (first?.planted ?? []).flatMap((p) => [`drift ${p.drift}${bh(p.benchSharpe)}: planted rule robust`, `drift ${p.drift}${bh(p.benchSharpe)}: any top-10 robust`]),
    (r) => r.planted.flatMap((p) => [`${p.robust}/${c.plantedRuns} (found ${p.found})`, `${p.anyRobust}/${c.plantedRuns}`]),
  );
  return `${noise}\n\n${planted}`;
}

if (import.meta.main) {
  const trials = Number(process.argv[2] ?? CALIBRATION_CONFIG.trials);
  const c = calibrate({
    thresholds: [0, 0.5, 0.8, 0.9, 0.95],
    noiseSeeds: Array.from({ length: 40 }, (_, i) => 1000 + i),
    plantedSeeds: Array.from({ length: 20 }, (_, i) => 2000 + i),
    drifts: [0.012, 0.008],
    benchSharpes: [0, 1, 2],
    config: { trials },
  });
  console.log(`trials ${trials}; variantsScored ${c.variantsScored.min}–${c.variantsScored.max}; effectiveTrials ${c.effectiveTrials.min}–${c.effectiveTrials.max}`);
  console.log(calibrationTable(c));
  console.log(`chosen threshold (noise any-of-top-10 ≤ 1/20, most planted robust): ${chooseThreshold(c)}`);
}
