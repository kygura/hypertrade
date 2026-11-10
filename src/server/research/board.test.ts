import { describe, expect, test } from "bun:test";
import type { NoveltyEntry, Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import { BoardResponseSchema, STUDY_DEFAULTS } from "../../shared/research.js";
import { memoryStore } from "../lab/store.js";
import type { CatalogueEntry, MarketPulse, Rule } from "../lab/types.js";
import { boardStudy, buildBoard, SourceUnavailable, type BoardDeps } from "./board.js";
import { noveltyRule } from "./signals.js";
import { createStudyCache, studyKey, studySummary } from "./study.js";
import { fakeStudy } from "./testkit.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const rule: Rule = { asset: "BTC", direction: "long", horizonDays: 5, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1 }] };
const pulse: MarketPulse = {
  asOf: "2026-11-09T11:00:00.000Z", warnings: [],
  assets: [
    { asset: "BTC", longActive: 1, longTotal: 1, shortActive: 0, shortTotal: 0, lean: 1, rules: [{ id: "r1", name: "dip", direction: "long", firing: true, text: "" }] },
    { asset: "ETH", longActive: 0, longTotal: 1, shortActive: 0, shortTotal: 0, lean: 0, rules: [{ id: "r2", name: "x", direction: "long", firing: false, text: "" }] },
  ],
};
const catalogue = [{ id: "r1", name: "dip", rule }, { id: "r2", name: "x", rule: { ...rule, asset: "ETH" } }] as unknown as CatalogueEntry[];
const nov: NoveltyEntry = {
  id: "2026-11-08:ETH", detectedAt: "2026-11-09T00:10:00.000Z", barDate: "2026-11-08", coin: "ETH", kind: "new_extreme", families: ["funding"],
  features: [{ id: "funding_z90", value: 3, histMin: -2, histMax: 2.5, p1: -1.8, p99: 2.2, bars: 400, pctRank: 100 }], nearSetups: [], marketWide: false, pushed: true, notified: [],
};
const opp = { id: "11111111-1111-4111-8111-111111111111", coin: "SOL", direction: "short", setupKind: "s", status: "new", score: 1, liquidityTier: 2, netEdgeBps: null, edgeBasis: "unvalidated", createdAt: "2026-11-09T09:00:00.000Z" } as Opportunity;
const call = (over: Partial<RadarCall>) => ({ id: "c", date: "2026-11-08", at: "2026-11-08T13:00:00.000Z", market: "HYPE", stance: "ride", direction: "long", kind: "catalyst", thesis: "t", cause_url: "https://a.b", cause_date: "2026-11-08", kill_price: 30, kill_if: "k", mark: 33, btc: 1, rel: {}, killed_at: null, ...over }) as RadarCall;

const deps = (over: Partial<BoardDeps> = {}): BoardDeps => ({
  now: () => NOW,
  pulse: async () => ({ pulse, catalogue }),
  novelty: async () => [nov],
  opportunities: async () => [opp],
  radarCalls: async () => [call({}), call({ id: "old", date: "2026-10-30" }), call({ id: "dead", killed_at: "2026-11-09" })],
  cache: createStudyCache(() => NOW),
  ...over,
});
const ok = (count: number, dropped = 0) => ({ state: "ok" as const, count, dropped });

describe("buildBoard", () => {
  test("all sources: signals newest first, counts, pulse summary, cached evidence attached by rule and scope", async () => {
    const d = deps();
    const evidence = studySummary(fakeStudy(), "2026-11-09T06:00:00.000Z");
    d.cache.set(studyKey({ rule, coin: "BTC", ...STUDY_DEFAULTS }, NOW), { summary: evidence, study: fakeStudy() });
    // novelty is studied over the default universe: no coin in its key
    d.cache.set(studyKey({ rule: noveltyRule(nov)!, ...STUDY_DEFAULTS }, NOW), { summary: { ...evidence, events: 999 }, study: fakeStudy() });
    const b = BoardResponseSchema.parse(await buildBoard(d));
    expect(b.asOf).toBe("2026-11-09T12:00:00.000Z");
    expect(b.signals.map((s) => s.id)).toEqual([`rule:BTC:r1`, `opportunity:SOL:${opp.id}`, "novelty:ETH:2026-11-08", "radar:HYPE:c"]);
    expect(b.sources).toEqual({ novelty: ok(1), rule: ok(1), opportunity: ok(1), radar: ok(1) });
    expect(b.pulse).toEqual({ assets: 2, firing: 1 });
    expect(b.signals[0]!.evidence).toEqual(evidence);
    const n = b.signals.find((s) => s.source === "novelty")!;
    expect(n).toMatchObject({ rule: noveltyRule(nov), scope: "universe", tested: "short", direction: null });
    expect(n.evidence?.events).toBe(999);
    expect(boardStudy(n)).toEqual({ rule: noveltyRule(nov)!, ...STUDY_DEFAULTS });
    expect(boardStudy(b.signals[0]!)).toEqual({ rule, coin: "BTC", ...STUDY_DEFAULTS });
  });

  test("evidence reads through to the store in one read per build (not one per signal); a failing or slow store leaves memory only", async () => {
    const store = memoryStore();
    const evidence = studySummary(fakeStudy(), "2026-11-09T06:00:00.000Z");
    await store.putStudy(studyKey({ rule, coin: "BTC", ...STUDY_DEFAULTS }, NOW), { summary: evidence, study: fakeStudy() }, new Date(NOW));
    const reads: string[][] = [];
    const cache = createStudyCache(() => NOW, 200, { getStudies: (k) => (reads.push(k), store.getStudies(k)), putStudy: (...a) => store.putStudy(...a) });
    const b = await buildBoard(deps({ cache }));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.sort()).toEqual([studyKey({ rule, coin: "BTC", ...STUDY_DEFAULTS }, NOW), studyKey({ rule: noveltyRule(nov)!, ...STUDY_DEFAULTS }, NOW)].sort());
    expect(b.signals.find((s) => s.source === "rule")!.evidence).toEqual(evidence);
    expect(b.signals.find((s) => s.source === "novelty")!.evidence).toBeNull();
    await buildBoard(deps({ cache }));
    expect(reads.at(-1)).toEqual([studyKey({ rule: noveltyRule(nov)!, ...STUDY_DEFAULTS }, NOW)]); // the hit stays in memory

    const failing = createStudyCache(() => NOW, 200, { getStudies: async () => { throw new Error("db down"); }, putStudy: async () => {} });
    expect(BoardResponseSchema.parse(await buildBoard(deps({ cache: failing }))).signals).toHaveLength(4);
    const hanging = createStudyCache(() => NOW, 200, { getStudies: () => new Promise(() => {}), putStudy: async () => {} });
    const slow = await buildBoard(deps({ cache: hanging, timeoutMs: 20 }));
    expect(slow.signals.every((s) => s.evidence === null)).toBe(true);
  });

  test("novelty reads the last 3 closed bars", async () => {
    let since = "";
    await buildBoard(deps({ novelty: async (s) => ((since = s), []) }));
    expect(since).toBe("2026-11-06");
  });

  test("a malformed catalogue rule or an unparseable date drops that item only, counted", async () => {
    const badRule = { id: "r3", name: "stale", rule: { asset: "BTC", direction: "sideways", horizonDays: 5, conditions: [] } } as unknown as CatalogueEntry;
    const p: MarketPulse = { ...pulse, assets: [...pulse.assets, { asset: "BTC", longActive: 1, longTotal: 1, shortActive: 0, shortTotal: 0, lean: 1, rules: [{ id: "r3", name: "stale", direction: "long", firing: true, text: "" }] }] };
    const b = BoardResponseSchema.parse(
      await buildBoard(deps({
        pulse: async () => ({ pulse: p, catalogue: [...catalogue, badRule] }),
        novelty: async () => [nov, { ...nov, coin: "SOL", detectedAt: "not a date" }],
      })),
    );
    expect(b.sources.rule).toEqual(ok(1, 1));
    expect(b.sources.novelty).toEqual(ok(1, 1));
    expect(b.signals.map((s) => s.id)).toContain("rule:BTC:r1");
    expect(b.signals.map((s) => s.id)).not.toContain("novelty:SOL:2026-11-08");
  });

  test("one source throwing, one unavailable here, one too slow: fixed reasons, the board still returns", async () => {
    const b = BoardResponseSchema.parse(
      await buildBoard(deps({
        pulse: async () => { throw new Error("connect ECONNREFUSED /var/secret/socket"); },
        novelty: async () => { throw new SourceUnavailable("needs a database (DATABASE_URL unset)"); },
        radarCalls: () => new Promise(() => {}),
        timeoutMs: 20,
      })),
    );
    expect(b.sources.rule).toEqual({ state: "unavailable", reason: "source failed (see server log)", count: 0, dropped: 0 });
    expect(b.sources.novelty).toEqual({ state: "unavailable", reason: "needs a database (DATABASE_URL unset)", count: 0, dropped: 0 });
    expect(b.sources.radar).toEqual({ state: "unavailable", reason: "timed out", count: 0, dropped: 0 });
    expect(b.sources.opportunity).toEqual(ok(1));
    expect(b.signals.map((s) => s.source)).toEqual(["opportunity"]);
    expect(b.pulse).toBeNull();
  });
});
