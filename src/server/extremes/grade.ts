import { EXTREME_GRADE_HORIZONS, EXTREME_KINDS, EXTREME_STANCES, type ExtremeGrade, type ExtremeRecord } from "../../shared/extremes.js";
import type { RingPoint } from "../platform/features.js";
import { horizonMs } from "../platform/outcomes.js";
import { SNAPSHOT_GRADE_TOLERANCE_MS, snapshotStreams } from "../platform/replaySource.js";
import type { PlatformStore } from "../platform/store.js";
import { gradeEvent, returnStats, type ReturnStats } from "./replay.js";

// Read-time grading of stored extremes (docs/EXTREMES.md § Grading). gradeExtreme and summarizeGrades are pure: a
// record, the coin's stored scan_snapshots (RingPoint stream) and now in, numbers out; gradedExtremes reads the store.
// One evaluation path with the replay: each horizon is replay.ts gradeEvent on the event re-based at the verdict
// (ts = verdictAt, mark = verdictMark, side = the graded direction), with the snapshot tolerance (exit at the first
// stored tick in [start + horizon, + SNAPSHOT_GRADE_TOLERANCE_MS]). Gross returns, no fees or funding.
//   direction  a take's verdict.direction; the event's fade side for watch, pass and unanswered events
//   entry      verdictMark at verdictAt when stamped, else the event mark at the event bar
//   killHit    takes only: some stored mark in [start, min(now, start + 72 h)] at or beyond killPx (≤ for a long);
//              null for watch/pass, and for a take with no stored mark in that span yet
//   stopped    a take's return capped at the kill level when the kill was crossed at or before the horizon's exit tick

export const GRADE_TOLERANCE_MS = SNAPSHOT_GRADE_TOLERANCE_MS;
const LAST_MS = Math.max(...EXTREME_GRADE_HORIZONS.map(horizonMs));

/** Where grading starts: the verdict when its mark was stamped, else the event bar. */
export function gradeStart(r: ExtremeRecord): { t: number; px: number; basis: ExtremeGrade["entryBasis"] } {
  return r.verdictMark != null && r.verdictAt ? { t: Date.parse(r.verdictAt), px: r.verdictMark, basis: "verdict" } : { t: Date.parse(r.event.ts), px: r.event.mark, basis: "event" };
}

export function gradeExtreme(r: ExtremeRecord, points: RingPoint[], now: number): ExtremeGrade {
  const take = r.verdict?.stance === "take" ? r.verdict : null;
  const direction = take?.direction ?? r.event.side;
  const start = gradeStart(r);
  const sign = direction === "long" ? 1 : -1;
  const streams = new Map([[r.event.coin, points]]);
  const rebased = { ...r.event, ts: new Date(start.t).toISOString(), mark: start.px, side: direction };
  const kill = take?.killPx ?? null;
  const crossed = (p: RingPoint) => kill != null && (direction === "long" ? p.mark <= kill : p.mark >= kill);
  const seen = points.filter((p) => p.ts >= start.t && p.ts <= Math.min(now, start.t + LAST_MS));
  const killAt = kill == null ? null : (seen.find(crossed)?.ts ?? null);
  const horizons = EXTREME_GRADE_HORIZONS.map((horizon) => {
    const h = horizonMs(horizon);
    const g = start.t + h <= now ? gradeEvent(rebased, streams, h, GRADE_TOLERANCE_MS) : null;
    if (!g) return { horizon, raw: null, stopped: null };
    // The exit tick gradeEvent read: the first point at or after start + h (within the tolerance, or it returned null).
    const exitTs = points.find((p) => p.ts >= start.t + h)!.ts;
    const stopped = killAt != null && killAt <= exitTs ? sign * (kill! / start.px - 1) : g.abs;
    return { horizon, raw: g.abs, stopped };
  });
  return { direction, entryPx: start.px, entryBasis: start.basis, horizons, killHit: take && seen.length ? killAt != null : null };
}

export type ExtremeSummaryRow = {
  /** "stance" rows group by verdict stance (`none` = unanswered), "kind" rows by detector kind. */
  by: "stance" | "kind";
  group: string;
  n: number;
  /** Records with a 24 h return. */
  graded: number;
  horizons: Array<{ horizon: string; raw: ReturnStats; stopped: ReturnStats }>;
  /** Share of graded takes whose kill was crossed; null for groups without takes. */
  killHitRate: number | null;
};

/** Per stance and per kind: n, graded n (24 h), returnStats per horizon (raw and stopped), kill-hit rate over takes. */
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
        const hs = xs.map((x) => x.grade.horizons.find((h) => h.horizon === horizon)!);
        return { horizon, raw: returnStats(hs.flatMap((h) => h.raw ?? [])), stopped: returnStats(hs.flatMap((h) => h.stopped ?? [])) };
      }),
      killHitRate: takes.length ? takes.filter((x) => x.grade.killHit).length / takes.length : null,
    };
  });
}

/**
 * Records with their grade and the summary, from the store (GET /api/extremes, `bun run extremes score`). Bounded: one
 * scan_snapshots read per distinct coin, from that coin's earliest grading start.
 */
export async function gradedExtremes(store: Pick<PlatformStore, "scanSnapshotsSince">, records: ExtremeRecord[], now: number) {
  const since = new Map<string, number>();
  for (const r of records) since.set(r.event.coin, Math.min(since.get(r.event.coin) ?? Infinity, gradeStart(r).t));
  const points = new Map<string, RingPoint[]>();
  for (const [coin, t] of since) points.set(coin, snapshotStreams(await store.scanSnapshotsSince(new Date(t).toISOString(), [coin])).get(coin) ?? []);
  const rows = records.map((record) => ({ record, grade: gradeExtreme(record, points.get(record.event.coin) ?? [], now) }));
  return { records: rows.map(({ record, grade }) => ({ ...record, grade })), summary: summarizeGrades(rows) };
}
