import { PGlite, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { Db } from "../platform/store-pg.js";

// In-process Postgres for Postgres-only tests (docs/SPEC.md § Platform P0.19): no
// local Postgres or Docker here. postgres.js cannot talk to PGlite, so tests
// drive the same SQL through PGlite's query API behind the Db interface.

/** A fresh in-memory database with pgcrypto (001_init.sql creates the extension). */
export const newPglite = () => new PGlite({ extensions: { pgcrypto } });

export function pgliteDb(pg: PGlite | Transaction): Db {
  const db: Db = {
    query: async (text, params = []) => (await pg.query(text, params)).rows as never,
    exec: async (text) => void (await pg.exec(text)),
    tx: (fn) => ("transaction" in pg ? pg.transaction((tx) => fn(pgliteDb(tx))) : fn(db)),
  };
  return db;
}
