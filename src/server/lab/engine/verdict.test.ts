import { describe, expect, test } from "bun:test";
import type { PerfStats, RuleEvaluation } from "../types.js";
import { MIN_DEFLATED_SHARPE, verdictOf, verdictRank } from "./verdict.js";

/** `excess`: Sharpe of the exposure-matched excess over the benchmark; null = stats stored before it existed. */
const perf = (sharpe: number, untested = false, excess: number | null = 2): PerfStats => ({
  from: "2020-01-01",
  to: "2021-01-01",
  days: 366,
  totalReturn: 0,
  cagr: 0,
  sharpe,
  maxDrawdown: 0,
  hitRate: null,
  trades: untested ? 0 : 5,
  tradesPerYear: 5,
  exposure: 0.3,
  ...(untested && { untested: true }),
  ...(excess != null && { excessSharpe: excess }),
});
type Ev = Pick<RuleEvaluation, "holdout" | "walkForward" | "sensitivity" | "deflatedSharpe">;
const good: Ev = { holdout: perf(0.8), walkForward: perf(1.6), sensitivity: { base: { sharpe: 1, totalReturn: 0 }, stability: 0.75, points: [] }, deflatedSharpe: 0.97 };
const v = (over: Partial<Ev>) => verdictOf({ ...good, ...over });

describe("verdict", () => {
  test("robust when every check passes", () => {
    expect(v({})).toEqual({ level: "robust", reasons: [] });
    expect(MIN_DEFLATED_SHARPE).toBe(0.9);
  });

  test("first failing check sets the level, reasons name every failed check with numbers", () => {
    expect(v({ deflatedSharpe: 0.71 })).toEqual({ level: "candidate", reasons: ["deflated Sharpe 0.71 < 0.9"] });
    // null with a walk-forward: the DSR is undefined (stats.ts); absent (an old evaluation): not computed.
    expect(v({ deflatedSharpe: null })).toEqual({ level: "candidate", reasons: ["deflated Sharpe undefined (extreme skew/kurtosis)"] });
    expect(v({ deflatedSharpe: undefined })).toEqual({ level: "candidate", reasons: ["deflated Sharpe not computed"] });
    expect(v({ deflatedSharpe: 0.8999 }).reasons).toEqual(["deflated Sharpe 0.900 < 0.9"]);
    expect(v({ sensitivity: { ...good.sensitivity!, stability: 0.4 }, deflatedSharpe: 0.5 })).toEqual({
      level: "fragile",
      reasons: ["stability 0.40 < 0.5", "deflated Sharpe 0.50 < 0.9"],
    });
    expect(v({ walkForward: perf(0.83), sensitivity: { ...good.sensitivity!, stability: 0.2 } })).toEqual({
      level: "weak",
      reasons: ["walk-forward Sharpe 0.83 ≤ 1", "stability 0.20 < 0.5"],
    });
    expect(v({ walkForward: null, deflatedSharpe: null })).toEqual({ level: "weak", reasons: ["no walk-forward", "deflated Sharpe not computed"] });
    expect(v({ holdout: perf(-0.42), walkForward: perf(0.5) })).toEqual({ level: "fails_holdout", reasons: ["holdout Sharpe -0.42 ≤ 0", "walk-forward Sharpe 0.50 ≤ 1"] });
    expect(v({ holdout: perf(0, true) })).toEqual({ level: "fails_holdout", reasons: ["holdout untested (no trade)"] });
    expect(v({ holdout: null }).level).toBe("fails_holdout");
    // Exactly at the bars: WF 1 and holdout 0 fail (strict), stability 0.5 and DSR at the cut-off pass.
    expect(v({ walkForward: perf(1) }).level).toBe("weak");
    expect(v({ holdout: perf(0) }).level).toBe("fails_holdout");
    expect(v({ sensitivity: { ...good.sensitivity!, stability: 0.5 }, deflatedSharpe: MIN_DEFLATED_SHARPE }).level).toBe("robust");
  });

  test("without a sensitivity grid stability is not a failure, but is noted", () => {
    expect(v({ sensitivity: undefined })).toEqual({ level: "robust", reasons: ["stability not measured (no sensitivity grid)"] });
    expect(verdictOf(good, 0.99)).toEqual({ level: "candidate", reasons: ["deflated Sharpe 0.97 < 0.99"] });
  });

  test("beta is not edge: the holdout and walk-forward must also clear their bars in excess of the benchmark", () => {
    // Raw Sharpes pass (the asset went up and the rule was long); the excess over holding it does not.
    expect(v({ walkForward: perf(1.9, false, 0.31) })).toEqual({ level: "weak", reasons: ["walk-forward excess Sharpe over the benchmark 0.31 ≤ 1"] });
    expect(v({ holdout: perf(2.1, false, -0.2) })).toEqual({ level: "fails_holdout", reasons: ["holdout excess Sharpe over the benchmark -0.20 ≤ 0"] });
    expect(v({ holdout: perf(2.1, false, 0), walkForward: perf(1.9, false, 1) })).toEqual({
      level: "fails_holdout",
      reasons: ["holdout excess Sharpe over the benchmark 0.00 ≤ 0", "walk-forward excess Sharpe over the benchmark 1.00 ≤ 1"],
    });
    expect(v({ holdout: perf(0.4, false, 0.01), walkForward: perf(1.2, false, 1.01) }).level).toBe("robust");
  });

  test("stats stored before the benchmark gate: never robust, the reason says why", () => {
    const old = v({ holdout: perf(0.8, false, null), walkForward: perf(1.6, false, null) });
    expect(old).toEqual({ level: "candidate", reasons: ["excess over the benchmark not measured (evaluated before the benchmark gate; re-evaluate)"] });
    // A fresh holdout beside a walk-forward taken from an old run (service: catalogue save with a runId) is still unmeasured.
    expect(v({ walkForward: perf(1.6, false, null) }).level).toBe("candidate");
    expect(v({ holdout: perf(-1, false, null), walkForward: perf(1.6, false, null) }).level).toBe("fails_holdout");
  });

  test("rank orders levels best first", () => {
    const order = ["robust", "candidate", "fragile", "weak", "fails_holdout"] as const;
    expect(order.map(verdictRank)).toEqual([4, 3, 2, 1, 0]);
  });
});
