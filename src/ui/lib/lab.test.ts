import { describe, expect, test } from "bun:test";
import { MIN_DEFLATED_SHARPE as ENGINE_MIN_DEFLATED_SHARPE } from "../../server/lab/engine/verdict";
import {
  advancedDiffers,
  buildSearchArgs,
  conditionMet,
  configSummary,
  DEFAULT_FILTERS,
  DEFAULT_FORM,
  defaultRuleName,
  drillEvaluateArgs,
  drillTrialsN,
  dsrCell,
  dsrTitle,
  dsrTone,
  effectiveTrials,
  effortHint,
  estimateFeatures,
  fieldRoot,
  filterRules,
  fmtFeature,
  fmtDsr,
  fmtFeatureValue,
  fmtPctSigned,
  fmtSig,
  fmtSigned,
  fmtTrialsN,
  foldBars,
  foldCell,
  freshDsrN,
  MIN_DEFLATED_SHARPE,
  formFromConfig,
  holdoutGap,
  isStaleDate,
  latestRunId,
  leanFill,
  liveCell,
  logSafeEquity,
  metricAvailable,
  parseFeature,
  parseWindows,
  ruleProviders,
  ruleTextPlain,
  runKey,
  sensitivityTone,
  sharpeCell,
  sharpeOf,
  sortPulse,
  stabWord,
  validateForm,
  verdictBadge,
  verdictOf,
  wireText,
  type MetricDef,
  type PerfStats,
  type PulseAsset,
  type RuleEvaluation,
  type SearchResult,
} from "./lab";

const M: MetricDef[] = [
  { id: "cm:CapMVRVCur", provider: "cm", key: "CapMVRVCur", name: "MVRV", category: "onchain", scope: "asset", assets: ["btc", "eth"], units: "ratio", description: "", lagDays: 1 },
  { id: "ht:funding", provider: "ht", key: "funding", name: "funding", category: "derivatives", scope: "asset", units: "fraction/day", description: "", lagDays: 0 },
  { id: "ht:oi", provider: "ht", key: "oi", name: "OI", category: "derivatives", scope: "asset", units: "USD", description: "", lagDays: 0 },
];

const rule = {
  asset: "BTC",
  direction: "long" as const,
  horizonDays: 14,
  conditions: [
    { feature: "cm:CapMVRVCur|z|90", op: "<" as const, threshold: -1.1234 },
    { feature: "ht:funding|raw|0", op: ">=" as const, threshold: 0.0003 },
  ],
};

function stats(p: Partial<PerfStats>): PerfStats {
  return { from: "2020-01-01", to: "2024-01-01", days: 1000, totalReturn: 0.5, cagr: 0.1, sharpe: 1, maxDrawdown: -0.1, hitRate: 0.6, trades: 20, tradesPerYear: 5, exposure: 0.3, ...p };
}

function ev(p: Partial<RuleEvaluation> & { conditions?: number }): RuleEvaluation {
  const conditions = rule.conditions.slice(0, p.conditions ?? 2);
  return {
    id: Math.random().toString(36),
    rule: { ...rule, conditions },
    text: "",
    precision: 0.7,
    support: 100,
    inSample: stats({}),
    walkForward: stats({}),
    holdout: stats({}),
    benchmark: { inSample: stats({}), holdout: null },
    firingNow: false,
    latest: { date: "2026-10-07", values: {} },
    ...p,
  };
}

describe("rule text grammar", () => {
  test("parses feature ids from the right", () => {
    expect(parseFeature("cm:CapMVRVCur|z|90")).toEqual({ metric: "cm:CapMVRVCur", transform: "z", window: 90 });
    expect(parseFeature("ht:funding|raw|0")).toEqual({ metric: "ht:funding", transform: "raw", window: 0 });
    expect(parseFeature("odd")).toEqual({ metric: "odd", transform: "raw", window: 0 });
  });
  test("transform prefixes in our language", () => {
    expect(fmtFeature("cm:CapMVRVCur|z|90", M)).toBe("z(90) MVRV");
    expect(fmtFeature("ht:funding|raw|0", M)).toBe("funding");
    expect(fmtFeature("ht:funding|ma_ratio|30", M)).toBe("ma(30) funding");
    expect(fmtFeature("ht:funding|pctile|30", M)).toBe("pct(30) funding");
    expect(fmtFeature("x:unknown|rsi|14", M)).toBe("rsi(14) unknown");
  });
  test("thresholds by units: fraction → %, USD compact, transforms 3 sig figs", () => {
    expect(fmtFeatureValue("ht:funding|raw|0", 0.0003, M)).toBe("0.03%");
    expect(fmtFeatureValue("ht:oi|raw|0", 1_234_000_000, M)).toBe("$1.23B");
    expect(fmtFeatureValue("cm:CapMVRVCur|z|90", -1.1234, M)).toBe("−1.12");
    expect(fmtFeatureValue("ht:funding|pctile|30", 0.9, M)).toBe("0.9");
    expect(fmtSig(12345)).toBe("12300");
  });
  test("whole rule, typeset glyphs; wire text keeps ascii", () => {
    expect(ruleTextPlain(rule, M)).toBe("z(90) MVRV < −1.12 AND funding ≥ 0.03%");
    expect(wireText(rule)).toBe("cm:CapMVRVCur|z|90 < -1.1234 AND ht:funding|raw|0 >= 0.0003");
    expect(ruleProviders(rule)).toEqual(["cm", "ht"]);
  });
  test("default save name cut to 40ch", () => {
    expect(defaultRuleName(rule, M)).toBe("z(90) MVRV < −1.12 AND funding ≥ 0.03%");
    const long = defaultRuleName(rule, M.map((m) => ({ ...m, name: `${m.name} long display name` })));
    expect(long.length).toBe(40);
    expect(long.endsWith("…")).toBe(true);
    expect(defaultRuleName({ conditions: [rule.conditions[0]!] }, M)).toBe("z(90) MVRV < −1.12");
  });
  test("condition met", () => {
    expect(conditionMet(rule.conditions[0]!, -1.31)).toBe(true);
    expect(conditionMet(rule.conditions[1]!, 0.00021)).toBe(false);
    expect(conditionMet(rule.conditions[1]!, null)).toBe(null);
  });
});

describe("number formatting", () => {
  test("signed values", () => {
    expect(fmtSigned(1.4249)).toBe("+1.42");
    expect(fmtSigned(-0.97)).toBe("−0.97");
    expect(fmtSigned(-0.001)).toBe("0.00");
    expect(fmtSigned(null)).toBe("—");
    expect(fmtPctSigned(2.12)).toBe("+212%");
    expect(fmtPctSigned(0.042)).toBe("+4.2%");
    expect(fmtPctSigned(-0.184)).toBe("−18.4%");
  });
});

describe("holdout gap (rule 1)", () => {
  test("opposite sign or below half flags", () => {
    expect(holdoutGap(1.42, 0.97)).toBe(false);
    expect(holdoutGap(1.42, 0.7)).toBe(true);
    expect(holdoutGap(1.42, -0.1)).toBe(true);
    expect(holdoutGap(-1, -0.4)).toBe(true);
    expect(holdoutGap(1.42, null)).toBe(false);
    expect(holdoutGap(null, 1)).toBe(false);
    expect(holdoutGap(0, 1)).toBe(false);
  });
});

describe("verdict words and ramps", () => {
  test("stability words", () => {
    expect(stabWord(0.83).word).toBe("STABLE");
    expect(stabWord(0.75).word).toBe("STABLE");
    expect(stabWord(0.6).word).toBe("SOFT");
    expect(stabWord(0.49).word).toBe("FRAGILE");
  });
  test("sensitivity cell tone by ratio to base, never pos2", () => {
    expect(sensitivityTone(-0.2, 1.4)).toBe("neg2");
    expect(sensitivityTone(0.5, 1.4)).toBe("neg1");
    expect(sensitivityTone(1.0, 1.4)).toBe("zero");
    expect(sensitivityTone(1.4, 1.4)).toBe("pos1");
    expect(sensitivityTone(9, 1.4)).toBe("pos1");
    expect(sensitivityTone(1, 0)).toBe("zero");
  });
  test("lean bar geometry", () => {
    expect(leanFill(0.33)).toEqual({ side: "right", pct: 16.5 });
    expect(leanFill(-1)).toEqual({ side: "left", pct: 50 });
    expect(leanFill(-3)).toEqual({ side: "left", pct: 50 });
    expect(leanFill(0)).toEqual({ side: null, pct: 0 });
  });
  test("pulse sorted by |lean| desc", () => {
    const a = (asset: string, lean: number) => ({ asset, lean }) as PulseAsset;
    expect(sortPulse([a("A", 0.1), a("B", -0.5), a("C", 0.3)]).map((x) => x.asset)).toEqual(["B", "C", "A"]);
  });
  test("live cell", () => {
    expect(liveCell(null, false)).toMatchObject({ text: "—", title: "not catalogued" });
    expect(liveCell(stats({ days: 12 }), true).text).toBe("n/a — 12 live days");
    expect(liveCell(stats({ days: 40 }), true).stats?.days).toBe(40);
  });
});

describe("results filters", () => {
  const rules = [
    ev({ conditions: 2, walkForward: stats({ sharpe: 1.5, maxDrawdown: -0.1, hitRate: 0.6 }) }),
    ev({ conditions: 1, walkForward: stats({ sharpe: 0.5, maxDrawdown: -0.35, hitRate: 0.4 }) }),
    ev({ conditions: 1, walkForward: null, holdout: stats({ sharpe: 2 }) }),
  ];
  test("kind", () => {
    expect(filterRules(rules, { ...DEFAULT_FILTERS, kind: "pairs" })).toHaveLength(1);
    expect(filterRules(rules, { ...DEFAULT_FILTERS, kind: "single" })).toHaveLength(2);
    expect(filterRules(rules, DEFAULT_FILTERS)).toHaveLength(3);
  });
  test("numeric filters read the chosen window; missing window fails", () => {
    expect(filterRules(rules, { ...DEFAULT_FILTERS, minSharpe: "1" })).toHaveLength(1);
    expect(filterRules(rules, { ...DEFAULT_FILTERS, maxDd: "-30" })).toHaveLength(1);
    expect(filterRules(rules, { ...DEFAULT_FILTERS, maxDd: "30%" })).toHaveLength(1);
    expect(filterRules(rules, { ...DEFAULT_FILTERS, minHit: "50" })).toHaveLength(1);
    expect(filterRules(rules, { ...DEFAULT_FILTERS, window: "ho", minSharpe: "1.5" })).toHaveLength(1);
  });
});

describe("search form → args", () => {
  test("windows parsing", () => {
    expect(parseWindows("7, 30 90")).toEqual({ windows: [7, 30, 90], error: null });
    expect(parseWindows("7, 400").error).toBe("windows: 400 is above 365");
    expect(parseWindows("1,2,3,4,5,6,7").error).toBe("windows: at most 6");
    expect(parseWindows("").error).not.toBeNull();
  });
  test("validation", () => {
    expect(validateForm(DEFAULT_FORM).metrics).toBe("pick at least one metric");
    const ok = { ...DEFAULT_FORM, metrics: ["cm:CapMVRVCur"] };
    expect(validateForm(ok)).toEqual({});
    expect(validateForm({ ...ok, folds: "7" }).folds).toBe("folds: 7 is above 6");
    expect(validateForm({ ...ok, asset: " " }).asset).toBeDefined();
    expect(validateForm({ ...ok, from: "2024-01-01", to: "2023-01-01" }).to).toBeDefined();
  });
  test("build args and round-trip", () => {
    const f = { ...DEFAULT_FORM, asset: "sol ", metrics: ["ht:funding"], windows: "7,30", seed: "", from: "2021-01-01" };
    const args = buildSearchArgs(f);
    expect(args).toMatchObject({ asset: "SOL", metrics: ["ht:funding"], windows: [7, 30], labelQuantile: 0.3, folds: 3, from: "2021-01-01" });
    expect("seed" in args).toBe(false);
    expect("to" in args).toBe(false);
    const back = formFromConfig({ ...args, seed: 42 } as never);
    expect(back.windows).toBe("7, 30");
    expect(back.asset).toBe("SOL");
  });
  test("advanced differs", () => {
    expect(advancedDiffers(DEFAULT_FORM)).toBe(false);
    expect(advancedDiffers({ ...DEFAULT_FORM, windows: "90, 30, 7" })).toBe(true);
    expect(advancedDiffers({ ...DEFAULT_FORM, folds: "4" })).toBe(true);
    expect(advancedDiffers({ ...DEFAULT_FORM, transforms: ["raw"] })).toBe(true);
  });
  test("feature estimate, effort hint, field root, summary", () => {
    expect(estimateFeatures(6, ["raw", "z", "rsi", "ma_ratio", "roc", "vol", "pctile"], 3)).toBe(6 * 19);
    expect(estimateFeatures(2, ["z"], 3)).toBe(6);
    expect(effortHint(40, null)).toBe("~25 s");
    expect(effortHint(200, 600)).toBe("~2 min");
    expect(effortHint(20, 500)).toBe("~10 s");
    expect(fieldRoot("metrics.3")).toBe("metrics");
    expect(fieldRoot(undefined)).toBeNull();
    expect(configSummary({ asset: "btc", direction: "long", horizonDays: 14, metrics: ["a", "b"], trials: 40 })).toBe("BTC · LONG · 14D · 2 METRICS · 40 TRIALS");
  });
  test("metric availability by asset", () => {
    expect(metricAvailable(M[0]!, "BTC")).toBe(true);
    expect(metricAvailable(M[0]!, "SOL")).toBe(false);
    expect(metricAvailable(M[1]!, "SOL")).toBe(true);
  });
  test("stale data date over 2 days", () => {
    const now = Date.parse("2026-10-08T09:00:00Z");
    expect(isStaleDate("2026-10-07", now)).toBe(false);
    expect(isStaleDate("2026-10-05", now)).toBe(true);
  });
});

describe("runs table", () => {
  test("ASSET·DIR·HZN key", () => {
    expect(runKey({ asset: "btc", direction: "long", horizonDays: 14 })).toBe("BTC·L·14D");
    expect(runKey({ asset: "ETH", direction: "short", horizonDays: 7 })).toBe("ETH·S·7D");
  });
  test("best WF Sharpe null prints a dash", () => {
    expect(fmtSigned(null)).toBe("—");
  });
});

describe("robustness: untested, DSR, verdict, folds", () => {
  test("untested windows print `untested`, not a Sharpe 0.00, and never raise a gap", () => {
    expect(sharpeCell(stats({ sharpe: 0, trades: 0, untested: true })).text).toBe("untested");
    expect(sharpeCell(stats({ sharpe: 1.234 })).text).toBe("+1.23");
    expect(sharpeCell(null).text).toBe("—");
    expect(sharpeOf(stats({ sharpe: 0, untested: true }))).toBeNull();
    expect(holdoutGap(1.4, sharpeOf(stats({ sharpe: 0, untested: true })))).toBe(false);
  });
  test("an untested window fails an active MIN SHARPE filter", () => {
    const r = [ev({ holdout: stats({ sharpe: 0, untested: true }) })];
    expect(filterRules(r, { ...DEFAULT_FILTERS, window: "ho", minSharpe: "-1" })).toHaveLength(0);
    expect(filterRules(r, { ...DEFAULT_FILTERS, window: "ho" })).toHaveLength(1);
  });
  test("DSR format, tone and title", () => {
    expect(fmtDsr(0.9712)).toBe("0.97");
    expect(fmtDsr(null)).toBe("—");
    expect(fmtDsr(undefined)).toBe("—");
    expect(dsrTone(0.95)).toBe("text-green");
    expect(dsrTone(0.4)).toBe("text-amber");
    expect(dsrTone(0.7)).toBe("text-text-primary");
    expect(dsrTitle(312)).toContain("best of 312 effective trials");
    expect(dsrTitle(312)).toContain("≥ 0.90 to save");
  });
  test("the save bar's DSR cut-off mirrors the engine's, and colours green from it", () => {
    expect(MIN_DEFLATED_SHARPE).toBe(ENGINE_MIN_DEFLATED_SHARPE);
    expect(dsrTone(MIN_DEFLATED_SHARPE)).toBe("text-green");
    expect(dsrTone(MIN_DEFLATED_SHARPE - 0.001)).toBe("text-text-primary");
  });
  test("DSR title never implies deflation that did not happen", () => {
    expect(dsrTitle(1)).toContain("deflated against N=1 (undeflated)");
    expect(dsrTitle(null)).toContain("N unknown");
    expect(dsrTitle(undefined)).toContain("N unknown");
    expect(dsrTitle(null, { assumedOne: true })).toContain("deflated against N=1 (undeflated)");
    expect(dsrTitle(null, { assumedOne: true })).toContain("N is unknown");
  });
  test("DSR cell: no walk-forward, absent, undefined (null) and a value", () => {
    const wf = stats({ sharpe: 1.2 });
    expect(dsrCell({ walkForward: null, deflatedSharpe: null }, { n: 5 })).toMatchObject({ text: "—", title: "no walk-forward — not enough history" });
    expect(dsrCell({ walkForward: wf, deflatedSharpe: null }, { n: 5 })).toMatchObject({ text: "—", title: "undefined (extreme skew/kurtosis)" });
    expect(dsrCell({ walkForward: wf }, { n: 5 }).text).toBe("—");
    const c = dsrCell({ walkForward: wf, deflatedSharpe: 0.93 }, { n: 1 });
    expect(c).toMatchObject({ text: "0.93", tone: "text-green" });
    expect(c.title).toContain("N=1 (undeflated)");
    expect(dsrCell({ walkForward: wf, deflatedSharpe: 0.93 }, { n: 312 }).title).toContain("best of 312");
  });
  test("N prefers effectiveTrials, then variantsScored; nothing when absent", () => {
    const r = (x: object) => x as unknown as SearchResult;
    expect(effectiveTrials(r({ variantsScored: 900, effectiveTrials: 312.4 }))).toBe(312.4);
    expect(effectiveTrials(r({ variantsScored: 900 }))).toBe(900);
    expect(effectiveTrials(r({}))).toBeNull();
    expect(effectiveTrials(null)).toBeNull();
    expect(fmtTrialsN(312.4)).toBe("N≈312");
    expect(fmtTrialsN(1234)).toBe("N≈1.2k");
  });
  test("verdict is read from the server, never computed; bad shapes render nothing", () => {
    expect(verdictOf(ev({}))).toBeNull();
    const v = verdictOf({ ...ev({}), verdict: { level: "fails_holdout", reasons: ["holdout Sharpe −0.20", 3] } });
    expect(v).toEqual({ level: "fails_holdout", reasons: ["holdout Sharpe −0.20"] });
    expect(verdictOf({ verdict: { level: "great", reasons: [] } })).toBeNull();
    expect(verdictBadge("robust")).toEqual({ label: "ROBUST", tone: "green" });
    expect(verdictBadge("candidate").tone).toBe("amber");
    expect(verdictBadge("fails_holdout").label).toBe("FAILS HOLDOUT");
    expect(verdictBadge("weak").tone).toBe("gray");
  });
  test("fold sparkline geometry", () => {
    expect(foldBars([], 24, 14).bars).toEqual([]);
    const { zeroY, bars } = foldBars([1, -1, 0.5], 24, 14);
    expect(zeroY).toBe(7);
    expect(bars.map((b) => b.positive)).toEqual([true, false, true]);
    expect(bars[0]!.y + bars[0]!.height).toBeCloseTo(7);
    expect(bars[1]!.y).toBe(7);
    expect(bars[1]!.height).toBeCloseTo(7);
    expect(foldBars([2, 1], 16, 10).zeroY).toBe(10);
  });
  test("a null (untested) fold keeps its slot as a gap and prints untested", () => {
    const { bars } = foldBars([1, null, -1], 24, 14);
    expect(bars.map((b) => b.i)).toEqual([0, 2]);
    expect(bars[1]!.x).toBeGreaterThan(16);
    expect(foldBars([null, null], 16, 10).bars).toEqual([]);
    expect(foldCell(null)).toMatchObject({ text: "untested", tone: "text-text-secondary" });
    expect(foldCell(-0.5).text).toBe(fmtSigned(-0.5));
  });
  test("log-safe equity nulls non-positive multiples", () => {
    expect(logSafeEquity([{ t: 1, strategy: 1.2, benchmark: 0 }, { t: 2, strategy: -0.1, benchmark: 0.5 }])).toEqual([
      { t: 1, strategy: 1.2, benchmark: null },
      { t: 2, strategy: null, benchmark: 0.5 },
    ]);
  });
  test("drill N: the run's trials, 1 without a run, unknown when the run is gone, pending while it loads", () => {
    const run = (x: object) => ({ result: x as unknown as SearchResult });
    expect(drillTrialsN({ runId: "r", run: run({ variantsScored: 900, effectiveTrials: 312 }), runSettled: true })).toBe(312);
    expect(drillTrialsN({ runId: "r", run: run({ variantsScored: 900 }), runSettled: true })).toBe(900);
    expect(drillTrialsN({ runId: null, run: null, runSettled: true })).toBe(1);
    expect(drillTrialsN({ runId: "r", run: null, runSettled: true })).toBeNull();
    expect(drillTrialsN({ runId: "r", run: { result: null }, runSettled: true })).toBeNull();
    expect(drillTrialsN({ runId: "r", run: null, runSettled: false })).toBeUndefined();
  });
  test("drill re-evaluates with the search's N and a sensitivity grid, so the server's fresh verdict is complete", () => {
    const rule = ev({}).rule;
    expect(drillEvaluateArgs(rule, { trialsN: 312, slippageBps: 5, windows: [7, 30] })).toEqual({
      rule,
      includeEquity: true,
      sensitivity: true,
      trials: 312,
      slippageBps: 5,
      windows: [7, 30],
    });
    const unknown = drillEvaluateArgs(rule, { trialsN: null });
    expect("trials" in unknown).toBe(false);
    expect("trials" in drillEvaluateArgs(rule, { trialsN: 1 })).toBe(false);
    expect(freshDsrN(312)).toEqual({ n: 312 });
    expect(freshDsrN(null)).toEqual({ n: 1, assumedOne: true });
  });
  test("latest run to restore", () => {
    expect(latestRunId([{ id: "b" }, { id: "a" }])).toBe("b");
    expect(latestRunId([])).toBeNull();
    expect(latestRunId(undefined)).toBeNull();
  });
});
