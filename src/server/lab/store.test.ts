import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultStore,
  fileStore,
  LOCAL_RUN_CAP,
  localLabFile,
  memoryStore,
  pgStore,
  summarize,
  toCatalogueEntry,
  toRunSummary,
  toStoredRun,
  type LabStore,
  type NewRun,
} from "./store.js";
import type { PerfStats, RuleEvaluation, SearchConfig, SearchResult } from "./types.js";
import { SearchConfigSchema } from "./types.js";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "lab-store-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const stats = (sharpe: number): PerfStats => ({
  from: "2022-01-01",
  to: "2024-01-01",
  days: 730,
  totalReturn: 0.2,
  cagr: 0.1,
  sharpe,
  maxDrawdown: -0.1,
  hitRate: 0.6,
  trades: 20,
  tradesPerYear: 10,
  exposure: 0.3,
});

const evaluation = (id: string, asset = "BTC", direction: "long" | "short" = "long", wf: number | null = 1.5): RuleEvaluation => ({
  id,
  rule: { asset, direction, horizonDays: 14, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1 }] },
  text: "ht:funding z(30) < -1",
  precision: 0.6,
  support: 40,
  inSample: stats(0.9),
  walkForward: wf == null ? null : stats(wf),
  holdout: stats(0.8),
  benchmark: { inSample: stats(0.5), holdout: null },
  firingNow: false,
  latest: { date: "2024-01-01", values: { "ht:funding|z|30": -0.5 } },
});

const config = (asset = "BTC"): SearchConfig => SearchConfigSchema.parse({ asset, metrics: ["ht:funding", "cm:CapMVRVCur"] });

const result = (cfg: SearchConfig, rules: RuleEvaluation[]): SearchResult => ({
  config: cfg,
  dataRange: { from: "2020-01-01", to: "2024-01-01", days: 1461, holdoutFrom: "2023-06-01" },
  featureCount: 12,
  trialsRun: 5,
  bestTrial: null,
  trials: [],
  rules,
  featureImportance: [],
  warnings: [],
  durationMs: 100,
});

const okRun = (asset = "BTC", rules = [evaluation("r1")]): NewRun => {
  const cfg = config(asset);
  return { source: "api", config: cfg, status: "ok", error: null, result: result(cfg, rules), durationMs: 100 };
};

const entry = (id: string, asset = "BTC", direction: "long" | "short" = "long", savedAt?: string) => {
  const saved = evaluation(id, asset, direction);
  return { id, name: `rule ${id}`, note: null, origin: "user" as const, runId: null, rule: saved.rule, saved, savedAt };
};

/** A clock that ticks one second per call. */
const ticking = (start = Date.parse("2025-01-01T00:00:00Z")) => {
  let t = start;
  return () => new Date((t += 1000));
};

function behaves(name: string, make: () => Promise<LabStore>) {
  describe(name, () => {
    test("saves and reads runs back", async () => {
      const s = await make();
      const run = await s.saveRun(okRun());
      expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(run.createdAt).toMatch(/Z$/);
      const got = await s.getRun(run.id);
      expect(got).toEqual(run);
      expect(await s.getRun("not-a-uuid")).toBeNull();
      expect(await s.getRun(crypto.randomUUID())).toBeNull();
    });

    test("lists run summaries newest first with limit", async () => {
      const s = await make();
      const a = await s.saveRun(okRun("BTC"));
      const b = await s.saveRun({ source: "mcp", config: config("ETH"), status: "error", error: "boom", result: null, durationMs: 5 });
      const c = await s.saveRun(okRun("SOL", [evaluation("x", "SOL", "long", null), evaluation("y")]));
      const list = await s.listRuns(10);
      expect(list.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
      // Top rule has no walk-forward: no in-sample stand-in under the WF column.
      expect(list[0]).toMatchObject({ asset: "SOL", direction: "long", horizonDays: 14, metrics: 2, rules: 2, bestSharpe: null, status: "ok" });
      expect(list[1]).toMatchObject({ asset: "ETH", rules: 0, bestSharpe: null, status: "error", error: "boom", source: "mcp" });
      expect(list[2]!.bestSharpe).toBe(1.5);
      expect((await s.listRuns(2)).map((r) => r.id)).toEqual([c.id, b.id]);
      expect(await s.listRuns(0)).toEqual([]);
    });

    test("catalogue: save, get, filters, newest first", async () => {
      const s = await make();
      await s.saveCatalogueEntry(entry("a", "BTC", "long", "2024-01-01T00:00:00.000Z"));
      await s.saveCatalogueEntry(entry("b", "ETH", "short", "2024-03-01T00:00:00.000Z"));
      await s.saveCatalogueEntry(entry("c", "BTC", "short", "2024-02-01T00:00:00.000Z"));
      expect((await s.listCatalogue()).map((e) => e.id)).toEqual(["b", "c", "a"]);
      expect((await s.listCatalogue({ asset: "BTC" })).map((e) => e.id)).toEqual(["c", "a"]);
      expect((await s.listCatalogue({ direction: "short" })).map((e) => e.id)).toEqual(["b", "c"]);
      expect((await s.listCatalogue({ asset: "BTC", direction: "long" })).map((e) => e.id)).toEqual(["a"]);
      const got = await s.getCatalogueEntry("b");
      expect(got).toMatchObject({ id: "b", name: "rule b", savedAt: "2024-03-01T00:00:00.000Z", origin: "user" });
      expect(got!.saved.rule.asset).toBe("ETH");
      expect(await s.getCatalogueEntry("nope")).toBeNull();
    });

    test("re-saving keeps savedAt and evaluation, updates name/note", async () => {
      const s = await make();
      const first = await s.saveCatalogueEntry(entry("k"));
      const again = await s.saveCatalogueEntry({
        ...entry("k"),
        name: "renamed",
        note: "why",
        saved: evaluation("k", "BTC", "long", 9),
        savedAt: "2030-01-01T00:00:00.000Z",
      });
      expect(again.savedAt).toBe(first.savedAt);
      expect(again).toMatchObject({ name: "renamed", note: "why" });
      expect(again.saved.walkForward!.sharpe).toBe(1.5);
      expect(await s.getCatalogueEntry("k")).toEqual(again);
      expect(await s.listCatalogue()).toHaveLength(1);
    });

    test("archive hides an entry; re-saving restores it with its savedAt", async () => {
      const s = await make();
      const first = await s.saveCatalogueEntry(entry("z"));
      await s.saveCatalogueEntry(entry("y"));
      expect(await s.archiveCatalogueEntry("z")).toBe(true);
      expect(await s.archiveCatalogueEntry("z")).toBe(false);
      expect(await s.archiveCatalogueEntry("missing")).toBe(false);
      expect((await s.listCatalogue()).map((e) => e.id)).toEqual(["y"]);
      expect(await s.getCatalogueEntry("z")).toBeNull();
      const back = await s.saveCatalogueEntry(entry("z"));
      expect(back.savedAt).toBe(first.savedAt);
      expect((await s.listCatalogue()).map((e) => e.id).sort()).toEqual(["y", "z"]);
    });

    test("rejects invalid ids at the boundary", async () => {
      const s = await make();
      await expect(s.saveCatalogueEntry({ ...entry("ok"), id: "has space" })).rejects.toThrow(/rule id/);
      await expect(s.saveCatalogueEntry({ ...entry("ok"), runId: "nope" })).rejects.toThrow(/run id/);
      await expect(s.saveCatalogueEntry({ ...entry("ok"), savedAt: "garbage" })).rejects.toThrow(/savedAt/);
    });

    test("returned objects are copies", async () => {
      const s = await make();
      const run = await s.saveRun(okRun());
      run.config.asset = "MUTATED";
      expect((await s.getRun(run.id))!.config.asset).toBe("BTC");
      const e = await s.saveCatalogueEntry(entry("m"));
      e.rule.asset = "MUTATED";
      expect((await s.getCatalogueEntry("m"))!.rule.asset).toBe("BTC");
    });
  });
}

behaves("memoryStore", async () => memoryStore(ticking()));
behaves("fileStore", async () => fileStore(join(await tmp(), "nested", "lab.json"), ticking()));

describe("memoryStore extras", () => {
  test("caps stored runs", async () => {
    const s = memoryStore(ticking());
    const first = await s.saveRun(okRun());
    for (let i = 0; i < LOCAL_RUN_CAP; i++) await s.saveRun(okRun());
    expect(await s.getRun(first.id)).toBeNull();
    expect(await s.listRuns(1000)).toHaveLength(LOCAL_RUN_CAP);
  });

  test("savedAt defaults to the clock", async () => {
    const s = memoryStore(() => new Date("2025-05-05T00:00:00Z"));
    expect((await s.saveCatalogueEntry(entry("d"))).savedAt).toBe("2025-05-05T00:00:00.000Z");
  });
});

describe("fileStore persistence", () => {
  test("survives a reopen", async () => {
    const path = join(await tmp(), "a", "b", "lab.json");
    const s1 = fileStore(path);
    expect(existsSync(path)).toBe(false);
    const run = await s1.saveRun(okRun());
    const e = await s1.saveCatalogueEntry({ ...entry("p"), runId: run.id });
    await s1.saveCatalogueEntry(entry("q"));
    await s1.archiveCatalogueEntry("q");
    const s2 = fileStore(path);
    expect(await s2.getRun(run.id)).toEqual(run);
    expect(await s2.listCatalogue()).toEqual([e]);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  test("loads lazily: a missing file reads as empty without creating it", async () => {
    const path = join(await tmp(), "lab.json");
    const s = fileStore(path);
    expect(await s.listRuns(10)).toEqual([]);
    expect(await s.listCatalogue()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("corrupt file: starts empty and keeps a .bak", async () => {
    const dir = await tmp();
    const path = join(dir, "lab.json");
    await writeFile(path, "{not json");
    const s = fileStore(path);
    expect(await s.listCatalogue()).toEqual([]);
    expect(await readFile(`${path}.bak`, "utf8")).toBe("{not json");
    await s.saveCatalogueEntry(entry("fresh"));
    expect((await fileStore(path).listCatalogue()).map((e) => e.id)).toEqual(["fresh"]);
  });

  test("wrong shape counts as corrupt", async () => {
    const path = join(await tmp(), "lab.json");
    await writeFile(path, JSON.stringify({ runs: "nope" }));
    expect(await fileStore(path).listRuns(5)).toEqual([]);
    expect(existsSync(`${path}.bak`)).toBe(true);
  });

  test("concurrent writes all land", async () => {
    const path = join(await tmp(), "lab.json");
    const s = fileStore(path);
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.saveCatalogueEntry(entry(`c${i}`))));
    expect(await fileStore(path).listCatalogue()).toHaveLength(10);
  });
});

describe("defaultStore", () => {
  test("memory singleton without DB or file env", () => {
    const a = defaultStore({});
    expect(a.kind).toBe("memory");
    expect(defaultStore({})).toBe(a);
  });

  test("LAB_STORE_FILE selects a file store", async () => {
    const path = join(await tmp(), "x.json");
    const s = defaultStore({ LAB_STORE_FILE: path });
    expect(s.kind).toBe("file");
    expect(defaultStore({ LAB_STORE_FILE: path })).toBe(s);
    await s.saveCatalogueEntry(entry("via-env"));
    expect(existsSync(path)).toBe(true);
  });

  test("LAB_LOCAL=1 selects the home file store", () => {
    expect(localLabFile()).toMatch(/\.hypertrade[\\/]lab\.json$/);
    expect(defaultStore({ LAB_LOCAL: "1" }).kind).toBe("file");
    expect(defaultStore({ LAB_LOCAL: "0" }).kind).toBe("memory");
  });

  test("a database URL selects Postgres (no connection at selection)", () => {
    expect(defaultStore({ DATABASE_URL: "postgres://u:p@localhost:5432/db", LAB_LOCAL: "1" }).kind).toBe("pg");
    expect(defaultStore({ POSTGRES_URL: "postgres://u:p@localhost:5432/db" }).kind).toBe("pg");
  });
});

describe("pg row mapping", () => {
  test("toStoredRun", () => {
    const cfg = config();
    const run = toStoredRun({
      id: "11111111-1111-4111-8111-111111111111",
      created_at: new Date("2025-01-01T00:00:00Z"),
      source: "cli",
      config: cfg,
      status: "error",
      error: "x",
      result: null,
      duration_ms: 12,
    });
    expect(run).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      createdAt: "2025-01-01T00:00:00.000Z",
      source: "cli",
      config: cfg,
      status: "error",
      error: "x",
      result: null,
      durationMs: 12,
    });
  });

  test("toRunSummary matches summarize()", () => {
    const cfg = config("ETH");
    const stored = { ...okRun("ETH", [evaluation("a", "ETH")]), id: "22222222-2222-4222-8222-222222222222", createdAt: "2025-01-01T00:00:00.000Z" };
    const row = {
      id: stored.id,
      created_at: new Date(stored.createdAt),
      source: "api",
      status: "ok",
      error: null,
      asset: "ETH",
      direction: cfg.direction,
      horizon_days: cfg.horizonDays,
      metrics: 2,
      rules: 1,
      best_sharpe: 1.5,
    };
    expect(toRunSummary(row)).toEqual(summarize(stored));
    expect(toRunSummary({ ...row, best_sharpe: null }).bestSharpe).toBeNull();
  });

  test("toCatalogueEntry", () => {
    const e = entry("h");
    expect(
      toCatalogueEntry({
        id: "h",
        name: e.name,
        note: null,
        origin: "seed",
        run_id: null,
        asset: "BTC",
        direction: "long",
        rule: e.rule,
        saved: e.saved,
        saved_at: new Date("2024-06-01T00:00:00Z"),
        archived_at: null,
      }),
    ).toEqual({ id: "h", name: e.name, note: null, origin: "seed", runId: null, rule: e.rule, saved: e.saved, savedAt: "2024-06-01T00:00:00.000Z" });
  });

  test("pgStore validates ids before touching the database", async () => {
    const s = pgStore();
    expect(s.kind).toBe("pg");
    expect(await s.getRun("not-a-uuid")).toBeNull();
    expect(await s.getCatalogueEntry("bad id")).toBeNull();
    expect(await s.archiveCatalogueEntry("bad id")).toBe(false);
    await expect(s.saveCatalogueEntry({ ...entry("ok"), id: "bad id" })).rejects.toThrow(/rule id/);
  });
});
