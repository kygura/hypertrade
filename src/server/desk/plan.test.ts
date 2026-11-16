import { describe, expect, test } from "bun:test";
import type { DeskPlanInput } from "../../shared/deskPlan.js";
import { loadDeskConfig } from "./config.js";
import { activeLocks, NO_LOCKS, recordStopOut } from "./cooldown.js";
import { checkPlan, planMetrics, topRung, type PlanContext } from "./plan.js";
import type { AccountState } from "./types.js";

const cfg = loadDeskConfig({});
const NOW = new Date("2026-10-05T12:00:00Z");

function ctx(over: Partial<PlanContext> = {}, account: Partial<AccountState> = {}): PlanContext {
  return {
    account: { venue: "paper", equityUsd: 10_000, dayPnlUsd: 0, positions: [], available: true, ...account },
    limits: cfg.limits,
    rules: cfg.plan,
    locks: NO_LOCKS,
    markPx: 4000,
    ...over,
  };
}

// Long ETH: three rungs under the mark, stop 3700, target 4400.
const ladder: DeskPlanInput = {
  coin: "ETH",
  side: "long",
  rungs: [
    { px: 4000, size: 0.05 },
    { px: 3900, size: 0.05 },
    { px: 3800, size: 0.1 },
  ],
  stopPx: 3700,
  targetPx: 4400,
};

describe("planMetrics", () => {
  test("avg entry, loss at stop, % of equity, R:R full vs top-only", () => {
    const m = planMetrics(ladder, ctx());
    expect(m.totalSize).toBe(0.2);
    expect(m.notionalUsd).toBe(775); // 200 + 195 + 380
    expect(m.avgEntryPx).toBeCloseTo(3875, 6);
    // loss: 0.05·300 + 0.05·200 + 0.1·100 = 35
    expect(m.lossAtStopUsd).toBe(35);
    expect(m.lossAtStopPct).toBe(0.35);
    // full: (4400 − 3875) / (3875 − 3700) = 3; top (4000): 400 / 300 = 1.33
    expect(m.rrFull).toBe(3);
    expect(m.topRungPx).toBe(4000);
    expect(m.rrTopOnly).toBe(1.33);
    // daily limit 2% of 10k = 200 → 35 / 200; drawdown 10% of 10k = 1000 → 35 / 1000
    expect(m.dailyLimitUsedPct).toBe(17.5);
    expect(m.drawdownUsedPct).toBe(3.5);
  });

  test("daily limit counts loss already taken today; drawdown uses the configured base", () => {
    const m = planMetrics(ladder, ctx({ drawdownBaseUsd: 20_000, rules: { ...cfg.plan, maxDrawdownPct: 6 } }, { dayPnlUsd: -65 }));
    expect(m.dailyLimitUsedPct).toBe(50); // (65 + 35) / 200
    expect(m.drawdownUsedPct).toBe(2.92); // 35 / 1200
  });

  test("top rung is a long's highest and a short's lowest", () => {
    expect(topRung(ladder).px).toBe(4000);
    expect(topRung({ side: "short", rungs: [{ px: 4100, size: 1 }, { px: 4050, size: 1 }] }).px).toBe(4050);
  });

  test("short: loss and R:R measured the other way", () => {
    const m = planMetrics({ coin: "ETH", side: "short", rungs: [{ px: 4000, size: 0.1 }, { px: 4100, size: 0.1 }], stopPx: 4200, targetPx: 3700 }, ctx());
    expect(m.avgEntryPx).toBe(4050);
    expect(m.lossAtStopUsd).toBe(30); // 0.1·200 + 0.1·100
    expect(m.rrFull).toBe(2.33); // 350 / 150
    expect(m.rrTopOnly).toBe(1.5); // top = 4000: 300 / 200
  });

  test("no stop or no target leaves the dependent numbers null", () => {
    const m = planMetrics({ ...ladder, stopPx: null, targetPx: null }, ctx());
    expect(m).toMatchObject({ lossAtStopUsd: null, lossAtStopPct: null, rrFull: null, rrTopOnly: null, dailyLimitUsedPct: null, drawdownUsedPct: null, totalSize: 0.2 });
  });
});

describe("checkPlan blockers", () => {
  test("a sound plan has none; a ladder whose top rung alone is thin warns", () => {
    const c = checkPlan(ladder, ctx());
    expect(c.blockers).toEqual([]);
    expect(c.warnings.join()).toContain("only the top rung");
  });

  test.each([
    ["no stop", { stopPx: null }, "no stop"],
    ["no target", { targetPx: null }, "no target"],
    ["stop inside the ladder", { stopPx: 3850 }, "stop 3850 must be below every rung"],
    ["target inside the ladder", { targetPx: 3950 }, "target 3950 must be above every rung"],
  ] as const)("%s", (_n, over, want) => {
    expect(checkPlan({ ...ladder, ...over }, ctx()).blockers.join("|")).toContain(want);
  });

  test("short: stop must be above and target below every rung", () => {
    const b = checkPlan({ coin: "ETH", side: "short", rungs: [{ px: 4000, size: 0.01 }, { px: 4100, size: 0.01 }], stopPx: 4050, targetPx: 4050 }, ctx()).blockers.join("|");
    expect(b).toContain("stop 4050 must be above every rung (highest 4100)");
    expect(b).toContain("target 4050 must be below every rung (lowest 4000)");
  });

  test("risk over the per-trade cap: the tighter of the plan cap and the governor's limit is named", () => {
    const big = { ...ladder, rungs: [{ px: 4000, size: 0.5 }] }; // 0.5 · 300 = 150 = 1.5%
    expect(checkPlan(big, ctx()).blockers.join()).toContain("over the governor's 0.5% per-trade limit (DESK_MAX_RISK_PCT)");
    const roomy = ctx({ limits: { ...cfg.limits, maxRiskPct: 2 } });
    expect(checkPlan(big, roomy).blockers.join()).toContain("over the 1% per-trade cap (DESK_PLAN_MAX_RISK_PCT)");
    expect(checkPlan({ ...ladder, rungs: [{ px: 4000, size: 0.3 }] }, roomy).blockers).toEqual([]); // 0.9%
  });

  test("today's possible loss: lost today + open stop risk + this plan over the daily limit", () => {
    const position = { coin: "BTC", side: "long" as const, size: 0.01, entryPx: 100_000, markPx: 100_000, stopPx: 99_000, tpPx: null, unrealizedPnl: 0, notionalUsd: 1000 };
    // 150 lost + 10 open risk + 35 = 195 ≤ 200
    expect(checkPlan(ladder, ctx({}, { dayPnlUsd: -150, positions: [position] })).blockers).toEqual([]);
    // 160 + 10 + 35 = 205 > 200
    const b = checkPlan(ladder, ctx({}, { dayPnlUsd: -160, positions: [position] })).blockers;
    expect(b).toHaveLength(1);
    expect(b[0]).toContain("today's possible loss 205 USD (lost 160 + open stop risk 10 + this trade 35)");
  });

  test("a cooldown on the coin, or on everything, blocks", () => {
    const cd = { cooldownHours: 4, maxStopOutsPerDay: 2 };
    const ref = { source: "paper" as const, proposalId: null, planId: null, fill: null };
    const one = recordStopOut({ stopOuts: [] }, { coin: "ETH", at: new Date("2026-10-05T10:00:00Z"), ref }, cd);
    expect(checkPlan(ladder, ctx({ locks: activeLocks(one, NOW, cd) })).blockers.join()).toContain("new ETH entries locked until 2026-10-05 14:00 UTC");
    expect(checkPlan({ ...ladder, coin: "SOL", rungs: [{ px: 200, size: 1 }], stopPx: 195, targetPx: 220 }, ctx({ locks: activeLocks(one, NOW, cd) })).blockers).toEqual([]);
    const two = recordStopOut(one, { coin: "BTC", at: new Date("2026-10-05T11:00:00Z"), ref }, cd);
    expect(checkPlan({ ...ladder, coin: "SOL", rungs: [{ px: 200, size: 1 }], stopPx: 195, targetPx: 220 }, ctx({ locks: activeLocks(two, NOW, cd) })).blockers.join()).toContain("2 stop-outs today (ETH, BTC)");
  });

  test("an unreadable account blocks: risk cannot be measured", () => {
    expect(checkPlan(ladder, ctx({}, { available: false, equityUsd: 0, note: "upstream down" })).blockers.join()).toContain("account unavailable: upstream down");
  });
});
