import type { AgentRecord } from "../../shared/agentRecords.js";
import type { Candle } from "../../shared/types.js";
import type { LoopDef } from "../platform/runtime.js";
import type { PlatformStore } from "../platform/store.js";
import { investigate, isInFlight, INFLIGHT_STALE_MS, type AgentDeps } from "./agent.js";
import { dueAt, gradeRecord, type Bar } from "./agentGrade.js";
import type { MovesService } from "./service.js";
import { autoInvestigate, planTriage, triageId, utcDay, utcDayStart } from "./triage.js";

// The `moves-agent` loop (plan §5 E), registered by scripts/server.ts on the always-on server only. Every minute (the scan reads the cached hourly run; at most one investigation a tick):
// 1. triage: read the 24h moves (A's service, cached hourly), surface new candidates under the day's budget;
// 2. auto-investigate: at most one coin per tick whose residual crossed |z| ≥ 2.5 with no news hour, under the cap;
// 3. grade: open records against closed hourly bars (falsifier) and, at the horizon, the mark vs BTC.
// Shaped like platform/outcomesLoop.ts. The human's actions stay DISMISS and links; nothing here approves or orders.

const HOUR_MS = 3_600_000;
/** A horizon more overdue than this is graded at the close of the last full hour before it, not at the mark now. */
const GRACE_MS = 15 * 60_000;
/** Candle fetches per tick for grading (coin + BTC count as two): a backlog must not burst through the weight guard. */
const MAX_GRADE_FETCHES = 20;

export interface TriageScan {
  day: string;
  at: string;
  state: "ok" | "pending" | "unavailable";
  reason: string | null;
  /** Coins in the latest moves universe. */
  watched: number;
  /** Candidates over the day's budget in the latest scan. */
  overBudget: number;
}

let latest: TriageScan | null = null;
/** The latest scan of this process's loop; null before the first one (or where the loop does not run). */
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
  /** Auto investigations per tick (default 1): each holds the tick for up to the research deadline. */
  autoPerTick?: number;
}

const toBars = (cs: Candle[]): Bar[] => cs.filter((c) => Number.isFinite(c.h) && Number.isFinite(c.l) && c.c > 0).map((c) => ({ t: c.t, h: c.h, l: c.l, c: c.c }));

export function createAgentLoop(deps: AgentLoopDeps) {
  const { store } = deps;
  const now = deps.agent.now;
  /** Last closed hour each open record was checked through: one candle fetch per record per hour, not per tick. */
  const checked = new Map<string, number>();

  async function scan(t: Date) {
    const day = utcDay(t);
    const u = await deps.moves.universe("24h");
    const prev = latest?.day === day ? latest.overBudget : 0;
    if (u.state !== "ok") {
      latest = { day, at: t.toISOString(), state: u.state, reason: u.reason, watched: u.rows.length, overBudget: prev };
      return;
    }
    const plan = planTriage({ rows: u.rows, existing: await store.listTriage(day), day, now: t, budget: deps.budget });
    for (const item of plan.upserts) await store.upsertTriageItem(item);
    latest = { day, at: t.toISOString(), state: "ok", reason: null, watched: u.rows.length, overBudget: plan.overBudget };

    const since = utcDayStart(t).toISOString();
    const room = deps.agent.dailyCap - (await store.agentRunsSince(since)) - deps.agent.inflight.size;
    const coins = autoInvestigate({ items: await store.listTriage(day), candidates: plan.candidates, recordsToday: await store.listAgentRecords({ since, limit: 1000 }), room }).slice(0, deps.autoPerTick ?? 1);
    const btcRow = u.rows.find((r) => r.coin === "BTC")?.mark ?? null;
    for (const coin of coins) {
      const detail = await deps.moves.coin(coin, "24h");
      const btc = (await deps.mark("BTC")) ?? btcRow;
      if (detail.state !== "ok" || !(detail.mark > 0) || !(btc != null && btc > 0)) continue;
      const rec = await investigate({ ...deps.agent, store }, { detail, btcMark: btc, trigger: "triage" });
      if (rec) await linkTriage(store, day, coin, rec.id);
    }
  }

  async function grade(t: Date) {
    const tMs = t.getTime();
    const closedHour = Math.floor(tMs / HOUR_MS);
    let fetches = 0;
    for (const r of await store.listAgentRecords({ status: "open", limit: 1000 })) {
      try {
        if (isInFlight(r)) {
          // A call that never finished (the process died mid-call) is closed as failed, never left open.
          if (tMs - Date.parse(r.createdAt) > INFLIGHT_STALE_MS && !deps.agent.inflight.has(r.coin))
            await store.updateAgentRecord(r.id, { status: "failed", error: "the call never finished (process restarted)" }, "open");
          continue;
        }
        const due = dueAt(r);
        if (r.direction === null) {
          const p = gradeRecord(r, { now: tMs, bars: [], btcBars: [], horizonPx: null, horizonBtcPx: null });
          if (p) await store.updateAgentRecord(r.id, p, "open");
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
          await store.updateAgentRecord(r.id, p, "open");
          checked.delete(r.id);
        } else checked.set(r.id, closedHour);
      } catch (err) {
        console.error(`[moves-agent] grade ${r.coin} ${r.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  async function tick() {
    const t = now();
    // Grading runs even when the scan fails (moves still loading, HL down): records must not miss their horizon.
    let scanError: unknown = null;
    await scan(t).catch((e) => void (scanError = e));
    await grade(t);
    if (scanError) throw scanError;
  }

  return { tick, scan, grade, def: { name: "moves-agent", intervalSec: 60, run: tick } satisfies LoopDef };
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
