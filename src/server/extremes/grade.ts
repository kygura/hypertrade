import { EXTREME_GRADE_HORIZONS, EXTREME_KINDS, EXTREME_STANCES, type ExtremeGrade, type ExtremeRecord } from "../../shared/extremes.js";
import { barTouch } from "../../shared/firstTouch.js";
import type { RingPoint } from "../platform/features.js";
import { horizonMs } from "../platform/outcomes.js";
import { SNAPSHOT_GRADE_TOLERANCE_MS, snapshotStreams } from "../platform/replaySource.js";
import type { PlatformStore } from "../platform/store.js";
import { gradeEvent, returnStats, type ReturnStats } from "./replay.js";

// Read-time grading of stored extremes (docs/EXTREMES.md § Grading). gradeExtreme and summarizeGrades are pure: a
// record, the coin's stored scan_snapshots (RingPoint stream), now and the take's opportunity levels in, numbers out;
// gradedExtremes reads the store.
// One evaluation path with the replay: each horizon is replay.ts gradeEvent on the event re-based at the verdict
// (ts = verdictAt, mark = verdictMark, side = the graded direction), with the snapshot tolerance (exit at the first
// stored tick in [start + horizon, + SNAPSHOT_GRADE_TOLERANCE_MS]). Gross returns, no fees or funding.
//   direction  a take's verdict.direction; the event's fade side for watch, pass and unanswered events
//   entry      verdictMark at verdictAt when stamped, else the event mark at the event bar
//   raw        hold to the horizon, whatever the levels
//   levels     takes only: the opportunity's stopPx and targetPx (the priced stop is the farther of the template and
//              the kill, at least 0.75 ATR; an unpriced take has stop = killPx and no target); `kill` when the take
//              has no opportunity to read: stop = killPx, no target
//   exit       the first stored mark in [start, min(now, start + 72 h)] at or beyond the stop or the target, by
//              shared/firstTouch.ts barTouch on a bar of that one mark (the stop fills at the mark that crossed it)
//   stopped    the trade as placed: the return at that exit once it happened at or before the horizon's exit tick, raw otherwise
//   killHit    takes only: some stored mark in that span at or beyond the verdict's killPx (≤ for a long);
//              null for watch/pass, and for a take with no stored mark in that span yet
// Known limit: touches are read on stored snapshot marks only (one per scan, about 5 min apart, gaps when the scanner
// was down), never on candle highs and lows: a wick through a level between two snapshots is not seen, so stop and
// target hits are undercounted and a stop that gapped fills at the next stored mark.

export const GRADE_TOLERANCE_MS = SNAPSHOT_GRADE_TOLERANCE_MS;
const LAST_MS = Math.max(...EXTREME_GRADE_HORIZONS.map(horizonMs));

/** Where grading starts: the verdict when its mark was stamped, else the event bar. */
function gradeStart(r: ExtremeRecord): { t: number; px: number; basis: ExtremeGrade["entryBasis"] } {
  return r.verdictMark != null && r.verdictAt ? { t: Date.parse(r.verdictAt), px: r.verdictMark, basis: "verdict" } : { t: Date.parse(r.event.ts), px: r.event.mark, basis: "event" };
}

/** The stop and target a take is graded against: its opportunity's (extremes/opportunity.ts), as the desk would place them. */
export type TakeLevels = { stopPx: number | null; targetPx: number | null };

export function gradeExtreme(r: ExtremeRecord, points: RingPoint[], now: number, opportunity: TakeLevels | null = null): ExtremeGrade {
  const take = r.verdict?.stance === "take" ? r.verdict : null;
  const direction = take?.direction ?? r.event.side;
  const start = gradeStart(r);
  const sign = direction === "long" ? 1 : -1;
  const streams = new Map([[r.event.coin, points]]);
  const rebased = { ...r.event, ts: new Date(start.t).toISOString(), mark: start.px, side: direction };
  const kill = take?.killPx ?? null;
  const levels: ExtremeGrade["levels"] = !take ? null : opportunity?.stopPx != null ? "opportunity" : "kill";
  const stopPx = !take ? null : (opportunity?.stopPx ?? kill);
  const targetPx = levels === "opportunity" ? (opportunity?.targetPx ?? null) : null;
  const seen = points.filter((p) => p.ts >= start.t && p.ts <= Math.min(now, start.t + LAST_MS));
  const killAt = kill == null ? null : (seen.find((p) => (direction === "long" ? p.mark <= kill : p.mark >= kill))?.ts ?? null);
  let exit: { kind: "stop" | "target"; px: number; ts: number } | null = null;
  if (stopPx != null)
    for (const p of seen) {
      const touch = barTouch(sign, stopPx, targetPx, { o: p.mark, h: p.mark, l: p.mark });
      if (touch) {
        exit = { kind: touch.exit, px: touch.px, ts: p.ts };
        break;
      }
    }
  const horizons = EXTREME_GRADE_HORIZONS.map((horizon) => {
    const h = horizonMs(horizon);
    const g = start.t + h <= now ? gradeEvent(rebased, streams, h, GRADE_TOLERANCE_MS) : null;
    if (!g) return { horizon, raw: null, stopped: null };
    // The exit tick gradeEvent read: the first point at or after start + h (within the tolerance, or it returned null).
    const exitTs = points.find((p) => p.ts >= start.t + h)!.ts;
    const stopped = exit && exit.ts <= exitTs ? sign * (exit.px / start.px - 1) : g.abs;
    return { horizon, raw: g.abs, stopped };
  });
  return {
    direction, entryPx: start.px, entryBasis: start.basis, horizons, killHit: take && seen.length ? killAt != null : null,
    levels, stopPx, targetPx, exit: exit && { kind: exit.kind, px: exit.px, at: new Date(exit.ts).toISOString() },
  };
}

export type ExtremeSummaryRow = {
  /** "stance" rows group by verdict stance (`none` = unanswered), "kind" rows by detector kind. */
  by: "stance" | "kind";
  group: string;
  n: number;
  /** Records with a 24 h return. */
  graded: number;
  /** `raw` is hold-to-horizon; `stopped` is the trade as placed (stop and target of the opportunity), equal to raw for non-takes. */
  horizons: Array<{ horizon: string; raw: ReturnStats; stopped: ReturnStats }>;
  /** Share of graded takes whose kill was crossed; null for groups without takes. */
  killHitRate: number | null;
  /** Graded takes by what their stop/target did so far (72 h cap): stopped, target reached, or neither; null for groups without takes. */
  exits: { stop: number; target: number; open: number } | null;
};

/** Per stance and per kind: n, graded n (24 h), returnStats per horizon (raw and stopped; n, clusters, interval null under 5 clusters), kill-hit rate and exits over takes. */
export function summarizeGrades(rows: Array<{ record: ExtremeRecord; grade: ExtremeGrade }>): ExtremeSummaryRow[] {
  const groups: Array<[ExtremeSummaryRow["by"], string, typeof rows]> = [
    ...[...EXTREME_STANCES, "none"].map((s): [ExtremeSummaryRow["by"], string, typeof rows] => ["stance", s, rows.filter((x) => (x.record.verdict?.stance ?? "none") === s)]),
    ...EXTREME_KINDS.map((k): [ExtremeSummaryRow["by"], string, typeof rows] => ["kind", k, rows.filter((x) => x.record.event.kind === k)]),
  ];
  return groups.map(([by, group, xs]) => {
    const takes = xs.filter((x) => x.grade.killHit != null);
    return {
      by, group, n: xs.length,
      graded: xs.filter((x) => x.grade.horizons.find((h) => h.horizon === "24h")?.raw != null).length,
      horizons: EXTREME_GRADE_HORIZONS.map((horizon) => {
        const hs = xs.map((x) => ({ h: x.grade.horizons.find((h) => h.horizon === horizon)!, atMs: gradeStart(x.record).t }));
        const stats = (k: "raw" | "stopped") => returnStats(hs.flatMap(({ h, atMs }) => (h[k] == null ? [] : [{ x: h[k]!, atMs }])), horizonMs(horizon));
        return { horizon, raw: stats("raw"), stopped: stats("stopped") };
      }),
      killHitRate: takes.length ? takes.filter((x) => x.grade.killHit).length / takes.length : null,
      exits: takes.length
        ? { stop: takes.filter((x) => x.grade.exit?.kind === "stop").length, target: takes.filter((x) => x.grade.exit?.kind === "target").length, open: takes.filter((x) => !x.grade.exit).length }
        : null,
    };
  });
}

/**
 * Records with their grade and the summary, from the store (GET /api/extremes, `bun run extremes score`). Bounded: one
 * scan_snapshots read per distinct coin, from that coin's earliest grading start, and one opportunity read per take.
 */
export async function gradedExtremes(store: Pick<PlatformStore, "scanSnapshotsSince" | "getOpportunity">, records: ExtremeRecord[], now: number) {
  const since = new Map<string, number>();
  for (const r of records) since.set(r.event.coin, Math.min(since.get(r.event.coin) ?? Infinity, gradeStart(r).t));
  const points = new Map<string, RingPoint[]>();
  for (const [coin, t] of since) points.set(coin, snapshotStreams(await store.scanSnapshotsSince(new Date(t).toISOString(), [coin])).get(coin) ?? []);
  // A take is graded against the levels of the opportunity it became (a failed read grades against the kill, as an unpriced take).
  const levels = new Map<string, TakeLevels | null>();
  for (const r of records)
    if (r.verdict?.stance === "take" && r.opportunityId) levels.set(r.opportunityId, await store.getOpportunity(r.opportunityId).catch(() => null));
  const rows = records.map((record) => ({ record, grade: gradeExtreme(record, points.get(record.event.coin) ?? [], now, record.opportunityId ? levels.get(record.opportunityId) : null) }));
  return { records: rows.map(({ record, grade }) => ({ ...record, grade })), summary: summarizeGrades(rows) };
}
