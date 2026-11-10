import { describe, expect, test } from "bun:test";
import { StudySummarySchema, type StudyRequest } from "../../shared/research.js";
import { ruleId } from "../lab/engine/rules.js";
import type { Rule } from "../lab/types.js";
import { UpstreamError } from "../mcp/types.js";
import { memoryStore } from "../lab/store.js";
import { createStudyCache, createStudyRunner, quantize, studyKey, studySummary, type StudyStore } from "./study.js";
import { fakeStudy } from "./testkit.js";

const rule: Rule = { asset: "ETH", direction: "short", horizonDays: 7, conditions: [{ feature: "ht:funding|z|90", op: ">=", threshold: 2 }] };
const q: StudyRequest = { rule, coin: "ETH", stopAtr: 1.5, targetAtr: 3 };
const T = Date.parse("2026-11-09T23:59:00Z");
const entry = () => ({ summary: studySummary(fakeStudy(), new Date(T).toISOString()), study: fakeStudy() });

describe("studySummary", () => {
  test("projects the screen, holdout expectancy and idea; nothing recomputed", () => {
    const s = studySummary(fakeStudy(), "2026-11-09T10:00:00.000Z");
    expect(StudySummarySchema.parse(s)).toEqual({ verdict: "clear", events: 120, weeks: 64, expectancy: 0.21, upper95: 0.38, holdoutExpectancy: 0.12, idea: { n: 7, of: 9 }, asOf: "2026-11-09T10:00:00.000Z" });
    const empty = studySummary(fakeStudy({ verdict: "insufficient", screen: { events: 0, weeks: 0, expectancy: null, upper95: null }, holdout: { events: 0, weeks: 0, expectancy: null, upper95: null } }), "2026-11-09T10:00:00.000Z");
    expect(empty).toMatchObject({ verdict: "insufficient", expectancy: null, upper95: null, holdoutExpectancy: null });
  });
});

describe("study cache", () => {
  test("key: rule hash, coin or universe, exits to 0.1 ATR, UTC day", () => {
    expect(studyKey(q, T)).toBe(`${ruleId(rule)}:ETH:1.5:3:2026-11-09`);
    expect(studyKey({ ...q, coin: undefined }, T)).toBe(`${ruleId(rule)}:*:1.5:3:2026-11-09`);
    expect(studyKey({ ...q, coin: "eth" }, T)).toBe(studyKey(q, T));
    expect(studyKey({ ...q, stopAtr: 1.51, targetAtr: 2.96 }, T)).toBe(studyKey(q, T));
    expect(studyKey({ ...q, targetAtr: 2 }, T)).not.toBe(studyKey(q, T));
    expect(quantize({ ...q, stopAtr: 1.04999, targetAtr: 0.25 })).toMatchObject({ stopAtr: 1, targetAtr: 0.3 });
  });

  test("an entry lives until the UTC day turns", () => {
    let now = T;
    const cache = createStudyCache(() => now);
    const e = entry();
    cache.set(studyKey(q, now), e);
    expect(cache.get(studyKey(q, now))).toBe(e);
    expect(cache.get(studyKey({ ...q, coin: "BTC" }, now))).toBeUndefined();
    now = T + 60_000; // 2026-11-10 00:00
    expect(cache.get(studyKey(q, now))).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  test("capped: past max entries the oldest is evicted", () => {
    const cache = createStudyCache(() => T, 3);
    for (const k of ["a", "b", "c", "d"]) cache.set(`${k}:2026-11-09`, entry());
    expect(cache.size()).toBe(3);
    expect(cache.get("a:2026-11-09")).toBeUndefined();
    expect(cache.get("d:2026-11-09")).toBeDefined();
  });
});

describe("study cache over the Lab store", () => {
  const counting = () => {
    let runs = 0;
    const eventStudy = async () => (runs++, fakeStudy());
    return { eventStudy, runs: () => runs };
  };

  test("restart: a new cache over the same store returns today's study without running it (no second trial)", async () => {
    const store = memoryStore();
    const before = counting();
    const run1 = createStudyRunner({ cache: createStudyCache(() => T, 200, store), eventStudy: before.eventStudy, now: () => T });
    const first = await run1(q, { source: "ui" });
    expect([first.cached, before.runs()]).toEqual([false, 1]);
    await Bun.sleep(0); // the write-through runs in the background

    const after = counting(); // the process restarted: empty memory, same store
    const cache2 = createStudyCache(() => T, 200, store);
    const run2 = createStudyRunner({ cache: cache2, eventStudy: after.eventStudy, now: () => T });
    const again = await run2(q, { source: "ui" });
    expect(after.runs()).toBe(0);
    expect(again).toEqual({ ...first, cached: true });
    expect(cache2.get(first.studyId)).toBeDefined();
    // Another day is another study.
    const next = T + 86_400_000;
    await createStudyRunner({ cache: createStudyCache(() => next, 200, store), eventStudy: after.eventStudy, now: () => next })(q, { source: "ui" });
    expect(after.runs()).toBe(1);
  });

  test("a failing store degrades to in-memory: the study runs, is cached in process, and answers", async () => {
    const down: StudyStore = { getStudies: async () => { throw new Error("db down"); }, putStudy: async () => { throw new Error("db down"); } };
    const c = counting();
    const cache = createStudyCache(() => T, 200, down);
    const run = createStudyRunner({ cache, eventStudy: c.eventStudy, now: () => T });
    expect((await run(q, { source: "ui" })).cached).toBe(false);
    expect((await run(q, { source: "ui" })).cached).toBe(true);
    expect(c.runs()).toBe(1);
    await cache.load(["x:2026-11-09"]); // never rejects
  });

  test("a store read that never settles is a miss after the short timeout: every ask answers, the study runs once", async () => {
    const stalled: StudyStore = { getStudies: () => new Promise(() => {}), putStudy: async () => {} };
    const c = counting();
    const run = createStudyRunner({ cache: createStudyCache(() => T, 200, stalled, 20), eventStudy: c.eventStudy, now: () => T });
    const [a, b] = await Promise.all([run(q, { source: "ui" }), run(q, { source: "ui" })]);
    expect([a.cached, b.cached]).toEqual([false, false]); // the second shared the first's run
    expect((await run(q, { source: "ui" })).cached).toBe(true);
    expect(c.runs()).toBe(1);
  });

  test("a store write that never settles does not hold the answer (the write is in the background)", async () => {
    let writes = 0;
    const stalled: StudyStore = { getStudies: async () => new Map(), putStudy: () => (writes++, new Promise(() => {})) };
    const c = counting();
    const run = createStudyRunner({ cache: createStudyCache(() => T, 200, stalled), eventStudy: c.eventStudy, now: () => T });
    expect((await run(q, { source: "ui" })).cached).toBe(false);
    await Bun.sleep(0);
    expect(writes).toBe(1);
    expect((await run(q, { source: "ui" })).cached).toBe(true);
    expect(c.runs()).toBe(1);
  });

  test("load: one store read for the keys not in memory and of today; a row that does not parse is a miss", async () => {
    const reads: string[][] = [];
    const store = memoryStore();
    await store.putStudy("good:2026-11-09", entry(), new Date(T));
    await store.putStudy("bad:2026-11-09", { summary: { verdict: "maybe" }, study: {} }, new Date(T));
    const spy: StudyStore = { getStudies: (k) => (reads.push(k), store.getStudies(k)), putStudy: (...a) => store.putStudy(...a) };
    const cache = createStudyCache(() => T, 200, spy);
    await cache.set("mem:2026-11-09", entry());
    await cache.load(["good:2026-11-09", "bad:2026-11-09", "mem:2026-11-09", "old:2026-11-08", "good:2026-11-09"]);
    expect(reads).toEqual([["good:2026-11-09", "bad:2026-11-09"]]);
    expect(cache.get("good:2026-11-09")).toEqual(entry());
    expect(cache.get("bad:2026-11-09")).toBeUndefined();
    await cache.load(["mem:2026-11-09", "good:2026-11-09"]);
    expect(reads).toHaveLength(1); // all in memory now: no read
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
    const [a, b] = await Promise.all([run(q, { source: "ui" }), run({ ...q, stopAtr: 1.52 }, { source: "ui" })]);
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

  test("the study id and cache key use the UTC day the run started", async () => {
    let now = T; // 23:59
    let release!: () => void;
    const cache = createStudyCache(() => now);
    const run = createStudyRunner({ cache, now: () => now, eventStudy: () => new Promise((r) => (release = () => r(fakeStudy()))) });
    const p = run(q, { source: "ui" });
    await Promise.resolve();
    now = T + 120_000; // 00:01 the next day
    release();
    expect((await p).studyId).toEndWith(":2026-11-09");
    expect(cache.size()).toBe(0); // yesterday's entry goes once the day has turned
  });
});
