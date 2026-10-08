import { describe, expect, test } from "bun:test";
import type { LabDataset, Rule } from "../types.js";
import { evaluateRule, inZoneDays, livePerf, ruleFiresAt } from "./evaluate.js";
import { synthetic } from "./testkit.js";
import { isoDate } from "./util.js";

const planted: Rule = {
  asset: "SYN",
  direction: "long",
  horizonDays: 2,
  conditions: [
    { feature: "syn:a|z|30", op: "<", threshold: -1 },
    { feature: "syn:b|raw|0", op: ">=", threshold: 0 },
  ],
};

const slice = (d: LabDataset, k: number): LabDataset => ({
  asset: d.asset,
  t: d.t.slice(0, k),
  price: d.price.slice(0, k),
  metrics: Object.fromEntries(Object.entries(d.metrics).map(([id, v]) => [id, v.slice(0, k)])),
});

describe("evaluateRule", () => {
  const data = synthetic({ seed: 1, drift: 0.012, days: 1500 });

  test("scores an explicit rule: 80/20 split, benchmark, sensitivity, equity", () => {
    const ev = evaluateRule(planted, data, { slippageBps: 10, includeEquity: true, windows: [7, 30, 90] });
    expect(ev.text).toBe("syn:a z(30) < -1 AND syn:b raw ≥ 0");
    expect(ev.walkForward).toBeNull();
    expect(ev.inSample.days + ev.holdout!.days).toBe(1499);
    expect(ev.holdout!.days).toBe(300);
    expect(ev.inSample.sharpe).toBeGreaterThan(1.5);
    expect(ev.holdout!.sharpe).toBeGreaterThan(0);
    expect(ev.precision).toBeGreaterThan(0.35);
    expect(ev.support).toBeGreaterThan(50);
    expect(ev.benchmark.holdout!.days).toBe(300);
    expect(ev.equity!.length).toBe(1500);
    const s = ev.sensitivity!;
    // two conditions × 4 threshold shifts, plus windows 7 and 90 for the z(30) condition
    expect(s.points.filter((p) => p.kind === "threshold").length).toBe(8);
    expect(s.points.filter((p) => p.kind === "window").map((p) => p.shift)).toEqual([7, 90]);
    expect(s.stability).toBeGreaterThan(0.5);
  });

  test("builds only the features the rule names", () => {
    const only: LabDataset = { asset: "SYN", t: data.t, price: data.price, metrics: { "syn:a": data.metrics["syn:a"]!, "syn:b": data.metrics["syn:b"]! } };
    expect(evaluateRule(planted, only, { slippageBps: 10 }).id).toBe(evaluateRule(planted, data, { slippageBps: 10 }).id);
    const { "syn:b": _drop, ...rest } = data.metrics;
    expect(() => evaluateRule(planted, { ...data, metrics: rest }, { slippageBps: 10 })).toThrow(/syn:b is not in the dataset/);
  });

  test("from/to restrict the window but features keep their warm-up history", () => {
    const from = isoDate(data.t[1000]!);
    const ev = evaluateRule(planted, data, { slippageBps: 10, from });
    expect(ev.inSample.from).toBe(isoDate(data.t[1001]!));
    expect(ev.inSample.days + ev.holdout!.days).toBe(499);
  });

  test("rejects malformed rules", () => {
    expect(() => evaluateRule({ ...planted, conditions: [] }, data, { slippageBps: 10 })).toThrow();
  });
});

describe("firing and zones", () => {
  const data = synthetic({ seed: 7, drift: 0, days: 600 });

  test("in-zone days never depend on later data", () => {
    const zone = inZoneDays(planted, data);
    expect(zone.length).toBe(600);
    expect(zone.some(Boolean)).toBe(true);
    for (const k of [100, 250, 431, 599]) expect(ruleFiresAt(planted, slice(data, k + 1)).firing).toBe(zone[k]!);
  });

  test("latest values and date", () => {
    const f = ruleFiresAt(planted, data);
    expect(f.latest.date).toBe(isoDate(data.t[599]!));
    expect(f.latest.values["syn:b|raw|0"]).toBe(data.metrics["syn:b"]![599]!);
    const gap = slice(data, 600);
    gap.metrics["syn:b"]![599] = NaN;
    const g = ruleFiresAt(planted, gap);
    expect(g.firing).toBe(false);
    expect(g.latest.values["syn:b|raw|0"]).toBeNull();
  });

  test("live performance after a save time", () => {
    const savedAt = new Date(data.t[500]! + 3_600_000).toISOString();
    const live = livePerf(planted, data, { slippageBps: 10, from: savedAt })!;
    expect(live.days).toBe(99);
    expect(live.from).toBe(isoDate(data.t[501]!));
    expect(livePerf(planted, data, { slippageBps: 10, from: isoDate(data.t[599]!) })).toBeNull();
  });
});
