import { readdirSync, readFileSync } from "node:fs";
import { releaseConnection } from "../src/server/db.js";
import { pgDb, type Db } from "../src/server/platform/store-pg.js";

// Migration runner (SPEC.md § Platform P0.17): applies db/migrations/*.sql in
// name order, one transaction each, and records them in schema_migrations.
// Every file runs on a database that has not recorded it: 001–010 predate the
// runner but are idempotent, so an existing database just re-applies them once.
//
// Concurrent runners (two boots at once) are serialized by a transaction-level
// advisory lock taken in every transaction, with the "already applied?" check
// inside the lock. Transaction-level rather than a session pg_advisory_lock:
// with DB_POOL_MAX > 1 the lock and unlock could land on different pooled
// connections, and through Supabase's transaction pooler a session lock is not
// held across statements at all.

/** Advisory lock key for migrations (any constant unique to this app). */
export const MIGRATE_LOCK = 4_811_011;
const DIR = new URL("./migrations/", import.meta.url);

/** Applies pending migrations; returns the files it ran. */
export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  const lock = (tx: Db) => tx.query(`select pg_advisory_xact_lock($1::bigint)`, [MIGRATE_LOCK]);
  await db.tx(async (tx) => {
    await lock(tx);
    await tx.exec(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  });
  const ran: string[] = [];
  for (const f of files) {
    const applied = await db.tx(async (tx) => {
      await lock(tx);
      if ((await tx.query(`select 1 from schema_migrations where name = $1`, [f])).length) return false;
      await tx.exec(readFileSync(new URL(f, DIR), "utf8"));
      await tx.query(`insert into schema_migrations (name) values ($1)`, [f]);
      return true;
    });
    if (applied) (ran.push(f), log(`[migrate] applied ${f}`));
  }
  return ran;
}

if (import.meta.main) {
  try {
    await migrate(pgDb());
  } finally {
    await releaseConnection();
  }
}
