import { PGlite, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type postgres from "postgres";
import type { Db } from "../platform/store-pg.js";

// In-process Postgres for Postgres-only tests (docs/SPEC.md § Platform P0.19): no
// local Postgres or Docker here. postgres.js cannot talk to PGlite, so tests
// drive the same SQL through PGlite's query API behind the Db interface.

/** A fresh in-memory database with pgcrypto (001_init.sql creates the extension). */
export const newPglite = () => new PGlite({ extensions: { pgcrypto } });

/**
 * postgres.js's tagged-template client over PGlite, as far as the Lab pg store uses it: queries with `$n` params,
 * nested fragments, `sql(list)` for `in (…)`, `sql.json(v)`, and `.count` on results. Lets that twin run the shared
 * store suite in process (lab/store.test.ts). Not a general driver.
 */
export function pgliteSql(pg: PGlite): postgres.Sql {
  class Query {
    constructor(readonly strings: readonly string[], readonly values: unknown[]) {}
    then<A, B>(ok?: (rows: never) => A, bad?: (e: unknown) => B) {
      const params: unknown[] = [];
      return pg
        .query(render(this, params), params)
        .then((r) => Object.assign([...r.rows], { count: r.affectedRows ?? r.rows.length }) as never)
        .then(ok, bad);
    }
  }
  class List {
    constructor(readonly items: readonly unknown[]) {}
  }
  class Json {
    constructor(readonly value: unknown) {}
  }
  const render = (q: Query, params: unknown[]): string => {
    const p = (x: unknown) => (params.push(x), `$${params.length}`);
    return q.strings.reduce((text, s, i) => {
      const v = q.values[i - 1];
      const at = v instanceof Query ? render(v, params) : v instanceof List ? `(${v.items.map(p).join(", ")})` : v instanceof Json ? p(JSON.stringify(v.value)) : p(v);
      return text + at + s;
    });
  };
  const sql = (first: unknown, ...rest: unknown[]) => (Array.isArray(first) && "raw" in first ? new Query(first, rest) : new List(first as unknown[]));
  return Object.assign(sql, { json: (v: unknown) => new Json(v) }) as unknown as postgres.Sql;
}

export function pgliteDb(pg: PGlite | Transaction): Db {
  const db: Db = {
    query: async (text, params = []) => (await pg.query(text, params)).rows as never,
    exec: async (text) => void (await pg.exec(text)),
    tx: (fn) => ("transaction" in pg ? pg.transaction((tx) => fn(pgliteDb(tx))) : fn(db)),
  };
  return db;
}
