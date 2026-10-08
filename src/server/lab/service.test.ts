import { describe, expect, test } from "bun:test";
import { ToolInputError, UpstreamError } from "../mcp/types.js";
import { evaluateRule, ruleId, verdictOf } from "./engine/index.js";
import { synthetic } from "./engine/testkit.js";
import type { LoadConfig } from "./providers/registry.js";
import { createLabService, SEARCH_FINISH_MS, type LabServiceDeps } from "./service.js";
import { memoryStore, type LabStore } from "./store.js";
import { DAY_MS, RuleSchema, type LabProvider, type MetricDef, type Rule } from "./types.js";

const base = synthetic({ seed: 1, drift: 0.012 });
const T0 = base.t[0]!;
const day = (i: number) => new Date(T0 + i * DAY_MS).toISOString();

const synMetric = (key: string): MetricDef => ({
  id: `syn:${key}`,
  provider: "syn",
  key,
  name: key,
  category: "onchain",
  scope: "asset",
  description: `synthetic ${key}`,
  lagDays: 0,
});
const synProvider: LabProvider = {
  id: "syn",
  name: "Synthetic",
  notes: "test data",
  metrics: () => ["a", "b", "c", "d", "e"].map(synMetric), // syn:e has no data
  fetch: async () => ({ t: [], v: [] }),
};

function kit(over: Partial<LabServiceDeps> = {}) {
  const loads: LoadConfig[] = [];
  const store = over.store ?? memoryStore(() => new Date(day(2000)));
  const service = createLabService({
    store,
    providers: [synProvider],
    now: () => T0 + 2500 * DAY_MS,
    async loadDataset(cfg) {
      loads.push(cfg);
      if (cfg.asset === "FAIL") throw new Error("upstream down");
      const metrics = Object.fromEntries(cfg.metrics.filter((m) => base.metrics[m]).map((m) => [m, base.metrics[m]!]));
      const warnings = cfg.metrics.filter((m) => !base.metrics[m]).map((m) => `${m}: no data for ${cfg.asset} in range; dropped`);
      return { dataset: { ...base, asset: cfg.asset, metrics }, warnings };
    },
    ...over,
  });
  return { service, store, loads };
}

const planted: Rule = {
  asset: "SYN",
  direction: "long",
  horizonDays: 2,
  conditions: [
    { feature: "syn:a|z|30", op: "<", threshold: -1 },
    { feature: "syn:b|raw|0", op: ">=", threshold: 0 },
  ],
};
const always = (asset: string, direction: "long" | "short", k = 0): Rule => ({
  asset,
  direction,
  horizonDays: 2,
  conditions: [{ feature: "syn:c|raw|0", op: ">=", threshold: -1e9 - k }],
});
const never = (asset: string, direction: "long" | "short"): Rule => ({
  asset,
  direction,
  horizonDays: 2,
  conditions: [{ feature: "syn:c|raw|0", op: "<", threshold: -1e9 }],
});

const searchCfg = { asset: "SYN", metrics: ["syn:a", "syn:b", "syn:e"], transforms: ["raw", "z"], windows: [30], horizonDays: 2, trials: 4 };

async function inputError(p: Promise<unknown>): Promise<ToolInputError> {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ToolInputError);
  return err as ToolInputError;
}

/** Saves a rule straight into the store with an engine evaluation (holdout Sharpe optionally overridden). */
async function seed(store: LabStore, rule: Rule, name: string, holdoutSharpe?: number) {
  const saved = evaluateRule(rule, { ...base, asset: rule.asset }, { slippageBps: 10 });
  if (holdoutSharpe !== undefined) saved.holdout = { ...saved.holdout!, sharpe: holdoutSharpe };
  return store.saveCatalogueEntry({ id: ruleId(rule), name, note: null, origin: "user", runId: null, rule, saved, savedAt: day(2000) });
}

describe("lab service: providers and metrics", () => {
  test("lists providers with metric counts, and filtered metrics", () => {
    const { service } = kit();
    expect(service.listProviders()).toEqual({ providers: [{ id: "syn", name: "Synthetic", notes: "test data", metrics: 5 }] });
    expect(service.listMetrics({ provider: "syn" }).metrics.length).toBe(5);
    expect(service.listMetrics({ category: "sentiment" }).metrics).toEqual([]);
  });
});

describe("lab service: search", () => {
  test("loads the dataset as configured, merges loader warnings, persists an ok run", async () => {
    const { service, store, loads } = kit();
    const { runId, result } = await service.search({ ...searchCfg, from: "2018-01-01", to: "2024-01-01" }, { source: "cli" });
    expect(loads[0]).toEqual({ asset: "SYN", metrics: ["syn:a", "syn:b", "syn:e"], price: undefined, from: "2018-01-01", to: "2024-01-01" });
    expect(result.warnings[0]).toBe("syn:e: no data for SYN in range; dropped");
    expect(result.warnings).toContain("metric syn:e has no data for SYN; skipped");
    expect(result.rules.length).toBeGreaterThan(0);
    expect(runId).not.toBeNull();
    const run = await store.getRun(runId!);
    expect(run).toMatchObject({ status: "ok", source: "cli", error: null });
    expect(run!.config.trials).toBe(4);
    expect(run!.result!.rules.length).toBe(result.rules.length);
  }, 20_000);

  test("bad config → ToolInputError with the field path; nothing persisted", async () => {
    const { service, store } = kit();
    expect((await inputError(service.search({ ...searchCfg, horizonDays: 999 }, { source: "api" }))).field).toBe("horizonDays");
    expect((await inputError(service.search({ ...searchCfg, metrics: ["syn:a", "nope:x"] }, { source: "api" }))).field).toBe("metrics.1");
    expect((await inputError(service.search({ ...searchCfg, price: "nope:p" }, { source: "api" }))).field).toBe("price");
    expect((await inputError(service.search({ ...searchCfg, asset: "BTC&x=1" }, { source: "api" }))).field).toBe("asset");
    expect((await inputError(service.search({ ...searchCfg, from: "2023-02-30" }, { source: "api" }))).field).toBe("from");
    expect(await store.listRuns(10)).toEqual([]);
  });

  test("load failure → error run persisted, error rethrown as is", async () => {
    const { service, store } = kit();
    await expect(service.search({ ...searchCfg, asset: "FAIL" }, { source: "mcp" })).rejects.toThrow("upstream down");
    const runs = await store.listRuns(10);
    expect(runs.map((r) => [r.status, r.source, r.asset, r.error])).toEqual([["error", "mcp", "FAIL", "upstream down"]]);
  });

  test("engine refusals → ToolInputError with a field; nothing persisted", async () => {
    const { service, store } = kit();
    const short = await inputError(service.search({ ...searchCfg, from: "2024-06-01" }, { source: "mcp" }));
    expect([short.field, short.message]).toEqual(["from", expect.stringMatching(/at least 365/)]);
    expect((await inputError(service.search({ ...searchCfg, folds: 6, horizonDays: 180, from: "2022-09-01" }, { source: "mcp" }))).field).toBe("folds");
    expect((await inputError(service.search({ ...searchCfg, metrics: ["syn:e"] }, { source: "mcp" }))).field).toBe("metrics");
    expect(await store.listRuns(10)).toEqual([]);
  });

  test("too many features → ToolInputError before any data is loaded", async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const wide: LabProvider = { ...synProvider, metrics: () => keys.map(synMetric) };
    const { service, loads } = kit({ providers: [wide] });
    // 20 metrics × (raw + 6 transforms × 6 windows) = 740 features
    const err = await inputError(service.search({ asset: "SYN", metrics: keys.map((k) => `syn:${k}`), windows: [7, 14, 30, 60, 90, 180] }, { source: "api" }));
    expect([err.field, err.message]).toEqual(["metrics", expect.stringContaining("740 features")]);
    expect(loads).toEqual([]);
  });

  test("a deadline: providers are told, and the refit margin comes off the trial budget", async () => {
    const { service, loads } = kit();
    const { result } = await service.search(searchCfg, { source: "mcp", deadlineMs: SEARCH_FINISH_MS });
    expect(loads[0]!.deadline).toBe(true);
    expect(result.trialsRun).toBe(1);
    expect(result.warnings).toContain("deadline of 1 ms reached after 1 of 4 trials; results use the completed trials");
    await service.search(searchCfg, { source: "cli" });
    expect(loads[1]!.deadline).toBeUndefined();
  }, 20_000);

  test("a store failure does not fail the search: runId null plus a warning", async () => {
    const store: LabStore = {
      ...memoryStore(),
      saveRun: async () => {
        throw new Error("db down");
      },
    };
    const { service } = kit({ store });
    const { runId, result } = await service.search(searchCfg, { source: "api" });
    expect(runId).toBeNull();
    expect(result.warnings).toContain("run not saved: db down");
  }, 20_000);
});

describe("lab service: runs", () => {
  test("getRun by id, unknown id → ToolInputError(id); listRuns", async () => {
    const { service } = kit();
    const { runId } = await service.search(searchCfg, { source: "api" });
    expect((await service.getRun(runId!)).id).toBe(runId!);
    expect((await inputError(service.getRun("00000000-0000-4000-8000-000000000000"))).field).toBe("id");
    expect((await service.listRuns(5)).runs.map((r) => r.id)).toEqual([runId!]);
  }, 20_000);
});

describe("lab service: evaluate and sensitivity", () => {
  test("loads the rule's metrics over full history and scores it", async () => {
    const { service, loads } = kit();
    const ev = await service.evaluateRule({ rule: planted, includeEquity: true, sensitivity: true, to: "2024-06-01" });
    expect(loads[0]).toEqual({ asset: "SYN", metrics: ["syn:a", "syn:b"], price: undefined, to: "2024-06-01" });
    expect(ev.id).toBe(ruleId(planted));
    expect(ev.inSample.sharpe).toBeGreaterThan(1);
    expect(ev.equity!.length).toBeGreaterThan(2000);
    // z(30) swaps to the default neighbours 7 and 90
    expect(ev.sensitivity!.points.filter((p) => p.kind === "window").map((p) => p.shift)).toEqual([7, 90]);
    const plain = await service.evaluateRule({ rule: planted });
    expect(plain.sensitivity).toBeUndefined();
    expect(plain.equity).toBeUndefined();
  });

  test("sensitivity returns the grid, honouring windows", async () => {
    const { service } = kit();
    const s = await service.sensitivity({ rule: planted, windows: [30, 60] });
    expect(s.points.filter((p) => p.kind === "window").map((p) => p.shift)).toEqual([60]);
    expect(s.stability).toBeGreaterThanOrEqual(0);
  });

  test("bad features and metrics → ToolInputError naming the condition", async () => {
    const { service } = kit();
    const bad = (feature: string) => ({ ...planted, conditions: [planted.conditions[0]!, { ...planted.conditions[1]!, feature }] });
    expect((await inputError(service.evaluateRule({ rule: bad("syn:b|zz|3") }))).field).toBe("rule.conditions.1.feature");
    expect((await inputError(service.evaluateRule({ rule: bad("nope:b|raw|0") }))).field).toBe("rule.conditions.1.feature");
    expect((await inputError(service.evaluateRule({ rule: { ...planted, horizonDays: 0 } }))).field).toBe("rule.horizonDays");
    expect((await inputError(service.evaluateRule({ rule: { ...planted, asset: "../btc" } }))).field).toBe("rule.asset");
    expect(RuleSchema.safeParse({ ...planted, asset: "kPEPE" }).success).toBe(true);
    const missing = await service.evaluateRule({ rule: bad("syn:e|raw|0") }).catch((e) => e);
    expect(missing).toBeInstanceOf(UpstreamError);
    expect(missing.message).toMatch(/no data for syn:e/);
    expect((await inputError(service.evaluateRule({ rule: planted, from: "2024-11-01" }))).field).toBe("from");
  });
});

describe("lab service: catalogue", () => {
  test("save evaluates the rule under its id; list adds live stats since savedAt", async () => {
    const { service } = kit();
    const entry = await service.catalogueSave({ rule: planted, name: "planted", note: "test" });
    expect(entry).toMatchObject({ id: ruleId(planted), name: "planted", note: "test", origin: "user", runId: null, savedAt: day(2000) });
    expect(entry.saved.id).toBe(entry.id);
    expect(entry.saved.equity).toBeUndefined();
    expect(entry.saved.sensitivity).toBeDefined();

    const { entries } = await service.catalogueList({});
    expect(entries.length).toBe(1);
    expect(entries[0]!.live!.days).toBeGreaterThan(400);
    expect(entries[0]!.live!.sharpe).toBeGreaterThan(0);
    expect(entries[0]!.flags).toEqual([]);

    const cheap = await service.catalogueList({ live: false });
    expect(cheap.entries[0]).toMatchObject({ id: entry.id, live: null, flags: [] });
    expect((await service.catalogueList({ asset: "syn", direction: "short" })).entries).toEqual([]);
    expect((await service.catalogueList({ asset: "syn" })).entries.length).toBe(1);

    expect(await service.catalogueRemove(entry.id)).toEqual({ removed: true });
    expect(await service.catalogueRemove(entry.id)).toEqual({ removed: false });
    expect((await service.catalogueList({})).entries).toEqual([]);
  });

  test("save rejects a malformed rule and an unknown runId", async () => {
    const { service, loads } = kit();
    expect((await inputError(service.catalogueSave({ rule: { ...planted, conditions: [] }, name: "x" }))).field).toBe("rule.conditions");
    expect((await inputError(service.catalogueSave({ rule: planted, name: "x", runId: "00000000-0000-4000-8000-000000000000" }))).field).toBe("runId");
    expect(loads).toEqual([]);
  });

  test("save with a known runId links it; re-saving skips re-evaluation and keeps the original", async () => {
    const { service, loads } = kit();
    const { runId } = await service.search(searchCfg, { source: "api" });
    const first = await service.catalogueSave({ rule: planted, name: "planted", runId: runId! });
    expect(first.runId).toBe(runId);
    const loadsAfterFirst = loads.length;
    const again = await service.catalogueSave({ rule: planted, name: "renamed", note: "n" });
    expect(loads.length).toBe(loadsAfterFirst);
    expect(again).toMatchObject({ id: first.id, name: "renamed", note: "n", runId, savedAt: first.savedAt });
    expect(again.saved).toEqual(first.saved);
  }, 20_000);

  test("save from a run carries the search's walk-forward onto the entry; without a run it is the rule's own", async () => {
    const { service } = kit();
    const { runId, result } = await service.search(searchCfg, { source: "api" });
    const found = result.rules.find((r) => r.walkForward);
    expect(found).toBeDefined();
    const entry = await service.catalogueSave({ rule: found!.rule, name: "from run", runId: runId! });
    expect(entry.saved.walkForward).toEqual(found!.walkForward);
    for (const k of ["walkForwardFolds", "deflatedSharpe"]) if (k in found!) expect((entry.saved as any)[k]).toEqual((found as any)[k]);
    expect(entry.saved.sensitivity).toBeDefined(); // the rest is the fresh evaluation
    const bare = await kit().service.catalogueSave({ rule: found!.rule, name: "bare" });
    // An explicit evaluation refits the rule per fold itself, deflated with N = 1.
    expect(bare.saved.walkForward).not.toBeNull();
    expect(bare.saved.deflatedSharpe).not.toBe(found!.deflatedSharpe);
  }, 20_000);

  test("save from a run deflates by the run's effectiveTrials and recomputes the verdict on the carried-over fields", async () => {
    const { service } = kit();
    const { runId, result } = await service.search(searchCfg, { source: "api" });
    expect(result.effectiveTrials).toBeGreaterThanOrEqual(1);
    expect(result.effectiveTrials!).toBeLessThanOrEqual(result.variantsScored!);
    const found = result.rules[0]!;
    expect(found.verdict).toBeDefined();
    const entry = await service.catalogueSave({ rule: found.rule, name: "from run", runId: runId! });
    expect(entry.saved.deflatedSharpe).toBe(found.deflatedSharpe);
    expect(entry.saved.verdict).toEqual(verdictOf(entry.saved));
    // A rule the run did not return (hand-edited) keeps its own walk-forward, deflated for the run's search.
    const edited: Rule = { ...planted, conditions: [{ ...planted.conditions[0]!, threshold: -1.07 }, planted.conditions[1]!] };
    const own = await service.catalogueSave({ rule: edited, name: "edited", runId: runId! });
    const ds = { ...base, metrics: { "syn:a": base.metrics["syn:a"]!, "syn:b": base.metrics["syn:b"]! } };
    expect(own.saved.deflatedSharpe).toBeCloseTo(evaluateRule(edited, ds, { slippageBps: 10, trials: result.effectiveTrials }).deflatedSharpe!, 12);
    expect(own.saved.deflatedSharpe!).toBeLessThan(evaluateRule(edited, ds, { slippageBps: 10 }).deflatedSharpe!);
  }, 20_000);

  test("entries and runs stored before verdicts get one on read", async () => {
    const { service, store } = kit();
    const { verdict: _drop, ...bare } = evaluateRule(planted, base, { slippageBps: 10 });
    const old = await store.saveCatalogueEntry({ id: ruleId(planted), name: "old", note: null, origin: "user", runId: null, rule: planted, saved: bare, savedAt: day(2000) });
    expect((await store.getCatalogueEntry(old.id))!.saved.verdict).toBeUndefined();
    const [listed] = (await service.catalogueList({ live: false })).entries;
    expect(listed!.saved.verdict).toEqual(verdictOf(bare));
    const resaved = await service.catalogueSave({ rule: planted, name: "renamed" });
    expect(resaved.saved.verdict).toEqual(listed!.saved.verdict);

    const { runId, result } = await service.search(searchCfg, { source: "api" });
    const stripped = { ...result, rules: result.rules.map(({ verdict: _v, ...r }) => r) };
    const stored = await store.saveRun({ source: "api", config: result.config, status: "ok", error: null, result: stripped as typeof result, durationMs: 1 });
    expect((await service.getRun(stored.id)).result!.rules.map((r) => r.verdict)).toEqual(result.rules.map((r) => r.verdict));
    expect((await service.getRun(runId!)).result!.rules).toEqual(result.rules);
  }, 20_000);

  test("health: decay, same-asset overlap, gaps, live map; list carries the flags", async () => {
    const { service, store, loads } = kit();
    const good = await seed(store, planted, "planted");
    const decayed = await seed(store, { ...planted, horizonDays: 3 }, "too good to last", 100);
    const twin = await seed(store, { ...planted, conditions: [{ ...planted.conditions[0]!, threshold: -1.02 }, planted.conditions[1]!] }, "twin");
    const other = await seed(store, { ...planted, asset: "OTHER" }, "other asset");
    const short = await seed(store, never("SYN", "short"), "short");

    const h = await service.catalogueHealth();
    expect(h.decayed.map((d) => d.id)).toEqual([decayed.id]);
    expect(h.decayed[0]).toMatchObject({ name: "too good to last", holdoutSharpe: 100 });
    expect(h.decayed[0]!.liveDays).toBeGreaterThanOrEqual(30);
    // planted, its horizon-3 copy and the twin share almost all in-zone days; OTHER is another asset
    const pairs = h.overlaps.map((o) => [o.a, o.b].sort().join("+"));
    expect(pairs.sort()).toEqual([[good.id, decayed.id], [good.id, twin.id], [decayed.id, twin.id]].map((p) => p.sort().join("+")).sort());
    expect(h.overlaps.every((o) => o.jaccard >= 0.6 && o.jaccard <= 1)).toBe(true);
    expect(h.gaps).toEqual([{ asset: "OTHER", direction: "short" }]);
    expect(Object.keys(h.live).sort()).toEqual([good.id, decayed.id, twin.id, other.id, short.id].sort());
    expect(h.live[short.id]!.exposure).toBe(0);
    // one load per (asset, price) group
    expect(loads.map((l) => l.asset).sort()).toEqual(["OTHER", "SYN"]);

    const { entries } = await service.catalogueList({ asset: "SYN", direction: "long" });
    const flags = Object.fromEntries(entries.map((e) => [e.name, e.flags]));
    expect(flags).toEqual({ planted: ["overlap"], "too good to last": ["decayed", "overlap"], twin: ["overlap"] });
  });

  test("overlap needs the same direction: a mirrored rule is not a duplicate", async () => {
    const { service, store } = kit();
    await seed(store, planted, "planted");
    await seed(store, { ...planted, direction: "short" }, "mirror");
    expect((await service.catalogueHealth()).overlaps).toEqual([]);
  });

  test("health tolerates entries whose data cannot load", async () => {
    const { service, store } = kit();
    const ok = await seed(store, always("SYN", "long"), "ok");
    const failing = await seed(store, always("FAIL", "long"), "failing");
    const h = await service.catalogueHealth();
    expect(h.live[ok.id]).not.toBeNull();
    expect(h.live[failing.id]).toBeNull();
    const { entries } = await service.catalogueList({});
    expect(entries.find((e) => e.id === failing.id)).toMatchObject({ live: null, flags: [] });
  });
});

describe("lab service: market pulse", () => {
  test("counts firing rules per asset and computes the lean; unloadable rules become warnings", async () => {
    const { service, store } = kit();
    await seed(store, always("SYN", "long", 1), "long a");
    await seed(store, always("SYN", "long", 2), "long b");
    await seed(store, never("SYN", "long"), "long off");
    await seed(store, always("SYN", "short"), "short on");
    await seed(store, always("OTHER", "short"), "other short");
    await seed(store, always("FAIL", "long"), "unreachable");

    const p = await service.marketPulse();
    expect(p.asOf).toBe(new Date(T0 + 2500 * DAY_MS).toISOString());
    expect(p.assets.map((a) => a.asset)).toEqual(["OTHER", "SYN"]);
    const syn = p.assets[1]!;
    expect(syn).toMatchObject({ longActive: 2, longTotal: 3, shortActive: 1, shortTotal: 1, lean: 0.25 });
    expect(syn.rules.find((r) => r.name === "long off")).toMatchObject({ direction: "long", firing: false, text: "syn:c raw < -1e+9" });
    expect(p.assets[0]).toMatchObject({ longTotal: 0, shortActive: 1, shortTotal: 1, lean: -1 });
    expect(p.warnings.length).toBe(1);
    expect(p.warnings[0]).toContain("unreachable");
    expect(p.warnings[0]).toContain("upstream down");

    const only = await service.marketPulse({ asset: "other" });
    expect(only.assets.map((a) => a.asset)).toEqual(["OTHER"]);
    expect(only.warnings).toEqual([]);
  });
});
