// One-shot platform tick (no always-on server): scanner -> novelty -> outcomes -> prune against Postgres, then exit.
//   bun run platform:tick
// Run hourly from .github/workflows/platform-tick.yml and by ROUTINE.md's preflight. The API on Vercel reads what this
// writes (opportunities, ledger, novelty, near-misses); live mids stay a worker feature, so approval stays blocked there.
// The steps live in src/server/platform/tick.ts; POST /api/cron/platform-tick runs the same tick over HTTP (no novelty).
// Env: DATABASE_URL (unset = prints a notice and exits 0), PLATFORM_* as in scripts/server.ts, PLATFORM_READY_TTL_MIN
// should cover the gap between ticks (120 for an hourly cron).
import { randomUUID } from "node:crypto";
import { databaseUrl, releaseConnection } from "../src/server/db";
import { pgTickDeps, platformLease, runPlatformTick } from "../src/server/platform/tick";

const LEASE_MS = 15 * 60_000;

async function main() {
  if (!databaseUrl()) return console.log("platform tick skipped: DATABASE_URL is not set");
  const holder = randomUUID();
  if (!(await platformLease.acquire(holder, LEASE_MS))) return console.log("platform tick skipped: another tick holds the lease");
  try {
    // --skip=novelty,... (the routine skips novelty: daily bars, ~14 min, the hourly job runs it).
    const skip = (process.argv.find((a) => a.startsWith("--skip="))?.slice(7) ?? "").split(",").filter(Boolean);
    // Each stage runs even if an earlier one failed; any failure still fails the run.
    const report = await runPlatformTick(pgTickDeps(), { skip });
    if (report.failed.length) throw new Error(`platform tick failed: ${report.failed.join(", ")}`);
  } finally {
    await platformLease.release(holder).catch(() => {});
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await releaseConnection().catch(() => {});
}
