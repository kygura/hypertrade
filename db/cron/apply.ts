import { readFileSync } from "node:fs";
import { releaseConnection } from "../../src/server/db.js";
import { pgDb, type Db } from "../../src/server/platform/store-pg.js";

// Applies the job schedule (db/cron/schedule.sql) to the configured database and sets the two Vault secrets it reads,
// so a deployment schedules itself: `bun run db:schedule`, run by the Vercel production build after the migrations
// (vercel.json). Needs APP_URL (the deployed origin) and CRON_TOKEN; without either it does nothing and says so.
// Idempotent: the secrets are updated in place and schedule.sql upserts its jobs by name. The values are passed as
// parameters, never in SQL text, and are not logged. By hand the same steps are in README "Scheduling".

const SCHEDULE = new URL("./schedule.sql", import.meta.url);

/** Creates the secret, or updates it in place when the name exists. */
async function setSecret(db: Db, name: string, value: string): Promise<void> {
  const [row] = await db.query<{ id: string }>(`select id from vault.secrets where name = $1`, [name]);
  if (row) await db.query(`select vault.update_secret($1::uuid, $2)`, [row.id, value]);
  else await db.query(`select vault.create_secret($1, $2)`, [value, name]);
}

/** Sets the secrets and runs schedule.sql. Returns why nothing was done, or null when the schedule was applied. */
export async function applySchedule(db: Db, env: Record<string, string | undefined>, schedule: string): Promise<string | null> {
  const appUrl = env.APP_URL?.trim().replace(/\/+$/, "");
  const token = env.CRON_TOKEN?.trim();
  if (!appUrl || !token) return `${[!appUrl && "APP_URL", !token && "CRON_TOKEN"].filter(Boolean).join(" and ")} not set`;
  await db.exec(`create extension if not exists supabase_vault`);
  await setSecret(db, "hypertrade_app_url", appUrl);
  await setSecret(db, "hypertrade_cron_token", token);
  // The file wraps itself in begin … commit for the SQL editor. The driver refuses a bare BEGIN on a pooled
  // connection, so those two lines are dropped and the file runs in one driver transaction instead.
  await db.tx((tx) => tx.exec(schedule.replace(/^(begin|commit);[ \t]*$/gim, "")));
  return null;
}

if (import.meta.main) {
  try {
    const skipped = await applySchedule(pgDb(), process.env, readFileSync(SCHEDULE, "utf8"));
    console.log(skipped ? `[schedule] not applied: ${skipped}` : "[schedule] applied db/cron/schedule.sql");
  } finally {
    await releaseConnection();
  }
}
