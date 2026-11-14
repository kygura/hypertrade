import type { LayerState, MovesResponse, MoveWindow } from "../../shared/moves.js";
import type { PlatformStore, TriageScan } from "../platform/store.js";

// Stored moves runs (docs/SPEC.md § Moves M3; db/migrations/026_moves_runs.sql). Where no in-process moves service
// runs (Vercel), the read routes serve the latest run the moves job stored, and say how old it is. Pure but for the store.

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
/** The moves job runs hourly: a run older than twice that is stale (stated, still served). */
export const MOVES_STALE_MS = 2 * HOUR_MS;
/** The moves-agent job runs every 15 minutes: a triage pass older than twice that is stale. */
export const TRIAGE_STALE_MS = 30 * MIN_MS;
const NO_RUN = "no moves run stored yet";
const NO_DB = "needs a database (moves runs are stored by the moves job)";

const age = (ms: number) => (ms < 2 * HOUR_MS ? `${Math.round(ms / MIN_MS)} min` : `${(ms / HOUR_MS).toFixed(1)} h`);

/** Why the run is stale, or null when it is fresh. Judged on computedAt (when the job ran), not asOf. */
export function staleRunReason(run: Pick<MovesResponse, "computedAt" | "asOf">, now: number): string | null {
  const ms = now - Date.parse(run.computedAt);
  return ms > MOVES_STALE_MS ? `latest moves run is ${age(ms)} old (as of ${run.asOf ?? run.computedAt}); runs are expected hourly` : null;
}

/** The stored run for the window as the route answers it: staleness in `reason`, `unavailable` when there is none. */
export async function storedUniverse(store: Pick<PlatformStore, "latestMovesRun"> | null, window: MoveWindow, now: number): Promise<MovesResponse> {
  const off = (reason: string): MovesResponse => {
    const l: LayerState = { state: "unavailable", reason };
    return {
      state: "unavailable", reason, asOf: null, computedAt: new Date(now).toISOString(), window, progress: null, universe: { coins: 0, dropped: [] },
      sectorsAsOf: null, factors: [], layers: { beta: l, flow: l, attention: l, liq: l, agents: l }, rows: [],
    };
  };
  if (!store) return off(NO_DB);
  const run = await store.latestMovesRun(window);
  if (!run) return off(NO_RUN);
  return { ...run, reason: staleRunReason(run, now) ?? run.reason };
}

/** What the triage and queue routes say about the latest triage pass: null when it is fresh and ok. */
export function triageNote(scan: TriageScan | null, now: number): string | null {
  if (!scan) return NO_RUN;
  const ms = now - Date.parse(scan.at);
  if (ms > TRIAGE_STALE_MS) return `latest triage pass is ${age(ms)} old; the moves-agent job is expected every 15 min`;
  return scan.state === "ok" ? null : scan.reason;
}

/** The latest triage pass: the stored one (shared by every process), else this process's own. */
export async function readTriageScan(store: Pick<PlatformStore, "loadTriageScan"> | null, local: () => TriageScan | null): Promise<TriageScan | null> {
  const stored = store ? await store.loadTriageScan().catch(() => null) : null;
  const mine = local();
  if (!stored) return mine;
  return mine && Date.parse(mine.at) > Date.parse(stored.at) ? mine : stored;
}
