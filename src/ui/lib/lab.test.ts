import { describe, expect, test } from "bun:test";
import {
  advancedDiffers,
  buildSearchArgs,
  conditionMet,
  configSummary,
  DEFAULT_FILTERS,
  DEFAULT_FORM,
  defaultRuleName,
  effortHint,
  estimateFeatures,
  fieldRoot,
  filterRules,
  fmtFeature,
  fmtFeatureValue,
  fmtPctSigned,
  fmtSig,
  fmtSigned,
  formFromConfig,
  holdoutGap,
  isStaleDate,
  leanFill,
  liveCell,
  metricAvailable,
  parseFeature,
  parseWindows,
  ruleProviders,
  ruleTextPlain,
  runKey,
  sensitivityTone,
  sortPulse,
  stabWord,
  validateForm,
  wireText,
  type MetricDef,
  type PerfStats,
  type PulseAsset,
  type RuleEvaluation,
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
