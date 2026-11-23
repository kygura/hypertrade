// In-process cron for the always-on server (docs/SELF-HOSTING.md). It runs the HTTP jobs that db/cron/schedule.sql
// fires from Supabase pg_cron, at the same minutes, through the same routes and the same cron token, but by calling
// the Hono app inside this process: no pg_net, no network hop, and the schedule travels with the container to any
// host. The jobs scripts/server.ts already runs as worker loops (platform tick, moves, moves agent, novelty, desk)
// are left out. On when CRON_IN_PROCESS=1; turn the Supabase schedule off then (db/cron/unschedule.sql).
import type { LoopDef } from "./runtime";

export type CronJob = { name: string; minutes: readonly number[]; path: string; intel?: boolean };

/** Every hour at these UTC minutes, as in schedule.sql (src/server/platform/cronLoop.test.ts keeps the two in step). */
export const IN_PROCESS_JOBS: readonly CronJob[] = [
  { name: "hypertrade-collect", minutes: [0, 15, 30, 45], path: "/api/cron/collect" },
  { name: "hypertrade-backfill", minutes: [2, 17, 32, 47], path: "/api/cron/backfill" },
  { name: "hypertrade-seed-snapshots", minutes: [6, 21, 36, 51], path: "/api/cron/seed-snapshots" },
  { name: "hypertrade-extremes", minutes: [8], path: "/api/cron/extremes" },
  { name: "hypertrade-intel-ingest", minutes: [12, 27, 42, 57], path: "/api/cron/intel/ingest", intel: true },
  { name: "hypertrade-intel-brief", minutes: [14], path: "/api/cron/intel/brief", intel: true },
  { name: "hypertrade-lab-collect", minutes: [26], path: "/api/cron/lab-collect" },
  { name: "hypertrade-intel-graph", minutes: [29], path: "/api/cron/intel/graph", intel: true },
  { name: "hypertrade-intel-watch", minutes: [44], path: "/api/cron/intel/watch", intel: true },
];

/** schedule.sql jobs whose work the always-on worker loops already do; the in-process cron does not call them. */
export const COVERED_BY_LOOPS: readonly string[] = [
  "hypertrade-platform-tick", // scanner + outcomes + prune loops
  "hypertrade-moves", // moves-runs loop
  "hypertrade-moves-agent", // moves-agent loop
  "hypertrade-novelty", // novelty loop
  "hypertrade-desk-tick", // desk loop
  "hypertrade-seed-deep", // scanner loop writes a row every 5 min; what a restart misses is inside the 15-min seed's 6 h window
];

export interface CronLoopDeps {
  /** The Hono app's fetch (paths include /api). */
  fetch: (req: Request) => Response | Promise<Response>;
  token: string;
  /** Run the intel jobs (INTEL_ENABLED, default on like schedule.sql's intel_enabled). */
  intel?: boolean;
  now?: () => Date;
  log?: (...a: unknown[]) => void;
  /** How often the loop looks at the clock, seconds. Under 60 so no minute is skipped. */
  checkSec?: number;
}

/**
 * One loop that checks the UTC minute every `checkSec` and queues the jobs due in it, once per minute. Jobs run one
 * after another (like pg_net's batches), so two jobs never share the DB pool; a job still queued or running when its
 * next minute comes is not queued twice. A failed job shows as this loop's error in /api/health on the next check.
 */
export function createCronLoop({ fetch, token, intel = true, now = () => new Date(), log = console.log, checkSec = 20 }: CronLoopDeps) {
  const jobs = IN_PROCESS_JOBS.filter((j) => intel || !j.intel);
  let lastMinute = "";
  let chain: Promise<void> = Promise.resolve();
  const pending = new Set<string>();
  let failure: string | null = null;

  const call = async (job: CronJob) => {
    const t0 = Date.now();
    try {
      const res = await fetch(new Request(`http://in-process${job.path}`, {
        method: "POST",
        headers: { "x-cron-token": token, "content-type": "application/json" },
        body: "{}",
      }));
      const head = (await res.text()).slice(0, 200);
      if (!res.ok) failure = `${job.name}: HTTP ${res.status} ${head}`;
      log(`[cron] ${job.name} ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, res.ok ? "" : head);
    } catch (err) {
      failure = `${job.name}: ${err instanceof Error ? err.message : String(err)}`;
      log(`[cron] ${job.name} threw:`, err);
    } finally {
      pending.delete(job.name);
    }
  };

  const def: LoopDef = {
    name: "cron",
    intervalSec: checkSec,
    run: async () => {
      if (!token) throw new Error("CRON_IN_PROCESS=1 needs CRON_TOKEN");
      const t = now();
      const minute = t.toISOString().slice(0, 16);
      if (minute !== lastMinute) {
        lastMinute = minute;
        for (const job of jobs) {
          if (!job.minutes.includes(t.getUTCMinutes())) continue;
          if (pending.has(job.name)) {
            log(`[cron] ${job.name} still queued or running; skipped ${minute}`);
            continue;
          }
          pending.add(job.name);
          chain = chain.then(() => call(job));
        }
      }
      if (failure) {
        const f = failure;
        failure = null;
        throw new Error(f);
      }
    },
  };

  /** Resolves when every queued job has finished (tests, shutdown). */
  const drain = () => chain;
  return { def, drain };
}
