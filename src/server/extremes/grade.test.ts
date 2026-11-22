import { describe, expect, test } from "bun:test";
import type { ExtremeEvent, ExtremeRecord } from "../../shared/extremes.js";
import type { RingPoint } from "../platform/features.js";
import { GRADE_TOLERANCE_MS, gradeExtreme, summarizeGrades } from "./grade.js";
import { gradeEvent } from "./replay.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 14, 12);
const iso = (t: number) => new Date(t).toISOString();

const ev = (over: Partial<ExtremeEvent> = {}): ExtremeEvent => ({
  key: "price_dislocation|SOL|short", kind: "price_dislocation", coin: "SOL", side: "short", ts: iso(T0), window: "24h", mark: 100, severity: 5,
  facts: { ret: 0.2 }, line: "SOL +20% in 24h", ...over,
});
const rec = (over: Partial<ExtremeRecord> = {}): ExtremeRecord => ({ event: ev(), delivery: "woken", verdict: null, verdictAt: null, verdictMark: null, opportunityId: null, ...over });
/** 5-min points from T0 - 1 h to T0 + 80 h; mark from `f(hours since T0)`. */
const points = (f: (h: number) => number, skip?: (h: number) => boolean): RingPoint[] => {
  const out: RingPoint[] = [];
  for (let t = T0 - HOUR; t <= T0 + 80 * HOUR; t += 5 * 60_000) {
    const h = (t - T0) / HOUR;
    if (!skip?.(h)) out.push({ ts: t, mark: f(h), oiUsd: 1, funding: 0, dayNtlVlm: 1 });
  }
  return out;
};
const byH = (g: ReturnType<typeof gradeExtreme>, h: string) => g.horizons.find((x) => x.horizon === h)!;

describe("gradeExtreme", () => {
  test("an unanswered event: the fade side from the event bar and mark; the same number as the replay's gradeEvent", () => {
    const pts = points((h) => 100 - h * 0.1); // falling: the short fade wins
    const g = gradeExtreme(rec(), pts, T0 + 100 * HOUR);
    expect(g).toMatchObject({ direction: "short", entryPx: 100, entryBasis: "event", killHit: null });
    for (const [h, ms] of [["4h", 4 * HOUR], ["24h", 24 * HOUR], ["72h", 72 * HOUR]] as const) {
      expect(byH(g, h).raw).toBe(gradeEvent(ev(), new Map([["SOL", pts]]), ms, GRADE_TOLERANCE_MS)!.abs);
      expect(byH(g, h).stopped).toBe(byH(g, h).raw);
    }
    expect(byH(g, "24h").raw).toBeCloseTo(0.024, 6);
  });

  test("a take is graded in the verdict's direction from verdictMark at verdictAt; null before a horizon is reached", () => {
    const at = T0 + HOUR;
    const r = rec({ verdict: { key: "k", stance: "take", direction: "long", killPx: 90, cause: "x", sources: [] }, verdictAt: iso(at), verdictMark: 101 });
    const g = gradeExtreme(r, points((h) => 100 + h), at + 30 * HOUR);
    expect(g).toMatchObject({ direction: "long", entryPx: 101, entryBasis: "verdict", killHit: false });
    expect(byH(g, "4h").raw).toBeCloseTo(105 / 101 - 1, 9);
    expect(byH(g, "24h").raw).toBeCloseTo(125 / 101 - 1, 9);
    expect(byH(g, "72h")).toEqual({ horizon: "72h", raw: null, stopped: null });
  });

  test("a take whose kill was crossed: killHit, and the stopped return is capped at the kill from that horizon on", () => {
    const at = T0;
    const r = rec({ verdict: { key: "k", stance: "take", direction: "short", killPx: 110, cause: "x", sources: [] }, verdictAt: iso(at), verdictMark: 100 });
    // Up 1 an hour: crosses 110 at +10 h, ends far above.
    const g = gradeExtreme(r, points((h) => 100 + h), T0 + 100 * HOUR);
    expect(g.killHit).toBe(true);
    expect(byH(g, "4h").raw).toBeCloseTo(-0.04, 9);
    expect(byH(g, "4h").stopped).toBeCloseTo(-0.04, 9); // before the kill
    expect(byH(g, "24h").raw).toBeCloseTo(-0.24, 9);
    expect(byH(g, "24h").stopped).toBeCloseTo(-0.1, 9); // capped at the kill
    expect(byH(g, "72h").stopped).toBeCloseTo(-0.1, 9);
  });

  test("a priced take is graded against the opportunity's stop and target, not the kill: a kill inside the priced stop does not stop it", () => {
    // Short from 100, kill 105, priced stop 110 (the farther of template and kill), target 90. Up to 107 by +7 h, then down 2 an hour.
    const r = rec({ verdict: { key: "k", stance: "take", direction: "short", killPx: 105, cause: "x", sources: [] }, verdictAt: iso(T0), verdictMark: 100, opportunityId: "11111111-1111-4111-8111-111111111111" });
    const pts = points((h) => (h <= 7 ? 100 + h : Math.max(60, 107 - (h - 7) * 2)));
    const g = gradeExtreme(r, pts, T0 + 100 * HOUR, { stopPx: 110, targetPx: 90 });
    expect(g).toMatchObject({ killHit: true, levels: "opportunity", stopPx: 110, targetPx: 90, exit: { kind: "target", px: 90, at: iso(T0 + 15.5 * HOUR) } });
    expect(byH(g, "4h").stopped).toBeCloseTo(-0.04, 9); // before any level
    expect(byH(g, "24h").raw).toBeCloseTo(0.27, 9); // hold to 73
    expect(byH(g, "24h").stopped).toBeCloseTo(0.1, 9); // out at the target, not the hold
    expect(byH(g, "72h").stopped).toBeCloseTo(0.1, 9);
    // The same path against the kill alone (the old grade) stops at 105 for a loss.
    const old = gradeExtreme({ ...r, opportunityId: null }, pts, T0 + 100 * HOUR);
    expect(old).toMatchObject({ levels: "kill", stopPx: 105, targetPx: null, exit: { kind: "stop", px: 105 } });
    expect(byH(old, "24h").stopped).toBeCloseTo(-0.05, 9);
  });

  test("the priced stop is touched first: the stop return, at the stored mark that crossed it; an unpriced take has stop = kill and no target", () => {
    const r = rec({ verdict: { key: "k", stance: "take", direction: "long", killPx: 97, cause: "x", sources: [] }, verdictAt: iso(T0), verdictMark: 100 });
    const pts = points((h) => (h < 2 ? 100 : h < 3 ? 94.5 : 120)); // gaps through the 95 stop between two snapshots, then to the target
    const g = gradeExtreme(r, pts, T0 + 100 * HOUR, { stopPx: 95, targetPx: 110 });
    expect(g.exit).toMatchObject({ kind: "stop", px: 94.5 });
    expect(byH(g, "4h").stopped).toBeCloseTo(-0.055, 9);
    expect(byH(g, "24h").raw).toBeCloseTo(0.2, 9);
    expect(gradeExtreme(r, pts, T0 + 100 * HOUR, { stopPx: 97, targetPx: null })).toMatchObject({ levels: "opportunity", stopPx: 97, targetPx: null, exit: { kind: "stop" } });
    expect(gradeExtreme(rec(), pts, T0 + 100 * HOUR, { stopPx: 95, targetPx: 110 })).toMatchObject({ levels: null, stopPx: null, targetPx: null, exit: null }); // not a take
  });

  test("a verdict with no stamped mark grades from the event; no stored point near a horizon is null (tolerance)", () => {
    const r = rec({ verdict: { key: "k", stance: "pass", cause: "x", sources: [] }, verdictAt: iso(T0 + HOUR), verdictMark: null });
    const gap = (h: number) => h >= 4 && h < 4 + GRADE_TOLERANCE_MS / HOUR + 0.1;
    const g = gradeExtreme(r, points(() => 100, gap), T0 + 100 * HOUR);
    expect(g).toMatchObject({ entryBasis: "event", entryPx: 100, killHit: null });
    expect(byH(g, "4h").raw).toBeNull();
    expect(byH(g, "24h").raw).toBeCloseTo(0, 12);
  });

  test("a take with no stored mark since the verdict: killHit unknown (null), every horizon null", () => {
    const r = rec({ verdict: { key: "k", stance: "take", direction: "long", killPx: 90, cause: "x", sources: [] }, verdictAt: iso(T0), verdictMark: 100 });
    const g = gradeExtreme(r, [], T0 + 100 * HOUR);
    expect(g.killHit).toBeNull();
    expect(g.horizons.every((h) => h.raw === null && h.stopped === null)).toBe(true);
  });
});

describe("summarizeGrades", () => {
  test("groups by stance (none = unanswered) and by kind: n, graded n, raw and stopped stats, kill-hit rate over takes", () => {
    const take = (killPx: number) => rec({ verdict: { key: "k", stance: "take", direction: "short", killPx, cause: "x", sources: [] }, verdictAt: iso(T0), verdictMark: 100 });
    const pts = points((h) => 100 + h);
    const rows = [take(110), take(200), rec()].map((record) => ({ record, grade: gradeExtreme(record, pts, T0 + 100 * HOUR) }));
    const s = summarizeGrades(rows);
    const takes = s.find((r) => r.by === "stance" && r.group === "take")!;
    expect(takes).toMatchObject({ n: 2, graded: 2, killHitRate: 0.5 });
    const h24 = takes.horizons.find((h) => h.horizon === "24h")!;
    expect(h24.raw.mean).toBeCloseTo(-0.24, 9);
    expect(h24.stopped.mean).toBeCloseTo((-0.1 - 0.24) / 2, 9);
    expect(h24.raw.hitRate).toBe(0);
    expect(takes.exits).toEqual({ stop: 1, target: 0, open: 1 });
    // Three events of one bar are one cluster: n is shown, the interval is not.
    expect(s.find((r) => r.by === "kind" && r.group === "price_dislocation")!.horizons[1]!.raw).toMatchObject({ n: 3, clusters: 1, ci95: null });
    expect(s.find((r) => r.by === "stance" && r.group === "none")).toMatchObject({ n: 1, graded: 1, killHitRate: null, exits: null });
    expect(s.find((r) => r.by === "stance" && r.group === "watch")).toMatchObject({ n: 0, graded: 0 });
    expect(s.find((r) => r.by === "kind" && r.group === "price_dislocation")).toMatchObject({ n: 3, graded: 3, killHitRate: 0.5 });
  });
});
