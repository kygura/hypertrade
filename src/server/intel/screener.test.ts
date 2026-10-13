import { describe, expect, test } from "bun:test";
import { ScreenerDslSchema, type ScreenerDsl, type ScreenerDslInput } from "../../shared/intel.js";
import { ScriptedProvider } from "../desk/testkit.js";
import { CompileError, compile, parseQuery, runQuery, sanitizeDbError, type ReadClient, type SqlParam } from "./screener.js";
import { MemoryIntelStore } from "./store.js";

const dsl = (d: ScreenerDslInput) => ScreenerDslSchema.parse(d);
/** Skips zod on purpose: compile must hold the line on its own. */
const raw = (d: Record<string, unknown>) => ({ filters: [], changes: [], since_h: 24, limit: 100, ...d }) as unknown as ScreenerDsl;

/** The documented example: funding flipped negative while OI rose 20% in 7 days. */
const FLIP = {
  source: "snapshots",
  select: ["asset", "ts", "funding", "oi_usd"],
  filters: [{ col: "funding", op: "<", value: 0 }],
  changes: [
    { col: "funding", window_h: 168, op: "<", pct: -100 },
    { col: "oi_usd", window_h: 168, op: ">", pct: 20 },
  ],
  since_h: 1,
  orderBy: { col: "oi_usd", dir: "desc" },
  limit: 100,
} as const satisfies ScreenerDslInput;

describe("compile", () => {
  test("the funding-flip + OI example", () => {
    const c = compile(dsl(FLIP));
    expect(c.sql).toBe(
      [
        `select t."asset", t."ts", t."funding", t."oi_usd", (t."funding" - c0.v) / nullif(c0.v, 0) * 100 as "funding_chg_168h", (t."oi_usd" - c1.v) / nullif(c1.v, 0) * 100 as "oi_usd_chg_168h"`,
        `from intel_snapshots t`,
        `cross join lateral (select b."funding" as v from intel_snapshots b where b."asset" = t."asset" and b."ts" <= t."ts" - make_interval(hours => $3::int) and b."ts" >= t."ts" - make_interval(hours => 2 * $3::int) order by b."ts" desc limit 1) c0`,
        `cross join lateral (select b."oi_usd" as v from intel_snapshots b where b."asset" = t."asset" and b."ts" <= t."ts" - make_interval(hours => $5::int) and b."ts" >= t."ts" - make_interval(hours => 2 * $5::int) order by b."ts" desc limit 1) c1`,
        `where t."ts" >= now() - make_interval(hours => $1::int)`,
        `  and t."funding" < $2::float8`,
        `  and (t."funding" - c0.v) / nullif(c0.v, 0) * 100 < $4::float8`,
        `  and (t."oi_usd" - c1.v) / nullif(c1.v, 0) * 100 > $6::float8`,
        `order by t."oi_usd" desc nulls last, t."ts" desc`,
        `limit $7::int`,
      ].join("\n"),
    );
    expect(c.params).toEqual([1, 0, 168, -100, 168, 20, 100]);
    expect(c.columns).toEqual(["asset", "ts", "funding", "oi_usd", "funding_chg_168h", "oi_usd_chg_168h"]);
  });

  test("candles: assets, text filter, change keyed on coin + tf", () => {
    const c = compile(dsl({ source: "candles", select: ["coin", "tf", "ts", "c"], filters: [{ col: "tf", op: "=", value: "1h" }], changes: [{ col: "c", window_h: 24, op: ">", pct: 5 }], assets: ["BTC", "ETH"] }));
    expect(c.sql).toContain(`from candles t`);
    expect(c.sql).toContain(`b."coin" = t."coin" and b."tf" = t."tf"`);
    expect(c.sql).toContain(`t."coin" in ($2::text, $3::text)`);
    expect(c.sql).toContain(`t."tf" = $4::text`);
    expect(c.params).toEqual([24, "BTC", "ETH", "1h", 24, 5, 100]);
  });

  test("observations key changes on series_id; != compiles to <>", () => {
    const c = compile(dsl({ source: "observations", select: ["series_id", "ts", "value"], filters: [{ col: "series_id", op: "!=", value: "fng.value" }], changes: [{ col: "value", window_h: 24, op: "<", pct: -5 }] }));
    expect(c.sql).toContain(`from observations t`);
    expect(c.sql).toContain(`b."series_id" = t."series_id"`);
    expect(c.sql).toContain(`t."series_id" <> $2::text`);
  });

  test("rejects anything outside the allowlist", () => {
    const base = { source: "snapshots", select: ["asset"] };
    const rejects = (d: Record<string, unknown>, field?: string) => {
      let err: unknown;
      try {
        compile(raw({ ...base, ...d }));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CompileError);
      if (field) expect((err as CompileError).field).toBe(field);
    };
    rejects({ source: "pg_user" }, "source");
    rejects({ source: "__proto__" }, "source");
    rejects({ select: ["price; drop table intel_snapshots"] }, "select.0");
    rejects({ select: ["rate"] }, "select.0"); // a funding column on snapshots
    rejects({ select: ["constructor"] }, "select.0");
    rejects({ filters: [{ col: "price or 1=1", op: ">", value: 1 }] }, "filters.0.col");
    rejects({ filters: [{ col: "price", op: "like", value: 1 }] }, "filters.0.op");
    rejects({ filters: [{ col: "price", op: "; delete", value: 1 }] }, "filters.0.op");
    rejects({ filters: [{ col: "asset", op: ">", value: "A" }] }, "filters.0");
    rejects({ filters: [{ col: "price", op: ">", value: "1" }] }, "filters.0.value");
    rejects({ filters: [{ col: "ts", op: ">", value: 1 }] }, "filters.0.col");
    rejects({ changes: [{ col: "asset", window_h: 24, op: ">", pct: 1 }] }, "changes.0.col");
    rejects({ changes: [{ col: "price", window_h: 24, op: "=", pct: 1 }] }, "changes.0.op");
    rejects({ orderBy: { col: "random()", dir: "desc" } }, "orderBy.col");
    rejects({ source: "observations", select: ["value"], assets: ["BTC"] }, "assets");
  });

  test("caps: limit ≤ 500, since_h ≤ 90 d, since_h + 2 × window ≤ 90 d", () => {
    const base = { source: "snapshots", select: ["asset"] };
    expect(() => compile(raw({ ...base, limit: 501 }))).toThrow(CompileError);
    expect(() => compile(raw({ ...base, limit: 0 }))).toThrow(CompileError);
    expect(() => compile(raw({ ...base, limit: 1.5 }))).toThrow(CompileError);
    expect(() => compile(raw({ ...base, since_h: 2161 }))).toThrow(CompileError);
    expect(() => compile(raw({ ...base, since_h: 2000, changes: [{ col: "price", window_h: 168, op: ">", pct: 1 }] }))).toThrow("range too long");
    expect(compile(raw({ ...base, limit: 500, since_h: 2160 })).params).toEqual([2160, 500]);
  });

  test("injection strings in values only ever travel as parameters", () => {
    const evil = "BTC' or '1'='1; drop table candles; --";
    const c = compile(raw({ source: "snapshots", select: ["asset"], filters: [{ col: "asset", op: "=", value: evil }], assets: [evil] }));
    expect(c.sql).not.toContain("drop");
    expect(c.sql).not.toContain("'");
    expect(c.params).toEqual([24, evil, evil, 100]);
    expect(() => compile(raw({ source: "snapshots", select: ["asset"], filters: [{ col: "price", op: ">", value: Number.NaN }] }))).toThrow(CompileError);
  });
});

// ---------------------------------------------------------------- execution

class FakeClient implements ReadClient {
  modes: string[] = [];
  statements: Array<{ query: string; params?: SqlParam[] }> = [];
  constructor(private readonly result: () => Record<string, unknown>[] & { columns?: { name: string }[] }) {}
  async begin<T>(mode: string, fn: (tx: { unsafe: (q: string, p?: SqlParam[]) => Promise<any> }) => Promise<T>): Promise<T> {
    this.modes.push(mode);
    return fn({
      unsafe: async (query, params) => {
        this.statements.push({ query, params });
        return query.startsWith("set local") ? [] : this.result();
      },
    });
  }
}

const rows = (r: Record<string, unknown>[], columns?: string[]) => Object.assign(r, columns ? { columns: columns.map((name) => ({ name })) } : {});

describe("runQuery", () => {
  test("read-only transaction, 5 s statement timeout, then the compiled statement", async () => {
    const ts = new Date("2026-10-13T11:45:00Z");
    const client = new FakeClient(() => rows([{ asset: "SOL", ts, funding: -0.00001, oi_usd: 2e8, funding_chg_168h: -150, oi_usd_chg_168h: 25 }], ["asset", "ts", "funding", "oi_usd", "funding_chg_168h", "oi_usd_chg_168h"]));
    const d = dsl(FLIP);
    const r = await runQuery(d, client);
    expect(client.modes).toEqual(["read only"]);
    expect(client.statements[0]).toEqual({ query: "set local statement_timeout = '5s'", params: undefined });
    expect(client.statements[1]).toEqual({ query: compile(d).sql, params: compile(d).params });
    expect(r.columns).toEqual(["asset", "ts", "funding", "oi_usd", "funding_chg_168h", "oi_usd_chg_168h"]);
    expect(r.rows).toEqual([["SOL", "2026-10-13T11:45:00.000Z", -0.00001, 2e8, -150, 25]]);
    expect(r.sql).toBe(compile(d).sql);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  test("columns fall back to the compiled list; bigint and non-finite cells are made JSON-safe", async () => {
    const client = new FakeClient(() => rows([{ asset: "BTC", price: Number.POSITIVE_INFINITY, vol24h: 3n }]));
    const r = await runQuery(dsl({ source: "snapshots", select: ["asset", "price", "vol24h"] }), client);
    expect(r.columns).toEqual(["asset", "price", "vol24h"]);
    expect(r.rows).toEqual([["BTC", null, 3]]);
  });

  test("database errors come back verbatim, minus connection strings", async () => {
    const client: ReadClient = {
      begin: async () => {
        throw new Error("connect ECONNREFUSED postgres://app:hunter2@db.internal:5432/hypertrade password=hunter2");
      },
    };
    let msg = "";
    try {
      await runQuery(dsl({ source: "snapshots", select: ["asset"] }), client);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe("connect ECONNREFUSED postgres://*** password=***");
    expect(sanitizeDbError(new Error("canceling statement due to statement timeout"))).toBe("canceling statement due to statement timeout");
  });
});

// ---------------------------------------------------------------- parsing

function llm(emit: unknown) {
  const store = new MemoryIntelStore();
  const provider = new ScriptedProvider("strong-model", () => [{ calls: [{ name: "emit", input: emit }] }]);
  return { llm: { makeProvider: () => provider, cache: store, now: () => new Date("2026-10-13T12:00:00Z"), dailyCap: 200 } };
}

describe("parseQuery", () => {
  test("model DSL → zod-validated DSL with defaults", async () => {
    const r = await parseQuery(llm({ source: "snapshots", select: ["asset", "spread_bps"], orderBy: { col: "spread_bps" } }), "held coins with the widest spread");
    if (!r.ok) throw new Error(r.error);
    expect(r.dsl).toMatchObject({ source: "snapshots", since_h: 24, limit: 100, orderBy: { col: "spread_bps", dir: "desc" } });
    expect(r.trace).toMatchObject({ tier: "strong", promptVersion: "screener.v1" });
  });

  test("a DSL that would not compile is rejected like invalid zod (retry, then fail closed)", async () => {
    const r = await parseQuery(llm({ source: "snapshots", select: ["asset"], since_h: 2100, changes: [{ col: "oi_usd", window_h: 168, op: ">", pct: 20 }] }), "q");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("range too long");
    const r2 = await parseQuery(llm({ source: "snapshots", select: ["passwd"] }), "q");
    expect(r2.ok).toBe(false);
  });
});
