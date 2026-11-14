import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { requireCronToken } from "../auth.js";
import * as db from "../db.js";
import type { NoveltyRunOpts, NoveltyRunReport } from "../platform/noveltyLoop.js";
import { PgPlatformStore } from "../platform/store-pg.js";
import { emptyReport, noveltyLease, pgNovelty, pgTickDeps, platformLease, runPlatformTick, type PlatformTickDeps, type TickStep } from "../platform/tick.js";
import type { LabLease } from "./cron.js";

// POST /api/cron/platform-tick: one platform tick over HTTP, for a database-side timer every 10–15 min (no
// always-on server). Mounted at /cron after cronRoutes in api/index.ts, so requireAuth's cron-token gate and
// cronRoutes' connection-release middleware cover it too. Scanner, outcomes and prune; the novelty pass (~14 min of
// daily bars) is excluded and left to its own job, POST /api/cron/novelty below.

/** No step starts after this. Vercel's limit is maxDuration (300 s, api/index.ts). */
const PLATFORM_TICK_BUDGET_MS = 200_000;
/** Answer by now with what ran, even if a step hangs (a DB write can take the 30 s query timeout). */
const PLATFORM_TICK_HARD_STOP_MS = PLATFORM_TICK_BUDGET_MS + 40_000;
/** The lease outlives the budget by a minute: a killed run frees it after that. */
export const PLATFORM_TICK_LEASE_MS = PLATFORM_TICK_BUDGET_MS + 60_000;
/** Budget a step needs left to start: one scan is an HL call, up to 25 books and a write per candidate. */
const PLATFORM_TICK_RESERVE_MS: Partial<Record<TickStep, number>> = { scanner: 60_000, outcomes: 30_000, prune: 15_000 };
const NOVELTY_EXCLUDED = "excluded over HTTP: the daily-bar pass takes ~14 min; it runs in its own job, POST /api/cron/novelty";

export interface CronPlatformDeps {
  hasDb: () => boolean;
  lease: LabLease;
  tick: () => PlatformTickDeps;
  now: () => number;
  budgetMs?: number;
  hardStopMs?: number;
}

const defaultDeps = (): CronPlatformDeps => ({ hasDb: () => !!db.databaseUrl(), lease: platformLease, tick: pgTickDeps, now: () => Date.now() });

/** One leased, budgeted tick. Never throws: 503 without a database, 200 `skipped` when the lease is held, 500 on a failed step or hard stop. */
export async function runPlatformTickJob(deps: CronPlatformDeps): Promise<{ status: 200 | 500 | 503; body: Record<string, unknown> }> {
  if (!deps.hasDb()) return { status: 503, body: { ok: false, error: "no database: DATABASE_URL is not set" } };
  const holder = randomUUID();
  try {
    if (!(await deps.lease.acquire(holder, PLATFORM_TICK_LEASE_MS))) return { status: 200, body: { ok: true, skipped: "leased" } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: `lease: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const started = deps.now();
  const report = emptyReport();
  const hardStopMs = deps.hardStopMs ?? PLATFORM_TICK_HARD_STOP_MS;
  const work = (async () => {
    try {
      return await runPlatformTick(
        { ...deps.tick(), now: deps.now },
        { skip: ["novelty"], skipReason: { novelty: NOVELTY_EXCLUDED }, deadline: started + (deps.budgetMs ?? PLATFORM_TICK_BUDGET_MS), reserveMs: PLATFORM_TICK_RESERVE_MS, report },
      );
    } finally {
      await deps.lease.release(holder).catch((err) => console.error("[platform-tick] lease release:", err));
    }
  })().catch((err) => ({ ...report, ok: false, error: err instanceof Error ? err.message : String(err) }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), hardStopMs);
  });
  const done = await Promise.race([work, hardStop]);
  clearTimeout(timer);
  if (done) return { status: done.ok ? 200 : 500, body: { ...done } };
  const running = (["scanner", "outcomes", "prune"] as const).find((s) => !report.steps.some((r) => r.name === s));
  console.error(`[platform-tick] hard stop after ${Math.round(hardStopMs / 1000)}s in ${running}`);
  return { status: 500, body: { ...report, ok: false, timedOut: true, ms: deps.now() - started, error: `still running after ${Math.round(hardStopMs / 1000)}s: ${running}` } };
}

// POST /api/cron/novelty: the novelty pass (docs/FEATURES.md 4) as a bounded, resumable job. A full pass over a newly
// closed day reads ~70 coins at ~12 s each, longer than one function may run, so each call checks coins until its
// budget runs out and stores its progress (sync_state '_platform'/'novelty-progress', PlatformStore.saveNoveltyProgress);
// the next call resumes, and calls after a finished pass only retry undelivered pushes. Same code as the always-on loop
// (createNoveltyLoop), under its own lease so it never blocks the tick.

/** No coin starts after this. */
const NOVELTY_BUDGET_MS = 200_000;
/** Budget a coin needs left to start: ensureHistory and the funding sync are capped at 20 s each, plus the reads. */
const NOVELTY_RESERVE_MS = 45_000;
const NOVELTY_HARD_STOP_MS = NOVELTY_BUDGET_MS + 40_000;
export const NOVELTY_LEASE_MS = NOVELTY_BUDGET_MS + 60_000;

export interface CronNoveltyDeps {
  hasDb: () => boolean;
  lease: LabLease;
  novelty: () => Promise<{ run: (o: NoveltyRunOpts) => Promise<NoveltyRunReport> }>;
  now: () => number;
  budgetMs?: number;
  hardStopMs?: number;
}

const defaultNoveltyDeps = (): CronNoveltyDeps => ({
  hasDb: () => !!db.databaseUrl(),
  lease: noveltyLease,
  // No scanner in this process: the near-misses of the latest stored scan stand in for scanner.nearMiss.
  novelty: async () => {
    const store = new PgPlatformStore();
    const near = new Map(((await store.latestNearMisses())?.items ?? []).map((n) => [n.coin, n]));
    return pgNovelty({ store, nearMiss: (coin) => near.get(coin) ?? null });
  },
  now: () => Date.now(),
});

/** One leased, budgeted novelty call. Never throws: 503 without a database, 200 `skipped` when the lease is held, 500 on an error or hard stop. */
export async function runNoveltyJob(deps: CronNoveltyDeps): Promise<{ status: 200 | 500 | 503; body: Record<string, unknown> }> {
  if (!deps.hasDb()) return { status: 503, body: { ok: false, error: "no database: DATABASE_URL is not set" } };
  const holder = randomUUID();
  try {
    if (!(await deps.lease.acquire(holder, NOVELTY_LEASE_MS))) return { status: 200, body: { ok: true, skipped: "leased" } };
  } catch (err) {
    return { status: 500, body: { ok: false, error: `lease: ${err instanceof Error ? err.message : String(err)}` } };
  }
  const started = deps.now();
  const hardStopMs = deps.hardStopMs ?? NOVELTY_HARD_STOP_MS;
  const work = (async (): Promise<Record<string, unknown>> => {
    try {
      const report = await (await deps.novelty()).run({ deadline: started + (deps.budgetMs ?? NOVELTY_BUDGET_MS), reserveMs: NOVELTY_RESERVE_MS });
      return { ok: true, ...report, ms: deps.now() - started };
    } finally {
      await deps.lease.release(holder).catch((err) => console.error("[novelty] lease release:", err));
    }
  })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err), ms: deps.now() - started }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), hardStopMs);
  });
  const done = await Promise.race([work, hardStop]);
  clearTimeout(timer);
  if (done) return { status: done.ok ? 200 : 500, body: done };
  console.error(`[novelty] hard stop after ${Math.round(hardStopMs / 1000)}s`);
  return { status: 500, body: { ok: false, timedOut: true, ms: deps.now() - started, error: `still running after ${Math.round(hardStopMs / 1000)}s; progress is stored when the call ends` } };
}

export function cronPlatformRoutes(deps: () => CronPlatformDeps = defaultDeps, noveltyDeps: () => CronNoveltyDeps = defaultNoveltyDeps) {
  return new Hono()
    .post("/platform-tick", requireCronToken, async (c) => {
      const { status, body } = await runPlatformTickJob(deps());
      return c.json(body, status);
    })
    .post("/novelty", requireCronToken, async (c) => {
      const { status, body } = await runNoveltyJob(noveltyDeps());
      return c.json(body, status);
    });
}
