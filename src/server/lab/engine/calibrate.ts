import { SearchConfigSchema, type SearchConfigInput, type SearchResult } from "../types.js";
import { runSearch } from "./search.js";
import { isPlanted, synthetic } from "./testkit.js";
import { verdictOf } from "./verdict.js";

// Empirical calibration of the deflated-Sharpe cut-off of the save bar
// (LAB.md "Calibration"). Pure-noise and planted-rule synthetic searches are
// run once each; every candidate threshold is then applied to their top-K
// rules. Run `bun src/server/lab/engine/calibrate.ts` to print the table.

export interface CalibrationOptions {
  thresholds: number[];
  noiseSeeds: number[];
  plantedSeeds: number[];
  drifts: number[];
  days?: number;
  config?: Partial<SearchConfigInput>;
}

export interface CalibrationRow {
  threshold: number;
  /** Noise searches where some top-K rule is "robust". */
  noiseAny: number;
  /** Noise searches whose top-ranked rule is "robust". */
  noiseTop1: number;
  /** Per drift: searches whose top-K holds the planted rule, and where that rule is "robust". */
  planted: Array<{ drift: number; found: number; robust: number; anyRobust: number }>;
}

export interface Calibration {
  rows: CalibrationRow[];
  noiseRuns: number;
  plantedRuns: number;
  effectiveTrials: { min: number; max: number };
  variantsScored: { min: number; max: number };
}

/** The search configuration of the engine tests: 4 synthetic metrics, 3 transforms × 3 windows, 2-day horizon, 16 trials. */
export const CALIBRATION_CONFIG: Partial<SearchConfigInput> = { transforms: ["raw", "z", "pctile"], horizonDays: 2, trials: 16 };

export function calibrate(o: CalibrationOptions): Calibration {
  const days = o.days ?? 2500;
  const search = (seed: number, drift: number) => {
    const data = synthetic({ seed, drift, days });
    const config = SearchConfigSchema.parse({ asset: "SYN", metrics: Object.keys(data.metrics), ...CALIBRATION_CONFIG, ...o.config, seed });
    return { data, res: runSearch(config, data) };
  };
  const all: SearchResult[] = [];
  const noise = o.noiseSeeds.map((s) => search(s, 0).res);
  all.push(...noise);
  const planted = o.drifts.map((drift) =>
    o.plantedSeeds.map((s) => {
      const { data, res } = search(s, drift);
      all.push(res);
      return { res, hit: res.rules.find((r) => isPlanted(r, data)) };
    }),
  );
  const robust = (r: SearchResult["rules"][number] | undefined, t: number) => !!r && verdictOf(r, t).level === "robust";
  const rows = o.thresholds.map((t) => ({
    threshold: t,
    noiseAny: noise.filter((res) => res.rules.some((r) => robust(r, t))).length,
    noiseTop1: noise.filter((res) => robust(res.rules[0], t)).length,
    planted: o.drifts.map((drift, k) => ({
      drift,
      found: planted[k]!.filter((p) => p.hit).length,
      robust: planted[k]!.filter((p) => robust(p.hit, t)).length,
      anyRobust: planted[k]!.filter((p) => p.res.rules.some((r) => robust(r, t))).length,
    })),
  }));
  const range = (xs: number[]) => ({ min: Math.min(...xs), max: Math.max(...xs) });
  return {
    rows,
    noiseRuns: noise.length,
    plantedRuns: o.plantedSeeds.length,
    effectiveTrials: range(all.map((r) => r.effectiveTrials ?? 0)),
    variantsScored: range(all.map((r) => r.variantsScored ?? 0)),
  };
}

/**
 * The selection rule: among thresholds whose noise any-of-top-K pass rate is
 * ≤ maxNoiseRate, the one with the most planted rules robust (summed over
 * drifts); ties go to the higher threshold. Null when none qualifies.
 */
export function chooseThreshold(c: Calibration, maxNoiseRate = 1 / 20): number | null {
  let best: { t: number; score: number } | null = null;
  for (const r of c.rows) {
    if (r.noiseAny > maxNoiseRate * c.noiseRuns) continue;
    const score = r.planted.reduce((a, p) => a + p.robust, 0);
    if (!best || score > best.score || (score === best.score && r.threshold > best.t)) best = { t: r.threshold, score };
  }
  return best?.t ?? null;
}

/** Markdown table of a calibration. */
export function calibrationTable(c: Calibration): string {
  const drifts = c.rows[0]?.planted.map((p) => p.drift) ?? [];
  const head = ["DSR ≥", "noise: any top-10 robust", "noise: top-1 robust", ...drifts.flatMap((d) => [`drift ${d}: planted rule robust`, `drift ${d}: any top-10 robust`])];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of c.rows) {
    const cells = [
      r.threshold.toFixed(2),
      `${r.noiseAny}/${c.noiseRuns}`,
      `${r.noiseTop1}/${c.noiseRuns}`,
      ...r.planted.flatMap((p) => [`${p.robust}/${c.plantedRuns} (found ${p.found})`, `${p.anyRobust}/${c.plantedRuns}`]),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const trials = Number(process.argv[2] ?? CALIBRATION_CONFIG.trials);
  const c = calibrate({
    thresholds: [0, 0.5, 0.8, 0.9, 0.95],
    noiseSeeds: Array.from({ length: 40 }, (_, i) => 1000 + i),
    plantedSeeds: Array.from({ length: 20 }, (_, i) => 2000 + i),
    drifts: [0.012, 0.008],
    config: { trials },
  });
  console.log(`trials ${trials}; variantsScored ${c.variantsScored.min}–${c.variantsScored.max}; effectiveTrials ${c.effectiveTrials.min}–${c.effectiveTrials.max}`);
  console.log(calibrationTable(c));
  console.log(`chosen threshold (noise any-of-top-10 ≤ 1/20, most planted robust): ${chooseThreshold(c)}`);
}
