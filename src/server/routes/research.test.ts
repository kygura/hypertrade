import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import type { NoveltyEntry } from "../../shared/platform.js";
import { BoardResponseSchema, RadarResponseSchema, StudyResponseSchema } from "../../shared/research.js";
import { ruleId } from "../lab/engine/rules.js";
import { synthetic } from "../lab/engine/testkit.js";
import { createLabService } from "../lab/service.js";
import { memoryStore } from "../lab/store.js";
import { labTools } from "../lab/tools.js";
import { DAY_MS, type LabProvider, type Rule } from "../lab/types.js";
import { ToolInputError, UpstreamError } from "../mcp/types.js";
import { boardStudy, SourceUnavailable } from "../research/board.js";
import { readRadar } from "../research/radar.js";
import { createStudyCache, createStudyRunner, studyKey, type RunEventStudy } from "../research/study.js";
import { fakeStudy } from "../research/testkit.js";
import { catalogueIdOf, radarRoutes, researchRoutes, toolEventStudy } from "./research.js";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const rule: Rule = { asset: "ETH", direction: "short", horizonDays: 7, conditions: [{ feature: "ht:funding|z|90", op: ">=", threshold: 2 }] };
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

const radarCall = { id: "2026-11-08-1-HYPE", date: "2026-11-08", at: "2026-11-08T08:00:00Z", market: "HYPE", stance: "ride", direction: "long", kind: "catalyst", thesis: "a dated unlock next week", cause_url: "https://x.example/a", cause_date: "2026-11-07", kill_price: 30, kill_if: "close below 30", mark: 33, btc: 90000, rel: {}, killed_at: null } as const;

function app(eventStudy: RunEventStudy, deadline = 50_000, guest = false, catalogueId: (r: Rule) => Promise<string | null> = async () => null) {
  const cache = createStudyCache(() => NOW);
  const nov = { id: "2026-11-08:ETH", detectedAt: "2026-11-09T00:10:00.000Z", barDate: "2026-11-08", coin: "ETH", kind: "new_extreme", families: ["funding"], nearSetups: [], marketWide: false, pushed: true, notified: [],
    features: [{ id: "funding_z90", value: 2.6, histMin: -2, histMax: 2.5, p1: -1.8, p99: 2.2, bars: 400, pctRank: 100 }] } as NoveltyEntry;
  const routes = researchRoutes({
    cache,
    runStudy: createStudyRunner({ cache, eventStudy, now: () => NOW }),
    deadlineMs: () => deadline,
    isGuest: () => guest,
    catalogueId,
    board: () => ({
      now: () => NOW,
      pulse: async () => { throw new Error("lab store down"); },
      novelty: async () => [nov],
      opportunities: async () => { throw new SourceUnavailable("platform offline (no worker loop and no database)"); },
      radarCalls: async () => [radarCall],
    }),
  });
  return new Hono().route("/research", routes);
}

describe("/research routes", () => {
  test("GET /board as a guest: the radar is `sign in required` and contributes no signals", async () => {
    const user = BoardResponseSchema.parse(await (await app(async () => fakeStudy()).request("/research/board")).json());
    expect(user.sources.radar).toMatchObject({ state: "ok", count: 1 });
    const guest = BoardResponseSchema.parse(await (await app(async () => fakeStudy(), 50_000, true).request("/research/board")).json());
    expect(guest.sources.radar).toEqual({ state: "unavailable", reason: "sign in required", count: 0, dropped: 0 });
    expect(guest.signals.some((s) => s.source === "radar")).toBe(false);
  });

  test("GET /board: parsed shape; failing sources listed; a study run via POST shows up as evidence", async () => {
    const calls: unknown[] = [];
    const a = app(async (args, ctx) => (calls.push({ args, ctx }), fakeStudy()));
    const before = BoardResponseSchema.parse(await (await a.request("/research/board")).json());
    expect(before.sources).toMatchObject({ rule: { state: "unavailable", reason: "source failed (see server log)" }, opportunity: { state: "unavailable", reason: "platform offline (no worker loop and no database)" }, novelty: { state: "ok", count: 1 }, radar: { state: "ok", count: 1 } });
    const s = before.signals[0]!;
    expect(s).toMatchObject({ source: "novelty", scope: "universe", evidence: null });

    const res = await a.request("/research/study", post(boardStudy(s)));
    expect(res.status).toBe(200);
    const body = StudyResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ cached: false, studyId: studyKey({ rule: s.rule!, stopAtr: 1.5, targetAtr: 3 }, NOW), summary: { verdict: "clear", events: 120 } });
    expect(calls).toEqual([{ args: { rule: s.rule, stopAtr: 1.5, targetAtr: 3 }, ctx: { source: "ui", deadlineMs: 50_000 } }]);

    const after = BoardResponseSchema.parse(await (await a.request("/research/board")).json());
    expect(after.signals[0]!.evidence).toEqual(body.summary);
    expect((await (await a.request("/research/study", post(boardStudy(s)))).json()).cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("POST /study: bad input is a 400 before any run; Lab errors map to 400/502/500", async () => {
    let err: Error = new Error("x");
    const a = app(async () => { throw err; });
    expect((await a.request("/research/study", post("{nope"))).status).toBe(400);
    const bad = await a.request("/research/study", post({ rule: { ...rule, horizonDays: 0 } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "rule.horizonDays" });
    expect((await a.request("/research/study", post({ rule, extra: 1 }))).status).toBe(400);
    expect((await a.request("/research/study", post({ rule, coin: "BT-C" }))).status).toBe(400);
    err = new ToolInputError("unknown metric", "rule.conditions.0.feature");
    const r400 = await a.request("/research/study", post({ rule }));
    expect([r400.status, await r400.json()]).toEqual([400, { error: "unknown metric", field: "rule.conditions.0.feature" }]);
    err = new UpstreamError("HL down");
    expect((await a.request("/research/study", post({ rule }))).status).toBe(502);
    err = new Error("boom");
    expect((await a.request("/research/study", post({ rule }))).status).toBe(500);
  });

  test("POST /study goes through the lab_event_study tool: same trial log entry as a direct tool call", async () => {
    const base = synthetic({ seed: 1, drift: 0.012 });
    const c = base.price;
    const o = c.map((_, i) => c[Math.max(0, i - 1)]!);
    const all: Record<string, number[]> = { ...base.metrics, "ht:open": o, "ht:high": c.map((x, i) => Math.max(x, o[i]!) * 1.01), "ht:low": c.map((x, i) => Math.min(x, o[i]!) * 0.99), "ht:funding": c.map(() => 0.0001) };
    const syn: LabProvider = { id: "syn", name: "syn", notes: "", fetch: async () => ({ t: [], v: [] }),
      metrics: () => ["a", "b"].map((k) => ({ id: `syn:${k}`, provider: "syn", key: k, name: k, category: "onchain" as const, scope: "asset" as const, description: k, lagDays: 0 })) };
    const store = memoryStore(() => new Date(base.t[0]! + 2000 * DAY_MS));
    const service = createLabService({
      store, providers: [syn], now: () => NOW, hasDb: () => false, perpUniverse: async () => ["SYN"],
      loadDataset: async (cfg) => ({ dataset: { ...base, asset: cfg.asset, metrics: Object.fromEntries(cfg.metrics.map((m) => [m, all[m]!])) }, warnings: [] }),
    });
    const planted: Rule = { asset: "SYN", direction: "long", horizonDays: 2, conditions: [{ feature: "syn:a|z|30", op: "<", threshold: -1 }] };
    const tools = () => labTools(service);
    const direct = (await tools().find((t) => t.name === "lab_event_study")!.run({ rule: planted, stopAtr: 1.5, targetAtr: 3, coins: ["SYN"] }, { source: "api" })) as { verdict: string; screen: unknown };

    const res = await app(toolEventStudy(tools)).request("/research/study", post({ rule: planted, coin: "SYN" }));
    expect(res.status).toBe(200);
    const body = StudyResponseSchema.parse(await res.json());
    const trials = await store.listTrials();
    expect(trials.map((t) => [t.n, t.ruleId, t.intent, t.verdict])).toEqual([
      [1, ruleId(planted), "lab_event_study", direct.verdict],
      [2, ruleId(planted), "lab_event_study", body.summary.verdict],
    ]);
    expect(body.summary.idea).toEqual({ n: 2, of: 2 });
    expect(body.study.screen).toEqual(direct.screen as never);
  });

  test("catalogueId: null until the rule is saved, then its catalogue id, live on a cached study and on the direct tool", async () => {
    const base = synthetic({ seed: 2, drift: 0.01 });
    const c = base.price;
    const all: Record<string, number[]> = { ...base.metrics, "ht:open": c, "ht:high": c.map((x) => x * 1.01), "ht:low": c.map((x) => x * 0.99), "ht:funding": c.map(() => 0.0001) };
    const syn: LabProvider = { id: "syn", name: "syn", notes: "", fetch: async () => ({ t: [], v: [] }),
      metrics: () => ["a", "b"].map((k) => ({ id: `syn:${k}`, provider: "syn", key: k, name: k, category: "onchain" as const, scope: "asset" as const, description: k, lagDays: 0 })) };
    const store = memoryStore(() => new Date(base.t[0]! + 2000 * DAY_MS));
    const service = createLabService({
      store, providers: [syn], now: () => NOW, hasDb: () => false, perpUniverse: async () => ["SYN"],
      loadDataset: async (cfg) => ({ dataset: { ...base, asset: cfg.asset, metrics: Object.fromEntries(cfg.metrics.map((m) => [m, all[m]!])) }, warnings: [] }),
    });
    const planted: Rule = { asset: "SYN", direction: "long", horizonDays: 2, conditions: [{ feature: "syn:a|z|30", op: "<", threshold: -1 }] };
    const tools = () => labTools(service);
    const direct = () => tools().find((t) => t.name === "lab_event_study")!.run({ rule: planted, stopAtr: 1.5, targetAtr: 3, coins: ["SYN"] }, { source: "api" }) as Promise<{ catalogueId: string | null }>;
    const a = app(toolEventStudy(tools), 50_000, false, catalogueIdOf(store));
    const study = async () => StudyResponseSchema.parse(await (await a.request("/research/study", post({ rule: planted, coin: "SYN" }))).json());

    const first = await study();
    expect([first.cached, first.catalogueId, first.study.catalogueId]).toEqual([false, null, null]);
    expect((await direct()).catalogueId).toBeNull();

    const saved = await service.catalogueSave({ rule: planted, name: "planted" });
    const again = await study();
    expect([again.cached, again.catalogueId, again.study.catalogueId]).toEqual([true, saved.id, saved.id]);
    expect((await direct()).catalogueId).toBe(saved.id);
    // A failing lookup answers null; the study still answers.
    const down = app(toolEventStudy(tools), 50_000, false, async () => { throw new Error("db down"); });
    expect((await (await down.request("/research/study", post({ rule: planted, coin: "SYN" }))).json()).catalogueId).toBeNull();
  });
});

describe("/radar route", () => {
  const radar = (dir: string) => new Hono().route("/radar", radarRoutes(() => readRadar(dir)));
  test("fixture dir → ok with note, calls and scorecard", async () => {
    const res = await radar(join(import.meta.dir, "../research/fixtures/radar")).request("/radar");
    expect(res.status).toBe(200);
    const r = RadarResponseSchema.parse(await res.json());
    expect(r.state).toBe("ok");
    expect(r.latestNote?.date).toBe("2026-11-01");
    expect(r.calls).toHaveLength(2);
    expect(r.scorecard.map((x) => x.stance)).toEqual(["ride", "fade"]);
  });

  test("missing dir → 200 unavailable with the reason", async () => {
    const res = await radar("/nonexistent/data/radar").request("/radar");
    expect(res.status).toBe(200);
    const r = RadarResponseSchema.parse(await res.json());
    expect(r).toMatchObject({ state: "unavailable", latestNote: null, calls: [], scorecard: [] });
    expect(r.reason).toBe("radar files not deployed");
    expect(JSON.stringify(r)).not.toContain("nonexistent");
  });
});
