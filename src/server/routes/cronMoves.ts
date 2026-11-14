import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { fetchCandles } from "../../shared/hl-client.js";
import { requireCronToken } from "../auth.js";
import * as db from "../db.js";
import { agentStore, liveMark, sharedAgentDeps } from "../moves/agentRoutes.js";
import { defaultMovesJob, MOVES_AGENT_JOB_BUDGET_MS, runMovesAgentJob } from "../moves/jobs.js";
import { getMovesService } from "../moves/service.js";
import { triageBudget } from "../moves/triage.js";
import type { LabLease } from "./cron.js";

// Moves jobs for a database-side timer (docs/SPEC.md § Moves M3, M4), mounted under /api/cron next to cron.ts and
// behind the same cron token (`x-cron-token: $CRON_TOKEN` or `Authorization: Bearer $CRON_SECRET`; requireAuth
// also gates every /cron/* path):
//   POST /cron/moves        hourly, a few minutes past the hour: the moves run for 4h, 24h and 72h, stored (026)
//   POST /cron/moves-agent  every 15 min: triage from the stored 24h run, grading, at most one investigation
// Each runs under its own lease (sync_state coin '_moves', series = job): an overlapping call answers 200
// {skipped: "leased"}. Without a database: 503 {error, reason}. Still running at the hard stop (budget + 40 s, inside
// Vercel's 300 s), the route answers 500 {timedOut} and the run finishes (and frees its lease) in the background.

export type MovesCronJob = "moves" | "moves-agent";

const MOVES_LEASE_COIN = "_moves";
const MOVES_CRON_HARD_STOP_MS = 240_000;
/** The lease outlives the hard stop by a minute: a run killed mid-way frees it after that. */
export const MOVES_CRON_LEASE_MS = MOVES_CRON_HARD_STOP_MS + 60_000;
export const NO_DATABASE = "needs a database (DATABASE_URL unset): moves jobs store their results";

export interface CronMovesDeps {
  hasDb(): boolean;
  lease(job: MovesCronJob): LabLease;
  run: Record<MovesCronJob, (start: number) => Promise<unknown>>;
  now(): number;
  hardStopMs?: number;
}

/** One leased, hard-stopped moves job. Never throws: a thrown run or lease error is a 500 body. */
export async function runMovesCron(job: MovesCronJob, deps: CronMovesDeps): Promise<{ status: 200 | 500 | 503; body: Record<string, unknown> }> {
  if (!deps.hasDb()) return { status: 503, body: { job, error: "unavailable", reason: NO_DATABASE } };
  const holder = randomUUID();
  const lease = deps.lease(job);
  const fail = (err: unknown) => ({ status: 500 as const, body: { job, ok: false, error: err instanceof Error ? err.message : String(err) } });
  try {
    if (!(await lease.acquire(holder, MOVES_CRON_LEASE_MS))) return { status: 200, body: { job, ok: true, skipped: "leased" } };
  } catch (err) {
    return fail(err);
  }
  const started = deps.now();
  const work = (async () => {
    try {
      const result = await deps.run[job](started);
      return { status: 200 as const, body: { job, ok: true, ms: deps.now() - started, result } };
    } catch (err) {
      return fail(err);
    } finally {
      await lease.release(holder).catch((err) => console.error(`[cron:${job}] lease release:`, err));
    }
  })();
  const hardStopMs = deps.hardStopMs ?? MOVES_CRON_HARD_STOP_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), hardStopMs)));
  const done = await Promise.race([work, hardStop]);
  clearTimeout(timer);
  if (done) return done;
  console.error(`[cron:${job}] hard stop after ${Math.round(hardStopMs / 1000)}s`);
  return { status: 500, body: { job, ok: false, timedOut: true, error: `still running after ${Math.round(hardStopMs / 1000)}s` } };
}

function defaultCronMovesDeps(): CronMovesDeps {
  return {
    hasDb: () => !!db.databaseUrl() && agentStore() !== null,
    lease: (job) => ({
      acquire: (holder, ttlMs) => db.acquireLease(MOVES_LEASE_COIN, job, holder, ttlMs),
      release: (holder) => db.releaseLease(MOVES_LEASE_COIN, job, holder),
    }),
    now: Date.now,
    run: {
      moves: (start) => defaultMovesJob(agentStore()!, start),
      "moves-agent": (start) =>
        runMovesAgentJob({
          store: agentStore()!,
          coin: (coin, w) => getMovesService().coin(coin, w),
          agent: sharedAgentDeps(),
          budget: triageBudget(),
          mark: liveMark,
          candles: (coin, s, e) => fetchCandles(coin, "1h", s, e),
          deadline: start + MOVES_AGENT_JOB_BUDGET_MS,
        }),
    },
  };
}

export function cronMovesRoutes(deps: () => CronMovesDeps = defaultCronMovesDeps) {
  const route = (job: MovesCronJob) => async (c: Context) => {
    const { status, body } = await runMovesCron(job, deps());
    return c.json(body, status);
  };
  return new Hono()
    .onError((err, c) => {
      console.error(`[cron] ${c.req.path} failed:`, err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    })
    .post("/moves", requireCronToken, route("moves"))
    .post("/moves-agent", requireCronToken, route("moves-agent"));
}
