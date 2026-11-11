import { MOVE_WINDOWS, type MoveWindow } from "../../shared/moves.js";
import type { PlatformStore } from "../platform/store.js";
import { createAgentLoop, type AgentLoopDeps, type AgentPassResult } from "./agentLoop.js";
import { RESEARCH_DEADLINE_MS } from "../intel/research.js";
import { createMovesService, defaultMovesDeps, movesWeightBooked, type MovesDeps, type MovesService } from "./service.js";
import { storedUniverse } from "./stored.js";

// Moves as bounded, HTTP-triggered jobs (docs/SPEC.md § Moves M3, M4). Production has no always-on server: a
// database-side timer POSTs /api/cron/moves (hourly) and /api/cron/moves-agent (every 15 min), routes/cronMoves.ts.
// - runMovesJob: one moves run (the service's own attribution code, under MOVES_HL_BUDGET) for all three windows,
//   each saved as the window's latest run. A cold run loads about 40 coins × 24 weight against a 400/min share:
//   roughly 1.5 to 2.5 min; a warm instance (memoised candles) a few seconds. No coin fetch starts after
//   deadline − MOVES_WINDOWS_RESERVE_MS and no window starts after the deadline: what is complete is saved, the
//   rest is named in `notSaved` (and dropped coins in the run's own `universe.dropped`).
// - runMovesAgentJob: the moves-agent pass (agentLoop.ts, the loop's own code) over the latest stored 24h run:
//   triage, grade, then at most one investigation, only with a provider and under the caps.

/** The moves job's budget inside Vercel's 300 s (api/index.ts maxDuration); the route hard-stops at +40 s. */
export const MOVES_JOB_BUDGET_MS = 200_000;
/** Time kept after the last coin fetch starts: one share wait plus the three windows' answers. */
export const MOVES_WINDOWS_RESERVE_MS = 50_000;
/** The moves-agent job's budget; an investigation starts only with its own deadline plus a margin left. */
export const MOVES_AGENT_JOB_BUDGET_MS = 200_000;
const INVESTIGATE_MARGIN_MS = 15_000;

export interface MovesJobDeps {
  /** A moves service whose universe() waits for its run (built with movesJobService in production). */
  service: Pick<MovesService, "universe">;
  store: Pick<PlatformStore, "saveMovesRun">;
  now(): number;
  /** Epoch ms: no window is started after it. */
  deadline: number;
  /** HL weight booked by the moves fetches so far (movesWeightBooked). */
  weight?: () => number;
}

export interface MovesJobResult {
  ok: boolean;
  asOf: string | null;
  saved: MoveWindow[];
  notSaved: Array<{ window: MoveWindow; reason: string }>;
  /** Coins in the run and coins dropped from it (with the first few reasons). */
  coins: number;
  dropped: number;
  droppedSample: Array<{ coin: string; reason: string }>;
  weight: number | null;
  ms: number;
}

/** One moves run, all three windows, each saved as the window's latest. Never throws for a window; a store error is in notSaved. */
export async function runMovesJob(d: MovesJobDeps): Promise<MovesJobResult> {
  const t0 = d.now();
  const w0 = d.weight?.() ?? null;
  const out: MovesJobResult = { ok: false, asOf: null, saved: [], notSaved: [], coins: 0, dropped: 0, droppedSample: [], weight: null, ms: 0 };
  for (const window of MOVE_WINDOWS) {
    if (d.now() >= d.deadline) {
      out.notSaved.push({ window, reason: "job deadline reached before this window" });
      continue;
    }
    try {
      const r = await d.service.universe(window);
      if (r.state !== "ok") {
        out.notSaved.push({ window, reason: `${r.state}: ${r.reason ?? "no reason given"}` });
        continue;
      }
      await d.store.saveMovesRun(r);
      out.saved.push(window);
      out.asOf = r.asOf;
      out.coins = r.universe.coins;
      out.dropped = r.universe.dropped.length;
      out.droppedSample = r.universe.dropped.slice(0, 5);
    } catch (e) {
      out.notSaved.push({ window, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  out.ok = out.saved.length === MOVE_WINDOWS.length;
  out.weight = w0 === null ? null : d.weight!() - w0;
  out.ms = d.now() - t0;
  return out;
}

/** A fresh moves service on the process defaults for one job: it waits for its run up to the deadline and stops fetching before it. */
export function movesJobService(deadline: number, base: MovesDeps = defaultMovesDeps()): MovesService {
  const now = base.now();
  return createMovesService({ ...base, serverless: false, waitMs: Math.max(0, deadline - now), loadDeadline: deadline - MOVES_WINDOWS_RESERVE_MS });
}

/** The production moves job against `store`, budgeted from now. */
export const defaultMovesJob = (store: Pick<PlatformStore, "saveMovesRun">, start = Date.now()) => {
  const deadline = start + MOVES_JOB_BUDGET_MS;
  return runMovesJob({ service: movesJobService(deadline), store, now: Date.now, deadline, weight: movesWeightBooked });
};

export interface MovesAgentJobDeps extends Omit<AgentLoopDeps, "moves" | "autoPerTick"> {
  /** The inline single-coin detail the investigation reads (works without an in-process run). */
  coin: MovesService["coin"];
  /** Epoch ms the job should be done by. */
  deadline: number;
}

export type MovesAgentJobResult = AgentPassResult & { ms: number };

/**
 * The moves-agent pass over the latest stored 24h run: the loop's own triage, grading and investigation code
 * (agentLoop.ts), at most one investigation, and none without enough time left for its own deadline.
 */
export async function runMovesAgentJob(d: MovesAgentJobDeps): Promise<MovesAgentJobResult> {
  const t = d.agent.now();
  const loop = createAgentLoop({
    ...d,
    moves: { universe: (w) => storedUniverse(d.store, w, d.agent.now().getTime()), coin: d.coin },
    autoPerTick: 1,
  });
  const r = await loop.pass(t, { canInvestigate: () => d.deadline - d.agent.now().getTime() >= RESEARCH_DEADLINE_MS + INVESTIGATE_MARGIN_MS });
  return { ...r, ms: d.agent.now().getTime() - t.getTime() };
}
