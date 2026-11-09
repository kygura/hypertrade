import { describe, expect, test } from "bun:test";
import { StudySummarySchema, type StudyRequest } from "../../shared/research.js";
import { ruleId } from "../lab/engine/rules.js";
import type { Rule } from "../lab/types.js";
import { UpstreamError } from "../mcp/types.js";
import { createStudyCache, createStudyRunner, studyKey, studySummary } from "./study.js";
import { fakeStudy } from "./testkit.js";

const rule: Rule = { asset: "ETH", direction: "short", horizonDays: 7, conditions: [{ feature: "ht:funding|z|90", op: ">=", threshold: 2 }] };
const q: StudyRequest = { rule, coin: "ETH", stopAtr: 1.5, targetAtr: 3 };
const T = Date.parse("2026-11-09T23:59:00Z");

describe("studySummary", () => {
  test("projects the screen, holdout expectancy and idea; nothing recomputed", () => {
    const s = studySummary(fakeStudy(), "2026-11-09T10:00:00.000Z");
    expect(StudySummarySchema.parse(s)).toEqual({ verdict: "clear", events: 120, weeks: 64, expectancy: 0.21, upper95: 0.38, holdoutExpectancy: 0.12, idea: { n: 7, of: 9 }, asOf: "2026-11-09T10:00:00.000Z" });
    const empty = studySummary(fakeStudy({ verdict: "insufficient", screen: { events: 0, weeks: 0, expectancy: null, upper95: null }, holdout: { events: 0, weeks: 0, expectancy: null, upper95: null } }), "2026-11-09T10:00:00.000Z");
    expect(empty).toMatchObject({ verdict: "insufficient", expectancy: null, upper95: null, holdoutExpectancy: null });
  });
});

describe("study cache", () => {
  test("key: rule hash, coin, exits and UTC day", () => {
    expect(studyKey(q, T)).toBe(`${ruleId(rule)}:ETH:1.5:3:2026-11-09`);
    expect(studyKey({ ...q, coin: undefined }, T)).toBe(`${ruleId(rule)}:*:1.5:3:2026-11-09`);
    expect(studyKey({ ...q, coin: "eth" }, T)).toBe(studyKey(q, T));
    expect(studyKey({ ...q, targetAtr: 2 }, T)).not.toBe(studyKey(q, T));
  });

  test("an entry lives until the UTC day turns", () => {
    let now = T;
    const cache = createStudyCache(() => now);
    const e = { summary: studySummary(fakeStudy(), new Date(T).toISOString()), study: fakeStudy() };
    cache.set(q, e);
    expect(cache.get(q)).toBe(e);
    expect(cache.get({ ...q, coin: "BTC" })).toBeUndefined();
    now = T + 60_000; // 2026-11-10 00:00
    expect(cache.get(q)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});

describe("study runner", () => {
  test("runs lab_event_study with the request's args once per day; concurrent asks share one run; errors cache nothing", async () => {
    const calls: unknown[] = [];
    let fail = false;
    const run = createStudyRunner({
      cache: createStudyCache(() => T),
      now: () => T,
      eventStudy: async (args, ctx) => {
        calls.push({ args, ctx });
        if (fail) throw new UpstreamError("HL down");
        await Promise.resolve();
        return fakeStudy();
      },
    });
    const [a, b] = await Promise.all([run(q, { source: "ui" }), run(q, { source: "ui" })]);
    expect(calls).toEqual([{ args: { rule, stopAtr: 1.5, targetAtr: 3, coins: ["ETH"] }, ctx: { source: "ui" } }]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ studyId: studyKey(q, T), cached: false, summary: { verdict: "clear", idea: { n: 7, of: 9 } } });
    expect(await run(q, { source: "ui" })).toMatchObject({ cached: true, studyId: a.studyId });
    expect(calls).toHaveLength(1);

    fail = true;
    const other = { ...q, coin: undefined };
    expect(await run(other, { source: "api" }).catch((e) => e)).toBeInstanceOf(UpstreamError);
    expect(calls.at(-1)).toEqual({ args: { rule, stopAtr: 1.5, targetAtr: 3 }, ctx: { source: "api" } });
    fail = false;
    expect((await run(other, { source: "api" })).cached).toBe(false);
  });
});
