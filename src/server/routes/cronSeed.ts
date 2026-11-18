import { Hono, type Context } from "hono";
import { createHlShare, fetchCandles, fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import { requireCronToken } from "../auth.js";
import * as db from "../db.js";
import { fundingFor, GRID_MS } from "../platform/replaySource.js";
import { envNum } from "../platform/scanner.js";
import { coinalyzeIntradayOi, runSnapshotSeed, SEED_DEADLINE, type SnapshotSeedDeps } from "../platform/seed.js";
import { PgPlatformStore } from "../platform/store-pg.js";
import { selectUniverse } from "../platform/universe.js";
import type { LabLease } from "./cron.js";
import { runLeasedJob } from "./extremes.js";

// POST /api/cron/seed-snapshots, every 15 min at :06 (db/cron/schedule.sql), cron token: the scan_snapshots seed
// (platform/seed.ts) for the top PLATFORM_SEED_TOP (30) coins by 24 h volume plus BTC, two minutes before the
// extremes job reads them. This is what keeps intraday history dense on a deployment with no always-on server.
// The 15-min job looks for gaps in the last 6 h (a coin with no empty slot costs no request). POST
// /api/cron/seed-snapshots/deep, daily at 03:41 UTC, looks 14 days back: long outages and the first backfill.
// Both share one lease (sync_state '_seed'/'snapshots'); 503 without a database, 200 {skipped} when leased or
// without COINALYZE_API_KEY, 500 when every coin that needed rows failed. A run starts no coin
// after SEED_WORK_MS and answers with `remaining`; the coin order rotates daily so the same coins are not cut twice.

const SEED_WORK_MS = 150_000;
const SEED_HARD_STOP_MS = 200_000;
const SEED_LEASE_MS = SEED_HARD_STOP_MS + 60_000;
const DEFAULT_SEED_TOP = 30;
const DEFAULT_SEED_DAYS = 0.25;
/** Inside Coinalyze's intraday retention (1500 bars = 15.6 days) and equal to the snapshot replay's reach. */
const DEEP_SEED_DAYS = 14;
/** Trailing-60s HL weight this job stays under (of the guard's 1000). */
const SEED_HL_BUDGET = 700;

export interface CronSeedDeps {
  hasDb: () => boolean;
  /** False without COINALYZE_API_KEY: the job is skipped, not failed. */
  hasKey: () => boolean;
  lease: LabLease;
  seed: (o: { deadline: number; days: number }) => SnapshotSeedDeps;
  now: () => number;
  hardStopMs?: number;
}

const seedLease: LabLease = {
  acquire: (holder, ttlMs) => db.acquireLease("_seed", "snapshots", holder, ttlMs),
  release: (holder) => db.releaseLease("_seed", "snapshots", holder),
};

let pgStore: PgPlatformStore | null = null;
const share = createHlShare(SEED_HL_BUDGET);

const defaultDeps = (): CronSeedDeps => ({
  hasDb: () => !!db.databaseUrl(),
  hasKey: () => !!process.env.COINALYZE_API_KEY?.trim(),
  lease: seedLease,
  now: Date.now,
  seed: ({ deadline, days }) => ({
    coins: async () => {
      const live = (await fetchPerpMetaAndCtxs()).ctxs.filter((c) => !c.isDelisted && c.markPx > 0).map((c) => ({ coin: c.name, dayNtlVlm: c.dayNtlVlm }));
      const coins = [...new Set(["BTC", ...selectUniverse(live, { top: envNum("PLATFORM_SEED_TOP", DEFAULT_SEED_TOP) }).map((c) => c.coin)])].sort();
      const k = Math.floor(Date.now() / 86_400_000) % coins.length;
      return [...coins.slice(k), ...coins.slice(0, k)];
    },
    // The weight of the bars asked for, not of a full page: an incremental run asks for about a day.
    candles: async (coin, s, e) => (await share(20 + Math.ceil((e - s) / GRID_MS / 60)), fetchCandles(coin, "15m", s, e)),
    funding: fundingFor,
    oi: coinalyzeIntradayOi(process.env.COINALYZE_API_KEY!.trim(), { fetch, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
    store: (pgStore ??= new PgPlatformStore()),
    now: Date.now,
    dryRun: false,
    deadline,
    days,
    log: (m) => console.log(`[seed] ${m}`),
  }),
});

/** One leased seed run. ok unless every started coin failed; coins cut by the deadline are `remaining`, not failures. */
export async function runSeedCron(deps: CronSeedDeps, days = DEFAULT_SEED_DAYS): Promise<{ status: 200 | 500 | 503; body: Record<string, unknown> }> {
  if (deps.hasDb() && !deps.hasKey()) return { status: 200, body: { ok: true, skipped: "no COINALYZE_API_KEY" } };
  return runLeasedJob({
    tag: "seed", hasDb: deps.hasDb, lease: deps.lease, leaseMs: SEED_LEASE_MS, hardStopMs: deps.hardStopMs ?? SEED_HARD_STOP_MS,
    job: async () => {
      const reports = await runSnapshotSeed(deps.seed({ deadline: deps.now() + SEED_WORK_MS, days }));
      const remaining = reports.filter((r) => r.skipped === SEED_DEADLINE).map((r) => r.coin);
      const skipped = reports.filter((r) => r.skipped && r.skipped !== SEED_DEADLINE).map((r) => ({ coin: r.coin, reason: r.skipped }));
      const needed = reports.filter((r) => r.skipped !== SEED_DEADLINE && (r.skipped || r.planned > 0)).length;
      if (needed > 0 && skipped.length === needed) throw new Error(`no coin seeded: ${skipped[0]!.coin}: ${skipped[0]!.reason}`);
      return { coins: reports.length, written: reports.reduce((n, r) => n + r.written, 0), skipped, remaining };
    },
  });
}

export function cronSeedRoutes(deps: () => CronSeedDeps = defaultDeps) {
  const run = (days: number) => async (c: Context) => {
    const { status, body } = await runSeedCron(deps(), days);
    return c.json(body, status);
  };
  return new Hono().post("/seed-snapshots", requireCronToken, run(DEFAULT_SEED_DAYS)).post("/seed-snapshots/deep", requireCronToken, run(DEEP_SEED_DAYS));
}
