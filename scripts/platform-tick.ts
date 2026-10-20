// One-shot platform tick (no always-on server): scanner -> novelty -> outcomes -> prune against Postgres, then exit.
//   bun run platform:tick
// Run hourly from .github/workflows/platform-tick.yml and by ROUTINE.md's preflight. The API on Vercel reads what this
// writes (opportunities, ledger, novelty, near-misses); live mids stay a worker feature, so approval stays blocked there.
// Env: DATABASE_URL (unset = prints a notice and exits 0), PLATFORM_* as in scripts/server.ts, PLATFORM_READY_TTL_MIN
// should cover the gap between ticks (120 for an hourly cron).
import { randomUUID } from "node:crypto";
import { acquireLease, releaseConnection, releaseLease, sql } from "../src/server/db";
import { createNotifier } from "../src/server/desk/notify";
import { createAlerts } from "../src/server/platform/alerts";
import { createNoveltyLoop } from "../src/server/platform/noveltyLoop";
import { createOutcomesLoop } from "../src/server/platform/outcomesLoop";
import { createScanner } from "../src/server/platform/scanner";
import { PgPlatformStore } from "../src/server/platform/store-pg";

const LEASE_MS = 15 * 60_000;

async function main() {
  if (!process.env.DATABASE_URL?.trim()) return console.log("platform tick skipped: DATABASE_URL is not set");
  const holder = randomUUID();
  if (!(await acquireLease("_platform", "tick", holder, LEASE_MS))) return console.log("platform tick skipped: another tick holds the lease");
  try {
    const store = new PgPlatformStore();
    // Same cold-start source as scripts/server.ts: intel_snapshots (15-min rows) fills the ring until scan_snapshots has its own history.
    const seedFrom = async (since: string) =>
      (await sql()`select asset, ts, price, vol24h, funding, oi_usd from intel_snapshots where ts >= ${since} order by ts`).map((r: any) => ({
        coin: String(r.asset), ts: new Date(r.ts).toISOString(), inputs: { mark: r.price, oiUsd: r.oi_usd, funding: r.funding, dayNtlVlm: r.vol24h },
      }));
    const scanner = createScanner({ store, seedFrom });
    const alerts = createAlerts({ store, notifier: createNotifier(), wsAgeSec: () => null });
    const novelty = createNoveltyLoop({ store, notify: alerts.novel, nearMiss: scanner.nearMiss });
    // No ws: pricing comes from the scan's mark (same process, just taken) and 1-min candles for late horizons.
    const outcomes = createOutcomesLoop({
      store, mid: () => null, scanMark: scanner.latestMark,
      fillPx: async (id) => {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
        const [r] = await sql()`select px from desk_paper_fills where proposal_id = ${id} order by ts asc limit 1`;
        return r ? Number(r.px) : null;
      },
    });
    const retentionDays = Number(process.env.PLATFORM_RETENTION_DAYS ?? 14) || 14;
    // Each stage runs even if an earlier one failed; any failure still fails the run.
    const failed: string[] = [];
    // --skip=novelty,... (the routine skips novelty: daily bars, ~14 min, the hourly job runs it).
    const skip = new Set((process.argv.find((a) => a.startsWith("--skip="))?.slice(7) ?? "").split(",").filter(Boolean));
    for (const [name, run] of [
      ["scanner", scanner.tick],
      ["novelty", novelty.tick],
      ["outcomes", outcomes.tick],
      ["prune", async () => void (await store.pruneHistory(new Date(Date.now() - retentionDays * 86_400_000).toISOString()))],
    ] as const) {
      if (skip.has(name)) {
        console.log(`[tick] ${name} skipped`);
        continue;
      }
      try {
        await run();
        console.log(`[tick] ${name} ok`);
      } catch (err) {
        failed.push(name);
        console.error(`[tick] ${name} failed:`, err);
      }
    }
    if (failed.length) throw new Error(`platform tick failed: ${failed.join(", ")}`);
  } finally {
    await releaseLease("_platform", "tick", holder).catch(() => {});
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
