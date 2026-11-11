import { describe, expect, test } from "bun:test";
import type { TriageItem } from "../../shared/agentRecords.js";
import { attribution, iso, row, T0 } from "./agent.fixture.js";
import { agentDailyCap, autoInvestigate, candidateOf, planTriage, triageBudget } from "./triage.js";

const now = new Date(T0);
const day = "2026-11-11";
const z = (coin: string, residualZ: number, over: Parameters<typeof attribution>[0] = {}) => row(coin, { attribution: attribution({ residualZ, residualPct: residualZ * 2, ...over }) });
const fade = (coin: string, met: number, of: number) =>
  row(coin, { attribution: attribution({ residualZ: 0.4 }), setups: [{ kind: "fade", side: "long", checks: [], met, of, definitionId: "funding_fade" }], positioning: { ...row(coin).positioning, longMet: 3, of: 4 } });

describe("candidateOf", () => {
  test("residual bar: |z| ≥ 2.5 and a ≥ 1% move, facts-only reason", () => {
    expect(candidateOf(z("SOL", 3.1))).toMatchObject({ coin: "SOL", score: 3.1 / 2.5, residualZ: 3.1, noNews: true, byResidual: true, reason: "residual +6.2% · z +3.1 · 24h · no news in window" });
    expect(candidateOf(z("SOL", -2.6))!.reason).toBe("residual −5.2% · z −2.6 · 24h · no news in window");
    expect(candidateOf(z("SOL", 2.4))).toBeNull();
    expect(candidateOf(z("SOL", 3, { totalPct: 0.5 }))).toBeNull(); // move under 1%
    expect(candidateOf(z("SOL", 3, { window: "4h" }))).toBeNull(); // only the 24h attribution counts
    expect(candidateOf(z("SOL", 3, { newsHours: 2 }))).toMatchObject({ noNews: false, reason: expect.stringContaining("news in 2h") });
    expect(candidateOf(row("SOL", { attribution: null }))).toBeNull();
  });

  test("checklist bar: every one of ≥ 3 checks met", () => {
    expect(candidateOf(fade("WIF", 3, 3))).toMatchObject({ score: 1, byResidual: false, residualZ: 0.4, reason: "FADE 3/3 · crowd long 3/4" });
    expect(candidateOf(fade("WIF", 2, 3))).toBeNull();
    expect(candidateOf(fade("WIF", 2, 2))).toBeNull(); // of < 3
  });
});

describe("planTriage", () => {
  const rows = [z("A", 2.6), z("B", 4), z("C", 3, { newsHours: 1 }), z("D", 3), fade("E", 3, 3), z("F", 1)];

  test("deterministic rank: score, then no news first, then |residual|; budget caps, the rest are counted", () => {
    const p = planTriage({ rows, existing: [], day, now, budget: 3 });
    expect(p.upserts.map((i) => i.coin)).toEqual(["B", "D", "C"]); // D before C: same z, no news first
    expect(p.overBudget).toBe(2); // A and E crossed the bar after the budget
    expect(p.upserts[0]).toEqual({ id: `${day}:B`, day, coin: "B", reason: expect.any(String), score: 4 / 2.5, residualZ: 4, surfacedAt: iso(T0), dismissedAt: null, recordId: null });
    expect(planTriage({ rows: [...rows].reverse(), existing: [], day, now, budget: 3 })).toEqual(p);
  });

  test("one item per coin per day; dismissed items still count against the budget", () => {
    const existing: TriageItem[] = planTriage({ rows, existing: [], day, now, budget: 2 }).upserts.map((i) => ({ ...i, dismissedAt: i.coin === "B" ? iso(T0) : null }));
    const later = planTriage({ rows, existing, day, now: new Date(T0 + 900_000), budget: 3 });
    expect(later.upserts.map((i) => i.coin)).toEqual(["C"]); // B (dismissed) and D are not surfaced again; one slot left
    expect(later.overBudget).toBe(2);
    expect(planTriage({ rows, existing, day, now, budget: 2 }).upserts).toEqual([]);
  });

  test("a coin re-enters only when |z| rose by ≥ 1 over its surfaced value, keeping its id and record", () => {
    const first = planTriage({ rows: [z("B", 3)], existing: [], day, now, budget: 8 }).upserts.map((i) => ({ ...i, dismissedAt: iso(T0), recordId: "r1" }));
    expect(planTriage({ rows: [z("B", 3.9)], existing: first, day, now, budget: 8 }).upserts).toEqual([]);
    const re = planTriage({ rows: [z("B", 4)], existing: first, day, now: new Date(T0 + 3_600_000), budget: 8 }).upserts;
    expect(re).toEqual([{ ...first[0]!, score: 4 / 2.5, residualZ: 4, reason: expect.stringContaining("z +4.0"), surfacedAt: iso(T0 + 3_600_000), dismissedAt: null }]);
    // A new UTC day starts a fresh budget.
    expect(planTriage({ rows: [z("B", 3)], existing: first, day: "2026-11-12", now, budget: 8 }).upserts.map((i) => i.id)).toEqual(["2026-11-12:B"]);
  });

  test("env budget and cap defaults", () => {
    expect([triageBudget({}), agentDailyCap({})]).toEqual([8, 6]);
    expect([triageBudget({ MOVES_TRIAGE_DAILY: "3" }), agentDailyCap({ MOVES_AGENT_DAILY: "0" })]).toEqual([3, 0]);
    expect(triageBudget({ MOVES_TRIAGE_DAILY: "x" })).toBe(8);
  });
});

describe("autoInvestigate", () => {
  const plan = planTriage({ rows: [z("A", 2.6), z("B", 4), z("C", 3, { newsHours: 1 }), fade("E", 3, 3)], existing: [], day, now, budget: 8 });
  test("only residual items with no news, no record today, not dismissed, under the cap", () => {
    expect(autoInvestigate({ items: plan.upserts, candidates: plan.candidates, recordsToday: [], room: 5 })).toEqual(["B", "A"]);
    expect(autoInvestigate({ items: plan.upserts, candidates: plan.candidates, recordsToday: [{ coin: "B" }], room: 5 })).toEqual(["A"]);
    expect(autoInvestigate({ items: plan.upserts, candidates: plan.candidates, recordsToday: [], room: 1 })).toEqual(["B"]);
    expect(autoInvestigate({ items: plan.upserts, candidates: plan.candidates, recordsToday: [], room: 0 })).toEqual([]);
    const dismissed = plan.upserts.map((i) => (i.coin === "B" ? { ...i, dismissedAt: iso(T0) } : i));
    expect(autoInvestigate({ items: dismissed, candidates: plan.candidates, recordsToday: [], room: 5 })).toEqual(["A"]);
  });

  test("unknown news (no feed ingested) still surfaces, reads `news unknown`, and is not auto-investigated", () => {
    const u = planTriage({ rows: [z("U", 4, { newsHours: null, residualNewsPct: null }), z("A", 2.6)], existing: [], day, now, budget: 8 });
    expect(u.upserts.map((i) => i.coin)).toEqual(["U", "A"]);
    expect(u.candidates.find((c) => c.coin === "U")).toMatchObject({ byResidual: true, noNews: false, newsUnknown: true, reason: "residual +8.0% · z +4.0 · 24h · news unknown" });
    expect(autoInvestigate({ items: u.upserts, candidates: u.candidates, recordsToday: [], room: 5 })).toEqual(["A"]);
  });
});
