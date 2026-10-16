import { readdirSync, readFileSync } from "node:fs";
import { releaseConnection } from "../src/server/db.js";
import { pgDb, type Db } from "../src/server/platform/store-pg.js";

// Migration runner (SPEC.md § Platform P0.17): applies db/migrations/*.sql in
// name order, one transaction each, and records them in schema_migrations.
//
// Baseline rule: 001–010 predate the runner and were applied by hand. When
// schema_migrations does not exist yet and 010's table (intel_research) does,
// the database is an existing one: 001–010 are recorded without running.
// Otherwise (a fresh database, or one that never got to 010) every file runs;
// 001–010 are idempotent, so a partly migrated database converges.

/** The newest file applied before the runner existed. */
export const BASELINE = "010_research.sql";
const DIR = new URL("./migrations/", import.meta.url);

/** Applies pending migrations; returns the files it ran (baselined ones excluded). */
export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  const [state] = await db.query<{ fresh: boolean; existing: boolean }>(
    `select to_regclass('schema_migrations') is null as fresh, to_regclass('intel_research') is not null as existing`,
  );
  await db.exec(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  if (state!.fresh && state!.existing) {
    const baseline = files.filter((f) => f <= BASELINE);
    await db.query(`insert into schema_migrations (name) select jsonb_array_elements_text($1::jsonb) on conflict do nothing`, [JSON.stringify(baseline)]);
    log(`[migrate] baseline: recorded ${baseline.length} files up to ${BASELINE} without running them`);
  }
  const done = new Set((await db.query<{ name: string }>(`select name from schema_migrations`)).map((r) => r.name));
  const ran: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    await db.tx(async (tx) => {
      await tx.exec(readFileSync(new URL(f, DIR), "utf8"));
      await tx.query(`insert into schema_migrations (name) values ($1)`, [f]);
    });
    ran.push(f);
    log(`[migrate] applied ${f}`);
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
