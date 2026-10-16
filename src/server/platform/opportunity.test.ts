import { describe, expect, test } from "bun:test";
import { OPPORTUNITY_TRANSITIONS, OpportunityStatusSchema, type OpportunityStatus } from "../../shared/platform.js";
import { canTransition, nextAutoStatus, shouldExpire } from "./opportunity.js";

const costs = { feeBps: 4.5, slippageBps: 2, fundingBps: 1, absorbableUsd: 50_000 };
const ctx = { researchScore: 0.8, researchAllowed: true };
const all = OpportunityStatusSchema.options;

describe("canTransition", () => {
  test("every legal transition passes and every other pair is rejected", () => {
    for (const from of all) for (const to of all) {
      expect(canTransition(from, to)).toBe(OPPORTUNITY_TRANSITIONS[from].includes(to));
    }
    expect(canTransition("new", "ready")).toBe(false);
    expect(canTransition("closed", "new")).toBe(false);
  });
});

describe("shouldExpire", () => {
  const opp = { status: "ready" as const, updatedAt: "2026-10-13T12:00:00Z" };
  test("boundary: not before ttl, expired exactly at ttl", () => {
    expect(shouldExpire(opp, new Date("2026-10-13T12:59:59Z"), 60)).toBe(false);
    expect(shouldExpire(opp, new Date("2026-10-13T13:00:00Z"), 60)).toBe(true);
  });
  test("only ready ideas expire; bad input never expires", () => {
    expect(shouldExpire({ ...opp, status: "calculated" }, new Date("2027-01-01T00:00:00Z"), 60)).toBe(false);
    expect(shouldExpire({ ...opp, updatedAt: "nope" }, new Date("2027-01-01T00:00:00Z"), 60)).toBe(false);
    expect(shouldExpire(opp, new Date("2027-01-01T00:00:00Z"), NaN)).toBe(false);
  });
});

describe("nextAutoStatus", () => {
  const o = (status: OpportunityStatus, score = 0.5, c: typeof costs | null = null) => ({ status, score, costs: c });
  test("new goes to investigating only on a high score with budget", () => {
    expect(nextAutoStatus(o("new", 0.9), ctx)).toBe("investigating");
    expect(nextAutoStatus(o("new", 0.9), { ...ctx, researchAllowed: false })).toBeNull();
    expect(nextAutoStatus(o("new", 0.5), ctx)).toBeNull();
  });
  test("costs move new/investigating to calculated and calculated to ready", () => {
    expect(nextAutoStatus(o("new", 0.5, costs), ctx)).toBe("calculated");
    expect(nextAutoStatus(o("new", 0.9, costs), { ...ctx, researchAllowed: false })).toBe("calculated");
    expect(nextAutoStatus(o("investigating", 0.9, costs), ctx)).toBe("calculated");
    expect(nextAutoStatus(o("investigating", 0.9), ctx)).toBeNull();
    expect(nextAutoStatus(o("calculated", 0.5, costs), ctx)).toBe("ready");
    expect(nextAutoStatus(o("calculated"), ctx)).toBeNull();
  });
  test("never produces approved, rejected, expired, open or closed, and every output is a legal move", () => {
    for (const s of all) for (const score of [0, 1]) for (const c of [null, costs]) for (const allowed of [true, false]) {
      const next = nextAutoStatus(o(s, score, c), { researchScore: 0.8, researchAllowed: allowed });
      if (next === null) continue;
      expect(["investigating", "calculated", "ready"]).toContain(next);
      expect(canTransition(s, next)).toBe(true);
    }
  });
});
