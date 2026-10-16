import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { migrate } from "../../../db/migrate.js";
import { newPglite, pgliteDb } from "../testing/pglite.js";

const DIR = new URL("../../../db/migrations/", import.meta.url);
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const quiet = () => {};

describe("db/migrate.ts on PGlite", () => {
  test("a fresh database runs every migration for real, once", async () => {
    const db = pgliteDb(newPglite());
    expect(await migrate(db, quiet)).toEqual(FILES);
    expect(FILES).toContain("011_platform.sql");
    expect(await migrate(db, quiet)).toEqual([]);
    const rows = await db.query<{ name: string }>("select name from schema_migrations order by name");
    expect(rows.map((r) => r.name)).toEqual(FILES);
  });

  test("an existing database (001–010 applied by hand, no schema_migrations) re-applies them cleanly", async () => {
    const db = pgliteDb(newPglite());
    for (const f of FILES.filter((f) => f <= "010_research.sql")) await db.exec(readFileSync(new URL(f, DIR), "utf8"));
    expect(await migrate(db, quiet)).toEqual(FILES);
    expect((await db.query("select name from schema_migrations")).length).toBe(FILES.length);
  });

  test("two concurrent runs on one database apply each file once", async () => {
    // PGlite is one connection and queues transactions, so this checks the in-lock re-check, not real lock contention.
    const db = pgliteDb(newPglite());
    const [a, b] = await Promise.all([migrate(db, quiet), migrate(db, quiet)]);
    expect([...a, ...b].sort()).toEqual(FILES);
    expect((await db.query("select name from schema_migrations")).length).toBe(FILES.length);
  });

  test("a failing migration rolls back and is not recorded", async () => {
    const db = pgliteDb(newPglite());
    await migrate(db, quiet);
    await db.query("delete from schema_migrations where name = '011_platform.sql'");
    // 011 is idempotent, so make its re-run fail: an index on a view errors.
    await db.exec("drop table hl_positions; create view hl_positions as select 1 as x");
    await expect(migrate(db, quiet)).rejects.toThrow();
    expect((await db.query("select 1 from schema_migrations where name = '011_platform.sql'")).length).toBe(0);
  });

  test("the ledger refuses UPDATE, DELETE and TRUNCATE, and its opportunity cannot be deleted", async () => {
    const db = pgliteDb(newPglite());
    await migrate(db, quiet);
    const [o] = await db.query<{ id: string }>(
      `insert into opportunities (coin, direction, setup_kind, trade_type, status, score, score_version, edge_basis, liquidity_tier, regime, invalidation, dedupe_key)
       values ('BTC', 'long', 'breakout', 'directional', 'new', 1, 'v1', 'unvalidated', 1, 'range', 'below 60k', 'BTC|long|breakout') returning id`,
    );
    await db.query(`insert into ledger_entries (opportunity_id, kind, payload) values ($1::uuid, 'created', '{}'::jsonb)`, [o!.id]);
    await expect(db.query(`update ledger_entries set payload = '{"x":1}'::jsonb`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from ledger_entries`)).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate ledger_entries`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from opportunities`)).rejects.toThrow();
    expect((await db.query("select * from ledger_entries")).length).toBe(1);
  });

  test("one live opportunity per dedupe key; a closed one frees the slot", async () => {
    const db = pgliteDb(newPglite());
    await migrate(db, quiet);
    const ins = (status: string) =>
      db.query(
        `insert into opportunities (coin, direction, setup_kind, trade_type, status, score, score_version, edge_basis, liquidity_tier, regime, invalidation, dedupe_key)
         values ('BTC', 'long', 'breakout', 'directional', $1, 1, 'v1', 'unvalidated', 1, 'range', 'x', 'BTC|long|breakout')`,
        [status],
      );
    await ins("ready");
    await expect(ins("new")).rejects.toThrow();
    await ins("rejected");
    await ins("expired");
  });
});
