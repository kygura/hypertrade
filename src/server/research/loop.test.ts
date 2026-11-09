import { describe, expect, test } from "bun:test";
import type { ResearchSignal, StudyRequest } from "../../shared/research.js";
import type { Rule } from "../lab/types.js";
import { createResearchLoop, MAX_STUDIES_PER_CYCLE, pickStudies } from "./loop.js";
import { studyScope, studySummary } from "./study.js";
import { fakeStudy } from "./testkit.js";

const rule = (asset: string): Rule => ({ asset, direction: "long", horizonDays: 5, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1 }] });
const sig = (coin: string, at: number, over: Partial<ResearchSignal> = {}): ResearchSignal => ({
  id: `rule:${coin}:x`, source: "rule", coin, direction: "long", headline: "", at, rule: rule(coin), ruleText: "", href: null, evidence: null, ...over,
});

describe("pickStudies", () => {
  test("rule-bearing signals without evidence, newest first, at most 3, no scope twice", () => {
    const signals = [
      sig("A", 1), sig("B", 5), sig("C", 3), sig("D", 4), sig("E", 2),
      sig("B", 6, { id: "dup" }), // same rule and coin as B: one study
      sig("F", 9, { rule: null }),
      sig("G", 8, { evidence: studySummary(fakeStudy(), "2026-11-09T00:00:00.000Z") }),
    ];
    expect(MAX_STUDIES_PER_CYCLE).toBe(3);
    expect(pickStudies(signals, new Set()).map((q) => q.coin)).toEqual(["B", "D", "C"]);
    expect(pickStudies(signals, new Set([studyScope({ rule: rule("B"), coin: "B", stopAtr: 1.5, targetAtr: 3 })])).map((q) => q.coin)).toEqual(["D", "C", "E"]);
    expect(pickStudies(signals, new Set(), 1)[0]).toEqual({ rule: rule("B"), coin: "B", stopAtr: 1.5, targetAtr: 3 });
  });
});

describe("research loop", () => {
  test("bounded per beat; a study tried today (ok or failed) is not run again until the UTC day turns", async () => {
    let now = Date.parse("2026-11-09T10:00:00Z");
    const ran: string[] = [];
    const signals = ["A", "B", "C", "D", "E"].map((c, i) => sig(c, i));
    const loop = createResearchLoop({
      now: () => now,
      signals: async () => signals,
      runStudy: async (q: StudyRequest) => {
        ran.push(q.coin!);
        if (q.coin === "E") throw new Error("upstream");
        return {} as never;
      },
    });
    await loop.tick();
    expect(ran).toEqual(["E", "D", "C"]);
    await loop.tick();
    expect(ran).toEqual(["E", "D", "C", "B", "A"]);
    await loop.tick(); // all tried today, E's failure included
    expect(ran).toHaveLength(5);
    now += 14 * 3_600_000; // next UTC day
    await loop.tick();
    expect(ran.slice(5)).toEqual(["E", "D", "C"]);
    expect(loop.def).toMatchObject({ name: "research", intervalSec: 900 });
  });
});
