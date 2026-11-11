import { describe, expect, test } from "bun:test";
import type { NoveltyEntry, Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import { BoardResponseSchema, STUDY_DEFAULTS, studyEvidence, UNIVERSE_ASSET } from "../../shared/research.js";
import { memoryStore } from "../lab/store.js";
import type { CatalogueEntry, MarketPulse, Rule } from "../lab/types.js";
import { DEFINITIONS, definitionRule } from "../signals/definitions.js";
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
  ledger: async () => [],
  radar: async () => ({ calls: [call({}), call({ id: "old", date: "2026-10-30" }), call({ id: "dead", killed_at: "2026-11-09" })], scorecard: [] }),
  definitions: async () => ({ bar: "2026-11-08", coins: 0, dropped: 0, drops: [], hits: [] }),
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
    expect(b.sources).toEqual({ novelty: ok(1), rule: ok(1), opportunity: ok(1), radar: ok(1), definition: ok(0) });
    expect(b.pulse).toEqual({ assets: 2, firing: 1 });
    expect(b.signals[0]!.evidence).toEqual(studyEvidence(evidence));
    const n = b.signals.find((s) => s.source === "novelty")!;
    expect(n).toMatchObject({ rule: noveltyRule(nov), scope: "universe", tested: "short", direction: null, dailyStudy: null, definitionId: null });
    expect(n.evidence).toMatchObject({ kind: "study", events: 999 });
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
    expect(b.signals.find((s) => s.source === "rule")!.evidence).toEqual(studyEvidence(evidence));
    expect(b.signals.find((s) => s.source === "novelty")!.evidence).toBeNull();
    await buildBoard(deps({ cache }));
    expect(reads.at(-1)).toEqual([studyKey({ rule: noveltyRule(nov)!, ...STUDY_DEFAULTS }, NOW)]); // the hit stays in memory

    const failing = createStudyCache(() => NOW, 200, { getStudies: async () => { throw new Error("db down"); }, putStudy: async () => {} });
    expect(BoardResponseSchema.parse(await buildBoard(deps({ cache: failing }))).signals).toHaveLength(4);
    // A stalled store adds at most the short store timeout to the build, not another source deadline.
    const hanging = createStudyCache(() => NOW, 200, { getStudies: () => new Promise(() => {}), putStudy: async () => {} }, 30);
    const t0 = performance.now();
    const slow = await buildBoard(deps({ cache: hanging, timeoutMs: 1_000 }));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(slow.signals).toHaveLength(4);
    expect(slow.signals.every((s) => s.evidence?.kind !== "study")).toBe(true);
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
        radar: () => new Promise(() => {}),
        timeoutMs: 20,
      })),
    );
    expect(b.sources.rule).toEqual({ state: "unavailable", reason: "source failed (see server log)", count: 0, dropped: 0 });
    expect(b.sources.novelty).toEqual({ state: "unavailable", reason: "needs a database (DATABASE_URL unset)", count: 0, dropped: 0 });
    expect(b.sources.radar).toEqual({ state: "unavailable", reason: "timed out", count: 0, dropped: 0 });
    expect(b.sources.opportunity).toEqual(ok(1));
    expect(b.sources.definition).toEqual(ok(0));
    expect(b.signals.map((s) => s.source)).toEqual(["opportunity"]);
    expect(b.pulse).toBeNull();
  });

  test("definitions: a coin in zone is a universe-scoped signal with the definition's rule; scan drops count as dropped", async () => {
    const def = DEFINITIONS.find((d) => d.id === "funding_fade")!;
    const hit = { definition: def, coin: "ETH", date: "2026-11-08", values: { "ht:funding|z|90": 2.41, "okx:oi|pctile|30": 1, "ht:price|vchg|3": 0.42 } };
    const drops = [{ coin: "BAD", definition: null, reason: "HL down", retry: true }, { coin: "kNEIRO", definition: "funding_fade", reason: "no okx:oi data for the coin", retry: false }];
    const d = deps({ definitions: async () => ({ bar: "2026-11-08", coins: 21, dropped: 2, drops, hits: [hit, { ...hit, coin: "SOL" }] }) });
    const summary = studySummary(fakeStudy(), "2026-11-09T06:00:00.000Z");
    d.cache.set(studyKey({ rule: definitionRule(def), ...STUDY_DEFAULTS }, NOW), { summary, study: fakeStudy() });
    const b = BoardResponseSchema.parse(await buildBoard(d));
    expect(b.sources.definition).toEqual(ok(2, 2));
    const eth = b.signals.find((s) => s.id === "definition:ETH:funding_fade")!;
    expect(eth).toMatchObject({ source: "definition", direction: "short", tested: "short", scope: "universe", definitionId: "funding_fade", dailyStudy: null, at: Date.parse("2026-11-09T00:00:00Z") });
    expect(eth.rule).toEqual(definitionRule(def));
    expect(eth.rule!.asset).toBe(UNIVERSE_ASSET);
    expect(eth.headline).toBe("Funding fade in zone 2026-11-08: funding z(90) 2.41, okx:oi pctile(30) 1, price vchg(3) 0.42");
    expect(boardStudy(eth)).toEqual({ rule: definitionRule(def), ...STUDY_DEFAULTS });
    // One universe study per definition: both coins read the same cached study.
    expect(b.signals.filter((s) => s.source === "definition").map((s) => s.evidence)).toEqual([studyEvidence(summary), studyEvidence(summary)]);
  });

  test("opportunity: ledger evidence (current score version, 24h) and its daily definition; the daily study goes to dailyStudy, never over the ledger", async () => {
    const crowded = { ...opp, setupKind: "crowded_long", direction: "short" } as Opportunity;
    const breakdown = { ...opp, id: "22222222-2222-4222-8222-222222222222", setupKind: "vol_expansion_breakout", direction: "short" } as Opportunity;
    const breakout = { ...breakdown, id: "44444444-4444-4444-8444-444444444444", direction: "long" } as Opportunity;
    const unnamed = { ...opp, id: "55555555-5555-4555-8555-555555555555", setupKind: "crowded_long", direction: "long" } as Opportunity;
    const stats = [{ setupKind: "crowded_long", horizon: "24h", regime: null, tier: null, n: 37, clusters: 11, hitRate: 0.54, meanNet: 0.0042, ci95: [-0.003, 0.011] as [number, number] }];
    const asked: string[][] = [];
    const d = deps({ opportunities: async () => [crowded, breakdown, breakout, unnamed, { ...crowded, id: "33333333-3333-4333-8333-333333333333" }], ledger: async (kinds) => (asked.push(kinds), stats) });
    const fade = definitionRule(DEFINITIONS.find((x) => x.id === "funding_fade")!);
    const summary = studySummary(fakeStudy(), "2026-11-09T06:00:00.000Z");
    d.cache.set(studyKey({ rule: fade, ...STUDY_DEFAULTS }, NOW), { summary, study: fakeStudy() });
    const b = BoardResponseSchema.parse(await buildBoard(d));
    const o = b.signals.find((s) => s.id === `opportunity:SOL:${opp.id}`)!;
    expect(o).toMatchObject({ rule: fade, scope: "universe", tested: "short", definitionId: "funding_fade", dailyStudy: summary });
    expect(o.evidence).toEqual({ kind: "ledger", setupKind: "crowded_long", horizon: "24h", n: 37, clusters: 11, meanNet: 0.0042, ci95: [-0.003, 0.011], hitRate: 0.54 });
    expect(asked).toEqual([["crowded_long", "vol_expansion_breakout"]]); // one read, the kinds on the board only
    // The breakout kind goes either way: its short side is the daily range_breakdown, its long side range_breakout.
    const down = (id: string) => definitionRule(DEFINITIONS.find((x) => x.id === id)!);
    const w = b.signals.find((s) => s.id === `opportunity:SOL:${breakdown.id}`)!;
    expect(w).toMatchObject({ rule: down("range_breakdown"), definitionId: "range_breakdown", scope: "universe", tested: "short" });
    expect(w.evidence).toEqual({ kind: "ledger", setupKind: "vol_expansion_breakout", horizon: "24h", n: 0, clusters: 0, meanNet: null, ci95: null, hitRate: null });
    expect(b.signals.find((s) => s.id === `opportunity:SOL:${breakout.id}`)).toMatchObject({ definitionId: "range_breakout", tested: "long" });
    // A kind on a side no definition names: no rule.
    expect(b.signals.find((s) => s.id === `opportunity:SOL:${unnamed.id}`)).toMatchObject({ rule: null, definitionId: null, dailyStudy: null, scope: "coin", tested: null });
    // A failing ledger read leaves the evidence null; the source stays ok.
    const failed = BoardResponseSchema.parse(await buildBoard(deps({ opportunities: async () => [crowded], ledger: async () => { throw new Error("db down"); } })));
    expect(failed.sources.opportunity).toEqual(ok(1));
    expect(failed.signals.find((s) => s.source === "opportunity")!.evidence).toBeNull();
  });

  test("a ledger read that does not answer in time leaves opportunity evidence null; the source answers ok", async () => {
    const crowded = { ...opp, setupKind: "crowded_long", direction: "short" } as Opportunity;
    const err = console.error;
    console.error = () => {};
    try {
      const b = BoardResponseSchema.parse(await buildBoard(deps({ opportunities: async () => [crowded], ledger: () => new Promise(() => {}), ledgerTimeoutMs: 20, timeoutMs: 2_000 })));
      expect(b.sources.opportunity).toEqual(ok(1));
      expect(b.signals.find((s) => s.source === "opportunity")!).toMatchObject({ evidence: null, definitionId: "funding_fade" });
    } finally {
      console.error = err;
    }
  });

  test("radar: the call's stance at the 7-day scorecard row as evidence; no rule", async () => {
    const scorecard = [{ stance: "ride" as const, horizonDays: 3, n: 9, meanPct: 0.5, hits: 5 }, { stance: "ride" as const, horizonDays: 7, n: 8, meanPct: 1.25, hits: 6 }];
    const b = BoardResponseSchema.parse(await buildBoard(deps({ radar: async () => ({ calls: [call({}), call({ id: "f", stance: "fade" })], scorecard }) })));
    const ride = b.signals.find((s) => s.id === "radar:HYPE:c")!;
    expect(ride).toMatchObject({ rule: null, dailyStudy: null, definitionId: null });
    expect(ride.evidence).toEqual({ kind: "scorecard", stance: "ride", horizonDays: 7, n: 8, meanPct: 1.25, hitRate: 0.75 });
    expect(b.signals.find((s) => s.id === "radar:HYPE:f")!.evidence).toBeNull();
  });
});
