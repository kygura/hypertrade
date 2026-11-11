import type { AgentRecord } from "../../shared/agentRecords.js";
import type { Candle } from "../../shared/types.js";
import type { LoopDef } from "../platform/runtime.js";
import type { PlatformStore, TriageScan } from "../platform/store.js";
import { agentBlockedReason, investigate, isInFlight, INFLIGHT_STALE_MS, type AgentDeps } from "./agent.js";
import { dueAt, gradeRecord, type Bar } from "./agentGrade.js";
import type { MovesService } from "./service.js";
import { staleRunReason } from "./stored.js";
import { autoInvestigate, planTriage, triageId, utcDay, utcDayStart, type TriageCandidate } from "./triage.js";

// The moves agent pass (plan §5 E), one implementation for both deployments: the `moves-agent` loop of the always-on
// server (scripts/server.ts, every minute, over the in-process moves service) and the moves-agent job
// (jobs.ts runMovesAgentJob, POST /api/cron/moves-agent, over the latest stored run). One pass:
// 1. triage: read the 24h moves, surface new candidates under the day's budget; a stale run (older than 2 h) is not
//    triaged (its moves are not today's news). The pass is stored (moves_triage_scan) for the read routes;
// 2. grade: open records against closed hourly bars (falsifier) and, at the horizon, the mark vs BTC;
// 3. auto-investigate: at most one coin per pass whose residual crossed |z| ≥ 2.5 with no news hour (a known news
//    layer: unknown news is not "no news"), and only when a provider is configured and the caps allow
//    (agentBlockedReason; nothing is written when blocked).
// Shaped like platform/outcomesLoop.ts. The human's actions stay DISMISS and links; nothing here approves or orders.

const HOUR_MS = 3_600_000;
/** A horizon more overdue than this is graded at the close of the last full hour before it, not at the mark now. */
const GRACE_MS = 15 * 60_000;
/** Candle fetches per pass for grading (coin + BTC count as two): a backlog must not burst through the weight guard. */
const MAX_GRADE_FETCHES = 20;

export type { TriageScan };

let latest: TriageScan | null = null;
/** The latest pass of this process; null before the first one. The routes prefer the stored pass (stored.ts). */
export const latestTriageScan = () => latest;
export const setLatestTriageScan = (s: TriageScan | null) => void (latest = s);

export interface AgentLoopDeps {
  store: PlatformStore;
  moves: Pick<MovesService, "universe" | "coin">;
  /** The agent's own deps less the store (the loop's store is used). */
  agent: Omit<AgentDeps, "store">;
  /** MOVES_TRIAGE_DAILY. */
  budget: number;
  /** Live mark of a coin (scanner snapshot, else ctxs); null when unknown. */
  mark(coin: string): Promise<number | null>;
  /** Closed and open 1h candles in [start, end]. */
  candles(coin: string, startMs: number, endMs: number): Promise<Candle[]>;
  /** Auto investigations per pass (default 1): each holds the pass for up to the research deadline. */
  autoPerTick?: number;
}

/** One pass's facts (the job's response). */
export interface AgentPassResult {
  scan: TriageScan;
  /** Triage items written this pass (new and re-entered). */
  surfaced: number;
  /** Records closed this pass (graded, falsified, or a stale in-flight call failed). */
  graded: number;
  /** The coin investigated, or null. */
  investigated: string | null;
  /** Facts about it: the stored record's id and status (`record <id> · <status>`), or why none ran. */
  investigation: string | null;
  /** The triage step's error (grading and the rest still ran). */
  error: string | null;
}

const toBars = (cs: Candle[]): Bar[] => cs.filter((c) => Number.isFinite(c.h) && Number.isFinite(c.l) && c.c > 0).map((c) => ({ t: c.t, h: c.h, l: c.l, c: c.c }));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createAgentLoop(deps: AgentLoopDeps) {
  const { store } = deps;
  const now = deps.agent.now;
  /** Last closed hour each open record was checked through: one candle fetch per record per hour, not per tick. */
  const checked = new Map<string, number>();

  interface Triaged { day: string; candidates: TriageCandidate[]; btcRow: number | null }

  async function triage(t: Date): Promise<{ scan: TriageScan; surfaced: number; triaged: Triaged | null }> {
    const day = utcDay(t);
    const u = await deps.moves.universe("24h");
    const prev = latest?.day === day ? latest.overBudget : 0;
    const stale = u.state === "ok" ? staleRunReason(u, t.getTime()) : null;
    let out: { scan: TriageScan; surfaced: number; triaged: Triaged | null };
    if (u.state !== "ok" || stale) {
      out = { scan: { day, at: t.toISOString(), state: stale ? "unavailable" : u.state, reason: stale ?? u.reason, watched: u.rows.length, overBudget: prev }, surfaced: 0, triaged: null };
    } else {
      const plan = planTriage({ rows: u.rows, existing: await store.listTriage(day), day, now: t, budget: deps.budget });
      for (const item of plan.upserts) await store.upsertTriageItem(item);
      out = {
        scan: { day, at: t.toISOString(), state: "ok", reason: null, watched: u.rows.length, overBudget: plan.overBudget },
        surfaced: plan.upserts.length,
        triaged: { day, candidates: plan.candidates, btcRow: u.rows.find((r) => r.coin === "BTC")?.mark ?? null },
      };
    }
    latest = out.scan;
    await store.saveTriageScan(out.scan);
    return out;
  }

  /** At most autoPerTick investigations; returns the coin run or why none ran. */
  async function autoInvestigateStep(t: Date, tr: Triaged | null): Promise<{ investigated: string | null; investigation: string | null }> {
    if (!tr) return { investigated: null, investigation: "no fresh moves run to triage" };
    const since = utcDayStart(t).toISOString();
    const runs = await store.agentRunsSince(since);
    const room = deps.agent.dailyCap - runs - deps.agent.inflight.size;
    const coins = autoInvestigate({ items: await store.listTriage(tr.day), candidates: tr.candidates, recordsToday: await store.listAgentRecords({ since, limit: 1000 }), room }).slice(0, deps.autoPerTick ?? 1);
    if (!coins.length) {
      const unknown = tr.candidates.filter((c) => c.byResidual && c.newsUnknown).length;
      const why = room <= 0 ? `cap reached (${runs}/${deps.agent.dailyCap} today)`
        : unknown ? `no surfaced no-news residual without a record (news unknown for ${unknown} residual candidate${unknown === 1 ? "" : "s"}: no auto-investigation without a news feed)`
        : "no surfaced no-news residual without a record";
      return { investigated: null, investigation: why };
    }
    // Fail closed before any record is written: no provider, no web search, the moves cap or the LLM cap.
    const blocked = await agentBlockedReason(deps.agent, runs);
    if (blocked) return { investigated: null, investigation: blocked };
    let investigated: string | null = null;
    let done: string | null = null;
    let why: string | null = null;
    for (const coin of coins) {
      const detail = await deps.moves.coin(coin, "24h");
      const btc = (await deps.mark("BTC")) ?? tr.btcRow;
      if (detail.state !== "ok" || !(detail.mark > 0) || !(btc != null && btc > 0)) {
        why = `${coin}: ${detail.state !== "ok" ? (detail.reason ?? "no moves detail") : "no mark"}`;
        continue;
      }
      const rec = await investigate({ ...deps.agent, store }, { detail, btcMark: btc, trigger: "triage" });
      if (rec) {
        await linkTriage(store, tr.day, coin, rec.id);
        investigated = coin;
        done = `record ${rec.id} · ${rec.status}`;
      } else why = `${coin}: an investigation is in flight`;
    }
    return { investigated, investigation: investigated ? done : why };
  }

  async function grade(t: Date): Promise<number> {
    const tMs = t.getTime();
    const closedHour = Math.floor(tMs / HOUR_MS);
    let fetches = 0;
    let closed = 0;
    for (const r of await store.listAgentRecords({ status: "open", limit: 1000 })) {
      try {
        if (isInFlight(r)) {
          // A call that never finished (the process died mid-call) is closed as failed, never left open.
          if (tMs - Date.parse(r.createdAt) > INFLIGHT_STALE_MS && !deps.agent.inflight.has(r.coin))
            if (await store.updateAgentRecord(r.id, { status: "failed", error: "the call never finished (process restarted)" }, "open")) closed++;
          continue;
        }
        const due = dueAt(r);
        if (r.direction === null) {
          const p = gradeRecord(r, { now: tMs, bars: [], btcBars: [], horizonPx: null, horizonBtcPx: null });
          if (p && (await store.updateAgentRecord(r.id, p, "open"))) closed++;
          continue;
        }
        const isDue = tMs >= due;
        if (!isDue && (!r.falsifier || checked.get(r.id) === closedHour)) continue;
        if (fetches + 2 > MAX_GRADE_FETCHES) break;
        fetches += 2;
        const start = Date.parse(r.createdAt) - HOUR_MS;
        const end = Math.min(tMs, due);
        const [bars, btcBars] = (await Promise.all([deps.candles(r.coin, start, end), deps.candles("BTC", start, end)])).map(toBars) as [Bar[], Bar[]];
        let horizonPx: number | null = null;
        let horizonBtcPx: number | null = null;
        if (isDue) {
          if (tMs - due <= GRACE_MS) [horizonPx, horizonBtcPx] = await Promise.all([deps.mark(r.coin), deps.mark("BTC")]);
          else [horizonPx, horizonBtcPx] = [lastCloseBefore(bars, due), lastCloseBefore(btcBars, due)];
        }
        const p = gradeRecord(r, { now: tMs, bars, btcBars, horizonPx, horizonBtcPx });
        if (p) {
          if (await store.updateAgentRecord(r.id, p, "open")) closed++;
          checked.delete(r.id);
        } else checked.set(r.id, closedHour);
      } catch (err) {
        console.error(`[moves-agent] grade ${r.coin} ${r.id}:`, errMsg(err));
      }
    }
    return closed;
  }

  /**
   * One pass at `t`: triage, grade, then at most autoPerTick investigations. Never throws for the triage step (its
   * error is in the result): grading runs even when the moves run is missing or HL is down, so records keep their horizon.
   */
  async function pass(t: Date = now(), o: { canInvestigate?: () => boolean } = {}): Promise<AgentPassResult> {
    let tri: Awaited<ReturnType<typeof triage>> | null = null;
    let error: string | null = null;
    try {
      tri = await triage(t);
    } catch (e) {
      error = errMsg(e);
    }
    const graded = await grade(t);
    const inv = o.canInvestigate && !o.canInvestigate()
      ? { investigated: null, investigation: "not enough time left for an investigation" }
      : error ? { investigated: null, investigation: `triage failed: ${error}` } : await autoInvestigateStep(t, tri!.triaged);
    const scan = tri?.scan ?? { day: utcDay(t), at: t.toISOString(), state: "unavailable" as const, reason: error, watched: 0, overBudget: 0 };
    return { scan, surfaced: tri?.surfaced ?? 0, graded, ...inv, error };
  }

  async function tick() {
    const r = await pass(now());
    if (r.error) throw new Error(r.error);
  }

  return { tick, pass, grade, def: { name: "moves-agent", intervalSec: 60, run: tick } satisfies LoopDef };
}

/** Close of the last full hour bar ending at or before `at`. */
export function lastCloseBefore(bars: Bar[], at: number): number | null {
  const b = bars.filter((x) => x.t + HOUR_MS <= at).sort((x, y) => x.t - y.t).at(-1);
  return b ? b.c : null;
}

/** Points the coin's triage item of `day` at the record (when it has none yet). */
export async function linkTriage(store: Pick<PlatformStore, "listTriage" | "upsertTriageItem">, day: string, coin: string, recordId: AgentRecord["id"]): Promise<void> {
  const item = (await store.listTriage(day)).find((x) => x.id === triageId(day, coin));
  if (item && item.recordId === null) await store.upsertTriageItem({ ...item, recordId });
}
