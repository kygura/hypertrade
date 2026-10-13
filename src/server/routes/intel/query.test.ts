import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ScriptedProvider } from "../../desk/testkit.js";
import type { ReadClient, SqlParam } from "../../intel/screener.js";
import { MemoryIntelStore } from "../../intel/store.js";
import { createQueryRoutes } from "./query.js";

const FLIP = {
  source: "snapshots",
  select: ["asset", "ts", "funding", "oi_usd"],
  filters: [{ col: "funding", op: "<", value: 0 }],
  changes: [
    { col: "funding", window_h: 168, op: "<", pct: -100 },
    { col: "oi_usd", window_h: 168, op: ">", pct: 20 },
  ],
  since_h: 1,
};

function app(opts: { emit?: unknown; client?: () => ReadClient; provider?: ScriptedProvider | null } = {}) {
  const store = new MemoryIntelStore();
  const provider = opts.provider === undefined ? new ScriptedProvider("strong-model", () => [{ calls: [{ name: "emit", input: opts.emit ?? FLIP }] }]) : opts.provider;
  const statements: Array<{ query: string; params?: SqlParam[] }> = [];
  const modes: string[] = [];
  const fake: ReadClient = {
    async begin(mode, fn) {
      modes.push(mode);
      return fn({
        unsafe: async (query: string, params?: SqlParam[]) => {
          statements.push({ query, params });
          return Object.assign(query.startsWith("set local") ? [] : [{ asset: "SOL", ts: new Date("2026-10-13T11:45:00Z"), funding: -0.00001, oi_usd: 2e8, funding_chg_168h: -150, oi_usd_chg_168h: 25 }], {
            columns: ["asset", "ts", "funding", "oi_usd", "funding_chg_168h", "oi_usd_chg_168h"].map((name) => ({ name })),
          });
        },
      });
    },
  };
  const routes = createQueryRoutes({ llm: { makeProvider: () => provider, cache: store, now: () => new Date("2026-10-13T12:00:00Z"), dailyCap: 200 }, client: opts.client ?? (() => fake) });
  return { app: new Hono().route("/api/intel", routes), statements, modes };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/intel/query", () => {
  test("parse returns the DSL, its SQL and params", async () => {
    const res = await app().app.request("/api/intel/query/parse", post({ question: "funding flipped negative and OI up 20% in 7d" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dsl).toMatchObject({ source: "snapshots", since_h: 1, limit: 100 });
    expect(body.sql).toContain("from intel_snapshots t");
    expect(body.params).toEqual([1, 0, 168, -100, 168, 20, 100]);
    expect(body.trace).toMatchObject({ tier: "strong" });
  });

  test("parse: 400 on a bad body, 503 without a model", async () => {
    expect((await app().app.request("/api/intel/query/parse", post({ question: "" }))).status).toBe(400);
    expect((await app().app.request("/api/intel/query/parse", post({ question: "q", sql: "select 1" }))).status).toBe(400);
    expect((await app({ provider: null }).app.request("/api/intel/query/parse", post({ question: "q" }))).status).toBe(503);
  });

  test("run executes read-only with the timeout and returns rows", async () => {
    const { app: a, statements, modes } = app();
    const res = await a.request("/api/intel/query/run", post({ dsl: FLIP }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(modes).toEqual(["read only"]);
    expect(statements[0]!.query).toBe("set local statement_timeout = '5s'");
    expect(statements[1]!.params).toEqual([1, 0, 168, -100, 168, 20, 100]);
    expect(body).toMatchObject({ columns: ["asset", "ts", "funding", "oi_usd", "funding_chg_168h", "oi_usd_chg_168h"], rows: [["SOL", "2026-10-13T11:45:00.000Z", -0.00001, 2e8, -150, 25]] });
    expect(body.sql).toBe(statements[1]!.query);
  });

  test("run: zod and compile rejections are 400 with a field, before any SQL runs", async () => {
    const { app: a, statements } = app();
    const notAllowed = await a.request("/api/intel/query/run", post({ dsl: { ...FLIP, select: ["passwd"] } }));
    expect(notAllowed.status).toBe(400);
    expect((await notAllowed.json()).field).toBe("dsl.select.0");
    const injected = await a.request("/api/intel/query/run", post({ dsl: { ...FLIP, filters: [{ col: "asset", op: "=", value: "x' or 1=1 --" }] } }));
    expect(injected.status).toBe(400);
    const tooLong = await a.request("/api/intel/query/run", post({ dsl: { ...FLIP, since_h: 2000 } }));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ field: "dsl.since_h" });
    expect((await a.request("/api/intel/query/run", post({ dsl: { ...FLIP, limit: 501 } }))).status).toBe(400);
    expect(statements).toEqual([]);
  });

  test("run: database errors are sanitized; no database is 503", async () => {
    const failing: ReadClient = {
      begin: async () => {
        throw new Error("password authentication failed: postgresql://ro:s3cret@db.example.com/x");
      },
    };
    const r1 = await app({ client: () => failing }).app.request("/api/intel/query/run", post({ dsl: FLIP }));
    expect(r1.status).toBe(500);
    expect(await r1.json()).toEqual({ error: "password authentication failed: postgresql://***" });

    const noDb = () => {
      throw new Error("DATABASE_URL is not set — database queries are unavailable");
    };
    const r2 = await app({ client: noDb }).app.request("/api/intel/query/run", post({ dsl: FLIP }));
    expect(r2.status).toBe(503);
  });
});
