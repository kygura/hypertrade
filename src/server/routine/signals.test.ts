import { describe, expect, test } from "bun:test";
import type { Thesis } from "../../shared/intel.js";
import { assemble, brokenPremises, type SignalsRaw } from "./signals.js";

const NOW = new Date("2026-10-19T10:00:00Z");
const nm = { coin: "BTC", setupKind: "x", cond: 1, value: 1.05, limit: 1, relDistance: 0.05 };
const thesis = (statuses: Array<"supported" | "contradicted">): Thesis =>
  ({ id: "t1", text: "t", assets: [], claims: [{ kind: "claim", text: "funding stays positive", status: "supported" }], invalidation: [], wrongIf: [], createdAt: "2026-10-01T00:00:00Z", checkedAt: null,
    history: statuses.map((s, i) => ({ ts: `2026-10-1${i + 6}T00:00:00Z`, checks: [{ status: s, value: null }] })) }) as unknown as Thesis;
const raw = (over: Partial<SignalsRaw> = {}): SignalsRaw => ({ nearMisses: [nm], novelty: [], ready: [], theses: [], trials: [], myMarkets: ["BTC"], ...over });

describe("signals assembly", () => {
  test("premise that flipped to contradicted since last run is reported; one already bad is not", () => {
    expect(brokenPremises(thesis(["supported", "contradicted"]), Date.parse("2026-10-16T12:00:00Z"))).toEqual(["funding stays positive"]);
    expect(brokenPremises(thesis(["contradicted", "contradicted"]), Date.parse("2026-10-16T12:00:00Z"))).toEqual([]);
  });

  test("diff against the previous run; identical input is silent", () => {
    const first = assemble(raw({ trials: [{ n: 1, at: "2026-10-19T09:00:00Z", ruleId: "r", intent: "idea", verdict: "weak", ruleInCatalogue: false }, { n: 2, at: "2026-10-19T09:30:00Z", ruleId: "r", intent: "lab_event_study", verdict: "clear", ruleInCatalogue: false }] }), null, new Date(NOW.getTime() - 3_600_000));
    expect(first.changes.labTrials).toEqual([1]); // event-study rows are not authored ideas
    expect(first.changed).toBe(true);
    const second = assemble(raw(), first, NOW);
    expect(second.changed).toBe(false);
    const third = assemble(raw({ nearMisses: [{ ...nm, coin: "ETH" }] }), second, NOW);
    expect(third.changes.nearMiss).toBe(true);
  });
});
