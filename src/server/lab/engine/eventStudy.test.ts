import { describe, expect, test } from "bun:test";
import { DAY_MS, type LabDataset, type Rule } from "../types.js";
import { funnel, inZoneDays, ruleFiresAt } from "./evaluate.js";
import { ATR_WINDOW, eventStudy, FUNDING, HIGH, isoWeek, LOW, OPEN, replayCoin, screenOf, t95, verdictOfScreen, type StudyEvent } from "./eventStudy.js";
import { trendSeries } from "./features.js";
import { ruleText } from "./rules.js";
import { synthetic } from "./testkit.js";
import { isoDate } from "./util.js";

const T0 = Date.UTC(2024, 0, 1); // a Monday

interface Bar {
  o: number;
  h: number;
  l: number;
  c: number;
  f?: number;
  x?: number;
}

/** Flat bars (o = c = 100, h 101, l 99: TR = ATR = 2), funding 0.0001/day, syn:x 0; then the overrides. */
function dataset(n: number, over: Record<number, Partial<Bar>> = {}, coin = "AAA"): LabDataset {
  const bars = Array.from({ length: n }, (_, i): Bar => ({ o: 100, h: 101, l: 99, c: 100, f: 0.0001, x: 0, ...over[i] }));
  return {
    asset: coin,
    t: bars.map((_, i) => T0 + i * DAY_MS),
    price: bars.map((b) => b.c),
    metrics: {
      [OPEN]: bars.map((b) => b.o),
      [HIGH]: bars.map((b) => b.h),
      [LOW]: bars.map((b) => b.l),
      [FUNDING]: bars.map((b) => b.f ?? NaN),
      "syn:x": bars.map((b) => b.x ?? 0),
    },
  };
}

const rule = (direction: "long" | "short", horizonDays = 3): Rule => ({ asset: "AAA", direction, horizonDays, conditions: [{ feature: "syn:x|raw|0", op: ">=", threshold: 1 }] });
const opts = { stopAtr: 1, targetAtr: 2, slippageBps: 5 }; // ATR 2 → risk 2 (stopPct 2%), target ±4

describe("replayCoin: play-out and R", () => {
  test("horizon exit, hand-checked R net of fee, slippage on both sides and funding (long pays)", () => {
    const d = dataset(30, { 20: { x: 1 }, 23: { c: 101, h: 101.5, l: 100 } });
    const [ev] = replayCoin(rule("long"), d, opts);
    // gross (101 − 100) / 2 = 0.5; costs (0.09 + 2 × 0.05) / 2 = 0.095; funding 3 × 0.01% / 2 = 0.015
    expect(ev).toMatchObject({ date: isoDate(T0 + 20 * DAY_MS), exit: "horizon", exitDate: isoDate(T0 + 23 * DAY_MS), ambiguous: false });
    expect(ev!.r).toBeCloseTo(0.5 - 0.095 - 0.015, 10);
    expect(ev!.fundingR).toBeCloseTo(-0.015, 10);
  });

  test("short receives positive funding", () => {
    const d = dataset(30, { 20: { x: 1 }, 23: { c: 101, h: 101.5, l: 100 } });
    const [ev] = replayCoin(rule("short"), d, opts);
    expect(ev!.fundingR).toBeCloseTo(0.015, 10);
    expect(ev!.r).toBeCloseTo(-0.5 - 0.095 + 0.015, 10);
  });

  test("slippage is charged on entry and exit", () => {
    const d = dataset(30, { 20: { x: 1 } });
    const r0 = replayCoin(rule("long"), d, { ...opts, slippageBps: 0 })[0]!.r;
    const r10 = replayCoin(rule("long"), d, { ...opts, slippageBps: 10 })[0]!.r;
    expect(r0 - r10).toBeCloseTo((2 * 0.1) / 2, 10);
  });

  test("ambiguous bar scores as stop; a gap fills at the open", () => {
    const amb = replayCoin(rule("long"), dataset(30, { 20: { x: 1 }, 21: { h: 105, l: 97 } }), opts)[0]!;
    expect(amb).toMatchObject({ exit: "stop", ambiguous: true });
    expect(amb.r).toBeCloseTo(-1 - 0.095 - 0.005, 10);
    const gap = replayCoin(rule("long"), dataset(30, { 20: { x: 1 }, 21: { o: 95, h: 96, l: 94, c: 95 } }), opts)[0]!;
    expect(gap.exit).toBe("stop");
    expect(gap.r).toBeCloseTo(-2.5 - 0.095 - 0.005, 10);
    const tgt = replayCoin(rule("long"), dataset(30, { 20: { x: 1 }, 21: { h: 104.5, l: 99.5 } }), opts)[0]!;
    expect(tgt.exit).toBe("target");
    expect(tgt.r).toBeCloseTo(2 - 0.095 - 0.005, 10);
    const shortStop = replayCoin(rule("short"), dataset(30, { 20: { x: 1 }, 21: { o: 103, h: 104, l: 102 } }), opts)[0]!;
    expect(shortStop.r).toBeCloseTo(-1.5 - 0.095 + 0.005, 10);
  });

  test("cooldown = horizon: no overlapping holds", () => {
    const over: Record<number, Partial<Bar>> = {};
    for (let i = 20; i <= 40; i++) over[i] = { x: 1 };
    const evs = replayCoin(rule("long", 3), dataset(60, over), opts);
    expect(evs.map((e) => e.date)).toEqual([20, 23, 26, 29, 32, 35, 38].map((i) => isoDate(T0 + i * DAY_MS)));
    for (let k = 1; k < evs.length; k++) expect(evs[k]!.date >= evs[k - 1]!.exitDate).toBe(true);
  });

  test("unscorable firing days are no events: before ATR warm-up, missing funding in the hold, data ending first", () => {
    expect(replayCoin(rule("long"), dataset(30, { [ATR_WINDOW - 1]: { x: 1 } }), opts)).toEqual([]);
    expect(replayCoin(rule("long"), dataset(30, { 20: { x: 1 }, 22: { f: undefined } }), opts)).toEqual([]);
    expect(replayCoin(rule("long"), dataset(30, { 28: { x: 1 } }), opts)).toEqual([]);
  });

  test("a structural stop with no target, firing before ATR warm-up: no event, since the default target would be NaN", () => {
    const structural: Rule = { ...rule("long"), stop: { ref: "low", n: 7 } };
    expect(replayCoin(structural, dataset(30, { [ATR_WINDOW - 1]: { x: 1 } }), opts)).toEqual([]);
    expect(replayCoin(structural, dataset(30, { 20: { x: 1 } }), opts)).toHaveLength(1); // control: same rule, ATR warm
  });
});

describe("clustering and the screen", () => {
  test("ISO week = Monday, across year boundaries (week 1 starting in December, week 53)", () => {
    expect(isoWeek("2024-12-30")).toBe("2024-12-30"); // Mon, ISO 2025-W01
    expect(isoWeek("2025-01-01")).toBe("2024-12-30");
    expect(isoWeek("2025-01-05")).toBe("2024-12-30"); // Sun ends the week
    expect(isoWeek("2025-01-06")).toBe("2025-01-06");
    expect(isoWeek("2021-01-03")).toBe("2020-12-28"); // Sun of ISO 2020-W53
    expect(isoWeek("2026-10-18")).toBe("2026-10-12");
  });

  test("one-sided t quantile, df = weeks − 1", () => {
    expect(t95(1)).toBe(6.314);
    expect(t95(29)).toBe(1.699);
    expect(t95(40)).toBeCloseTo(1.6839, 3);
    expect(t95(120)).toBeCloseTo(1.6577, 3);
    expect(t95(0)).toBeNaN();
  });

  const ev = (date: string, r: number): StudyEvent => ({ coin: "A", date, exit: "horizon", exitDate: date, r, fundingR: 0, ambiguous: false });
  const weekly = (rs: number[]) => rs.map((r, k) => ev(isoDate(T0 + k * 7 * DAY_MS), r));

  test("a week is one observation: expectancy is the mean of weekly means", () => {
    const s = screenOf([ev("2024-01-01", 1), ev("2024-01-02", 1), ev("2024-01-07", 1), ev("2024-01-08", -1)]);
    expect(s).toMatchObject({ events: 4, weeks: 2, expectancy: 0 });
    expect(s.upper95).toBeCloseTo((6.314 * Math.SQRT2) / Math.SQRT2, 10);
  });

  test("verdicts: < 30 weeks insufficient, upper95 < 0 rejected, else clear", () => {
    const losing = (w: number) => weekly(Array.from({ length: w }, (_, k) => -1 + (k % 2 ? 0.1 : -0.1)));
    expect(verdictOfScreen(screenOf(losing(29)))).toBe("insufficient");
    const rej = screenOf(losing(30));
    expect(rej.weeks).toBe(30);
    const sd = Math.sqrt((30 * 0.01) / 29);
    expect(rej.upper95).toBeCloseTo(-1 + (t95(29) * sd) / Math.sqrt(30), 10);
    expect(verdictOfScreen(rej)).toBe("rejected");
    // Negative mean but too noisy to call: not shown to lose.
    const noisy = screenOf(weekly(Array.from({ length: 30 }, (_, k) => -0.1 + (k % 2 ? 2 : -2))));
    expect(noisy.expectancy!).toBeLessThan(0);
    expect(verdictOfScreen(noisy)).toBe("clear");
  });
});

describe("eventStudy: pooled", () => {
  test("holdout is the last 30% of the period by time, not by event count; facts only", () => {
    const over: Record<number, Partial<Bar>> = {};
    for (let i = 20; i < 100; i++) over[i] = { x: 1 }; // events only early
    const r = eventStudy(rule("long"), [dataset(400, over)], opts);
    expect(r.period).toEqual({ from: isoDate(T0), to: isoDate(T0 + 399 * DAY_MS), holdoutFrom: isoDate(T0 + Math.round(399 * 0.7) * DAY_MS) });
    expect(r.screen.events).toBeGreaterThan(20);
    expect(r.holdout.events).toBe(0);
    expect(r.train.events).toBe(r.screen.events);
    expect(r.survivorship).toContain("Survivorship");
  });

  test("coins with too little history or missing data are insufficient, never filled in", () => {
    const short = dataset(200, { 50: { x: 1 } }, "NEW");
    const noFunding = dataset(400, { 50: { x: 1 } }, "NOF");
    delete noFunding.metrics[FUNDING];
    const r = eventStudy(rule("long"), [short, noFunding], opts);
    expect(r.coins).toEqual([
      { coin: "NEW", bars: 200, from: isoDate(T0), to: isoDate(T0 + 199 * DAY_MS), events: 0, status: "insufficient", reason: "200 bars with funding < 365" },
      { coin: "NOF", bars: 0, from: null, to: null, events: 0, status: "insufficient", reason: `no ${FUNDING}` },
    ]);
    expect(r).toMatchObject({ period: null, verdict: "insufficient", screen: { events: 0, weeks: 0, expectancy: null, upper95: null } });
  });
});

describe("parity (FEATURES.md § 3): event days = live firing days after cooldown, no look-ahead", () => {
  test("ruleFiresAt on data truncated at each bar picks the same entry days", () => {
    const syn = synthetic({ seed: 7, days: 700 });
    const c = syn.price;
    const o = c.map((_, i) => c[Math.max(0, i - 1)]!);
    const d: LabDataset = {
      ...syn,
      metrics: {
        ...syn.metrics,
        [OPEN]: o,
        [HIGH]: c.map((x, i) => Math.max(x, o[i]!) * 1.01),
        [LOW]: c.map((x, i) => Math.min(x, o[i]!) * 0.99),
        [FUNDING]: c.map(() => 0.0001),
      },
    };
    const r: Rule = { asset: "SYN", direction: "long", horizonDays: 5, conditions: [{ feature: "syn:a|z|30", op: "<", threshold: -1 }, { feature: "syn:b|raw|0", op: ">=", threshold: 0 }] };
    const n = d.t.length;
    const H = r.horizonDays;
    const cut = (k: number): LabDataset => ({ ...d, t: d.t.slice(0, k + 1), price: d.price.slice(0, k + 1), metrics: Object.fromEntries(Object.entries(d.metrics).map(([id, v]) => [id, v.slice(0, k + 1)])) });
    const expected: string[] = [];
    let next = 0;
    for (let k = ATR_WINDOW; k < n - H; k++) {
      if (k < next || !ruleFiresAt(r, cut(k)).firing) continue;
      expected.push(isoDate(d.t[k]!));
      next = k + H;
    }
    const got = replayCoin(r, d, { stopAtr: 1.5, targetAtr: 3 }).map((e) => e.date).filter((x) => x < isoDate(d.t[n - H]!));
    expect(expected.length).toBeGreaterThan(10);
    expect(got).toEqual(expected);
  });
});

describe("funnel", () => {
  const fr = (conds: Rule["conditions"]): Rule => ({ asset: "AAA", direction: "long", horizonDays: 3, conditions: conds });
  const x = (op: "<" | ">=", threshold: number) => ({ feature: "syn:x|raw|0", op, threshold });
  const d = dataset(10, { 1: { x: 2 }, 2: { x: 2 }, 3: { x: 2 }, 4: { x: 2 }, 5: { x: 5 }, 6: { x: 0.5 } });

  test("hand-built: 10 -> 5 -> 1, bottleneck is the largest relative drop", () => {
    const f = funnel(fr([x(">=", 1), x(">=", 5)]), d);
    expect(f.steps.map((s) => s.survivors)).toEqual([5, 1]);
    expect(f.steps[0]!.dropRel).toBeCloseTo(0.5);
    expect(f.steps[1]!.dropRel).toBeCloseTo(0.8);
    expect(f.bottleneck).toBe(1);
  });

  test("zero survivors: later steps drop 0, bottleneck stays on the killer", () => {
    const f = funnel(fr([x(">=", 99), x(">=", 1)]), d);
    expect(f.steps.map((s) => s.survivors)).toEqual([0, 0]);
    expect(f.steps.map((s) => s.dropRel)).toEqual([1, 0]);
    expect(f.bottleneck).toBe(0);
  });

  test("monotonic and last step equals inZoneDays firing count (parity), pooled over coins", () => {
    const syn = synthetic({ seed: 7, days: 400 });
    const r = fr([{ feature: "syn:a|z|30", op: "<", threshold: -0.5 }, { feature: "syn:b|raw|0", op: ">=", threshold: 0 }]);
    const f = funnel(r, [syn, syn]);
    const sv = f.steps.map((s) => s.survivors);
    expect(sv.every((v, i) => i === 0 || v <= sv[i - 1]!)).toBe(true);
    expect(sv.at(-1)).toBe(2 * inZoneDays(r, syn).filter(Boolean).length);
  });
});

describe("rule exits and regime (PS-B4)", () => {
  test("structural stop: the 3-bar low, hand-checked R", () => {
    const d = dataset(30, { 19: { l: 97 }, 20: { x: 1 }, 21: { l: 96 } });
    const ev = replayCoin({ ...rule("long"), stop: { ref: "low", n: 3 } }, d, opts)[0]!;
    // stop 97, risk 3 (stopPct 3%): gross −1, costs 0.19 / 3, one day's funding 0.01 / 3
    expect(ev).toMatchObject({ exit: "stop", exitDate: isoDate(T0 + 21 * DAY_MS) });
    expect(ev.r).toBeCloseTo(-1 - 0.19 / 3 - 0.01 / 3, 10);
  });

  test("a rule's target overrides the targetAtr arg; a target on the wrong side is no event", () => {
    const d = dataset(30, { 20: { x: 1 }, 21: { h: 102.5 } });
    expect(replayCoin(rule("long"), d, opts)[0]!.exit).toBe("horizon"); // arg target 104
    const ev = replayCoin({ ...rule("long"), target: { ref: "entry", atr: 1 } }, d, opts)[0]!;
    expect(ev.exit).toBe("target");
    expect(ev.r).toBeCloseTo(1 - 0.095 - 0.005, 10);
    expect(replayCoin({ ...rule("long"), target: { ref: "ma", n: 5, atr: -1 } }, d, opts)).toEqual([]);
  });

  test("invalidation at a close exits at the next open, without that day's funding", () => {
    const d = dataset(30, { 20: { x: 1 }, 21: { x: -2 }, 22: { o: 99.5 } });
    const r = { ...rule("long"), invalidation: [{ feature: "syn:x|raw|0", op: "<" as const, threshold: -1 }] };
    const ev = replayCoin(r, d, opts)[0]!;
    // (99.5 − 100) / 2 = −0.25; costs 0.095; funding 1 day 0.005
    expect(ev).toMatchObject({ exit: "invalidation", exitDate: isoDate(T0 + 22 * DAY_MS) });
    expect(ev.r).toBeCloseTo(-0.25 - 0.095 - 0.005, 10);
    // Firing on the horizon bar: the horizon close wins.
    expect(replayCoin(r, dataset(30, { 20: { x: 1 }, 23: { x: -2 } }), opts)[0]!.exit).toBe("horizon");
  });

  test("invalidation parity: exits match the invalidation firing on data truncated at each bar", () => {
    const syn = synthetic({ seed: 7, days: 700 });
    const c = syn.price;
    const o = c.map((_, i) => c[Math.max(0, i - 1)]!);
    const d: LabDataset = {
      ...syn,
      metrics: { ...syn.metrics, [OPEN]: o, [HIGH]: c.map((x, i) => Math.max(x, o[i]!) * 1.01), [LOW]: c.map((x, i) => Math.min(x, o[i]!) * 0.99), [FUNDING]: c.map(() => 0.0001) },
    };
    const inv = [{ feature: "syn:b|raw|0", op: ">=" as const, threshold: 1 }];
    const r: Rule = { asset: "SYN", direction: "long", horizonDays: 5, conditions: [{ feature: "syn:a|z|30", op: "<", threshold: -1 }], invalidation: inv };
    const cut = (k: number): LabDataset => ({ ...d, t: d.t.slice(0, k + 1), price: d.price.slice(0, k + 1), metrics: Object.fromEntries(Object.entries(d.metrics).map(([id, v]) => [id, v.slice(0, k + 1)])) });
    const invAt = (k: number) => ruleFiresAt({ ...r, conditions: inv, invalidation: undefined }, cut(k)).firing;
    const idx = (day: string) => d.t.findIndex((x) => isoDate(x) === day);
    const evs = replayCoin(r, d, { stopAtr: 3, targetAtr: 6 });
    expect(evs.filter((e) => e.exit === "invalidation").length).toBeGreaterThan(5);
    for (const e of evs) {
      const j = idx(e.date);
      const x = idx(e.exitDate);
      const lastClose = e.exit === "invalidation" ? x - 2 : x - 1;
      for (let k = j + 1; k <= lastClose; k++) expect(invAt(k)).toBe(false);
      if (e.exit === "invalidation") expect(invAt(x - 1)).toBe(true);
    }
  });

  test("regime: trend persists 3 days; it ANDs into the in-zone path and shows as a funnel step", () => {
    const n = 70;
    const d = dataset(n, Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { x: 1, c: i < 60 ? 100 + i : 50 }])));
    expect(trendSeries(d.price).slice(48, 63)).toEqual([null, ...Array(13).fill("up"), "range"]);
    const r: Rule = { ...rule("long"), regime: { trend: ["up"] } };
    const zone = inZoneDays(r, d);
    expect(zone.filter(Boolean).length).toBe(13); // days 49..61
    expect(zone[49] && zone[61] && !zone[62]).toBe(true);
    const f = funnel(r, d);
    expect(f.steps.map((s) => [s.condition, s.survivors])).toEqual([["syn:x raw ≥ 1", n], ["trend ∈ {up}", 13]]);
    expect(ruleText(r)).toBe("syn:x raw ≥ 1 AND trend ∈ {up}");
  });
});
