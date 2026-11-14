import type { AgentGrade, AgentRecord, AgentStatsResponse, AgentStatsRow } from "../../shared/agentRecords.js";
import { CI_MIN_CLUSTERS } from "../../shared/platform.js";
import { groupStats } from "../platform/stats.js";
import type { AgentRecordPatch, OutcomeRow } from "../platform/store.js";

// Agent record grading (docs/SPEC.md § Moves; plan §5 E "Grading"). Pure. Copies the radar's discipline
// (radar/calls.ts gradeCalls/checkKills): the move is measured against BTC and signed by the record's direction.
// - Before the horizon, closed hourly bars are checked against the falsifier: the first bar whose low (side below)
//   or high (side above) reaches the level falsifies the record, graded at the level and that bar's BTC close.
// - At createdAt + horizonHours, the record is graded at the horizon price: relPct = 100·dir·(ln(px/mark0) − ln(btc/btc0)).
// - no_cause and direction-null records are counted, never graded (a direction-null record closes as graded with no grade).

const HOUR_MS = 3_600_000;

export interface Bar {
  /** Bar open, epoch ms (1h bars). */
  t: number;
  h: number;
  l: number;
  c: number;
}

export interface GradeInput {
  now: number;
  /** The coin's and BTC's 1h bars since creation (closed or not; open bars are ignored). */
  bars: Bar[];
  btcBars: Bar[];
  /** Coin and BTC price at the horizon; null while unknown (the record then waits). */
  horizonPx: number | null;
  horizonBtcPx: number | null;
}

export const dueAt = (r: Pick<AgentRecord, "createdAt" | "horizonHours">) => Date.parse(r.createdAt) + r.horizonHours * HOUR_MS;

/** 100·dir·(ln(px/mark0) − ln(btc/btc0)). */
export function relPct(r: Pick<AgentRecord, "direction" | "inputs">, px: number, btcPx: number): number {
  const dir = r.direction === "short" ? -1 : 1;
  return 100 * dir * (Math.log(px / r.inputs.markAtCreate) - Math.log(btcPx / r.inputs.btcAtCreate));
}

/** The first closed bar at or after creation and before the horizon whose range reaches the falsifier level. */
function falsifyingBar(r: Pick<AgentRecord, "createdAt" | "horizonHours" | "falsifier">, bars: Bar[], now: number): Bar | null {
  const f = r.falsifier;
  if (!f) return null;
  const t0 = Date.parse(r.createdAt);
  const end = dueAt(r);
  return (
    [...bars]
      .sort((a, b) => a.t - b.t)
      .find((b) => b.t >= t0 && b.t < end && b.t + HOUR_MS <= now && (f.side === "below" ? b.l <= f.level : b.h >= f.level)) ?? null
  );
}

/** The patch that grades an open record now, or null when nothing is due (or a needed price is missing). */
export function gradeRecord(r: AgentRecord, q: GradeInput): AgentRecordPatch | null {
  if (r.status !== "open" || r.grade !== null) return null;
  const end = dueAt(r);
  if (r.direction === null) return q.now >= end ? { status: "graded", grade: null } : null;
  const t0 = Date.parse(r.createdAt);
  const hit = falsifyingBar(r, q.bars, q.now);
  if (hit && r.falsifier) {
    const btc = q.btcBars.find((b) => b.t === hit.t);
    if (!btc || !(btc.c > 0)) return null; // wait for the BTC bar of the same hour
    const at = Math.max(hit.t, t0);
    const px = r.falsifier.level;
    const grade: AgentGrade = { atHours: (at - t0) / HOUR_MS, px, btcPx: btc.c, relPct: relPct(r, px, btc.c), hit: false, falsifiedAt: new Date(at).toISOString() };
    return { status: "falsified", grade };
  }
  if (q.now < end) return null;
  // Every bar before the horizon must be in: a falsification hidden in a missing bar must not grade as a hit.
  if (r.falsifier && !coversWindow(q.bars, t0, end)) return null;
  if (!(q.horizonPx! > 0) || !(q.horizonBtcPx! > 0)) return null;
  const rel = relPct(r, q.horizonPx!, q.horizonBtcPx!);
  return { status: "graded", grade: { atHours: r.horizonHours, px: q.horizonPx!, btcPx: q.horizonBtcPx!, relPct: rel, hit: rel > 0, falsifiedAt: null } };
}

/** Every hourly bar opening in [ceil-hour(t0), end) is present. */
export function coversWindow(bars: Bar[], t0: number, end: number): boolean {
  const have = new Set(bars.map((b) => b.t));
  for (let t = Math.ceil(t0 / HOUR_MS) * HOUR_MS; t + HOUR_MS <= end; t += HOUR_MS) if (!have.has(t)) return false;
  return true;
}

// ---------------------------------------------------------------- stats

/** Graded rows as ledger outcome rows, so groupStats clusters them exactly as the ledger (one cluster per day/horizon bucket). */
function asOutcomes(rs: AgentRecord[], key: (r: AgentRecord) => string, horizon: (r: AgentRecord) => string): OutcomeRow[] {
  return rs.map((r) => ({
    opportunityId: r.id, setupKind: key(r), regime: "", scoreVersion: "", liquidityTier: 1, horizon: horizon(r),
    createdAtMs: Date.parse(r.createdAt), grossReturn: r.grade!.relPct, netReturn: r.grade!.relPct, hasCosts: true,
  }));
}

function rows(graded: AgentRecord[], key: (r: AgentRecord) => string, horizon: (r: AgentRecord) => string): AgentStatsRow[] {
  return groupStats(asOutcomes(graded, key, horizon))
    .map((g): AgentStatsRow => {
      const mine = graded.filter((r) => key(r) === g.setupKind);
      const enough = g.clusters >= CI_MIN_CLUSTERS;
      // hit comes from the grade (a falsified record is a miss even when it beat BTC), not from relPct > 0.
      return { key: g.setupKind, n: g.n, clusters: g.clusters, meanRelPct: enough ? g.meanNet : null, ci95: enough ? g.ci95 : null, hitRate: enough ? mine.filter((r) => r.grade!.hit).length / mine.length : null };
    })
    .sort((a, b) => (parseFloat(a.key) || 0) - (parseFloat(b.key) || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Track record over every record: counts for all, numbers from graded ones only (null under 5 clusters, as the ledger). */
export function agentStats(records: AgentRecord[]): AgentStatsResponse {
  const graded = records.filter((r) => r.grade !== null && r.direction !== null && Number.isFinite(r.grade.relPct));
  return {
    total: records.length,
    graded: graded.length,
    noCause: records.filter((r) => r.status === "no_cause").length,
    // By horizon: clustered per max(1 day, horizon). By layer: horizons mixed, clustered per day.
    byHorizon: rows(graded, (r) => `${r.horizonHours}h`, (r) => `${r.horizonHours}h`),
    byLayer: rows(graded, (r) => r.layer, () => "24h"),
  };
}
