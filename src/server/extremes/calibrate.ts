import {
  EXTREME_KINDS, ExtremeThresholdsSchema,
  type ExtremeCalibrationKind, type ExtremeCalibrationResult, type ExtremeEvent, type ExtremeKind, type ExtremeThresholds, type StoredExtremeCalibration,
} from "../../shared/extremes.js";
import type { Alert } from "../desk/notify.js";
import type { RingPoint } from "../platform/features.js";
import type { PlatformStore } from "../platform/store.js";
import { selectUniverse } from "../platform/universe.js";
import { BTC_COIN, DEFAULT_EXTREME_THRESHOLDS, eventsOf, readExtremes, rethreshold, type ExtremeReadings } from "./detect.js";
import { RANK_WINDOW_MS } from "./job.js";
import { gradeEvent, returnStats } from "./replay.js";

// Calibration of the extremes detectors (docs/EXTREMES.md § Calibration pipeline). Pure: streams in, a proposal out.
//
// FREQUENCY ONLY. Each kind's thresholds are tuned so the kind fires at a target rate (events a week across the job's
// universe). Forward returns are computed and reported next to the result for information, and they NEVER enter the
// objective: a few events a week say nothing about edge, and fitting cuts to them would be curve-fitting on noise.
//
// One knob per kind: a positive multiplier k scales that kind's sigma cuts in the code defaults (hard floors such as
// minMove and minDrop are never touched). Larger k is stricter, so a reading that fires at k fires at every smaller k.
//   price_dislocation  price.z and price.zResid, every window
//   oi_flush           oiFlush.z (every window) and oiFlush.zPrice
//   crowded_asymmetry  crowded.minAprPct. Not zFunding: funding sits at HL's default most of the time, its MAD is
//                      tiny and the level z runs to tens, so a z cut between 0.5x and 2.5x of 5 passes the same
//                      readings (detect.ts). Not the percentile: 30 days of hourly samples put 1 − pctile at 7
//                      samples, so its steps are coarse and ties at the default rate saturate it. The apr bar is the
//                      one continuous cut that gates (the detector author found the same on candles).
//
// Guard rails: a run that cannot measure keeps the current thresholds (too little dense history, too short a replayed
// span, a kind whose input is missing); k moves at most ±maxStep from the applied multiplier per run and stays within
// [minMultiplier, maxMultiplier] of the code defaults; a kind already inside its band is left alone (no weekly jitter);
// one coin cannot carry the estimate (each coin counts at most perCoinCap events per kind in the window).
//
// Cheap search: readings are taken once per (coin, step) under the loosest thresholds any candidate can reach, only
// those that could fire are kept, and each candidate re-thresholds them (detect.ts rethreshold) and applies the same
// per-key cooldown as the live job and replayExtremes. eventsFromReadings equals replayExtremes' events for any
// thresholds at least as strict as the floor (calibrate.test.ts). No look-ahead: readExtremes reads ts <= step only,
// and the universe at a step is the job's (top N by the latest 24 h volume stored in the hour before it, plus BTC).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
type Env = Record<string, string | undefined>;

/** A 24 h window counts as dense with at least this many distinct snapshot times (half the 15-min grid). */
const DENSE_TICKS_PER_DAY = 48;
const HORIZONS_MS = [4 * HOUR, 24 * HOUR, 72 * HOUR];
/** Candidates tried per kind and run, geometric between the run's bounds (plus the current multiplier). */
const CANDIDATES = 25;

const CALIBRATION_KNOBS: Record<ExtremeKind, string> = {
  price_dislocation: "price.z, price.zResid",
  oi_flush: "oiFlush.z, oiFlush.zPrice",
  crowded_asymmetry: "crowded.minAprPct",
};
const READS_OI: Record<ExtremeKind, boolean> = { price_dislocation: false, oi_flush: true, crowded_asymmetry: true };

export interface CalibrationTargets {
  /** Events a week per kind the search aims at. */
  perWeek: number;
  /** The band: a kind whose rate is inside [min, max] keeps its thresholds. */
  min: number;
  max: number;
}
export interface CalibrationLimits {
  /** Days of dense history (DENSE_TICKS_PER_DAY) ending at the last step, at least. */
  minDenseDays: number;
  /** Days of replayed steps, at least (the detectors need 14 days of history before the first step). */
  minReplayDays: number;
  /** Per run, k moves at most this fraction from the applied multiplier. */
  maxStep: number;
  /** The cumulative multiplier stays within [minMultiplier, maxMultiplier] of the code defaults. */
  minMultiplier: number;
  maxMultiplier: number;
  /** Events one coin can count per kind in the window. */
  perCoinCap: number;
}

const num = (v: string | undefined, d: number, ok: (n: number) => boolean) => {
  const n = Number(v?.trim());
  return v?.trim() && Number.isFinite(n) && ok(n) ? n : d;
};
/** Targets and limits, env-overridable (EXTREMES_CALIBRATION_*; .env.example). An inconsistent band falls back to the defaults. */
export function calibrationParams(env: Env = process.env): { targets: CalibrationTargets; limits: CalibrationLimits } {
  const pos = (n: number) => n > 0;
  let targets: CalibrationTargets = {
    perWeek: num(env.EXTREMES_CALIBRATION_TARGET_WK, 1, pos),
    min: num(env.EXTREMES_CALIBRATION_MIN_WK, 0.5, (n) => n >= 0),
    max: num(env.EXTREMES_CALIBRATION_MAX_WK, 1.5, pos),
  };
  if (!(targets.min <= targets.perWeek && targets.perWeek <= targets.max)) targets = { perWeek: 1, min: 0.5, max: 1.5 };
  let limits: CalibrationLimits = {
    minDenseDays: num(env.EXTREMES_CALIBRATION_MIN_DAYS, 14, (n) => n >= 0),
    minReplayDays: num(env.EXTREMES_CALIBRATION_MIN_REPLAY_DAYS, 7, (n) => n >= 0),
    maxStep: num(env.EXTREMES_CALIBRATION_MAX_STEP, 0.25, (n) => n > 0 && n < 1),
    minMultiplier: num(env.EXTREMES_CALIBRATION_MULT_MIN, 0.5, pos),
    maxMultiplier: num(env.EXTREMES_CALIBRATION_MULT_MAX, 2.5, pos),
    perCoinCap: num(env.EXTREMES_CALIBRATION_PER_COIN_CAP, 2, (n) => Number.isInteger(n) && n >= 1),
  };
  if (!(limits.minMultiplier <= 1 && 1 <= limits.maxMultiplier)) limits = { ...limits, minMultiplier: 0.5, maxMultiplier: 2.5 };
  return { targets, limits };
}

// ---------------------------------------------------------------- the knob

const mapW = <K extends string>(r: Record<K, number>, k: number) => Object.fromEntries(Object.entries(r).map(([w, v]) => [w, (v as number) * k])) as Record<K, number>;

/** `th` with `kind`'s section replaced by the code defaults' section, its knob scaled by k. */
export function withMultiplier(th: ExtremeThresholds, kind: ExtremeKind, k: number, base: ExtremeThresholds = DEFAULT_EXTREME_THRESHOLDS): ExtremeThresholds {
  if (kind === "price_dislocation") return { ...th, price: { ...base.price, z: mapW(base.price.z, k), zResid: mapW(base.price.zResid, k) } };
  if (kind === "oi_flush") return { ...th, oiFlush: { ...base.oiFlush, z: mapW(base.oiFlush.z, k), zPrice: base.oiFlush.zPrice * k } };
  return { ...th, crowded: { ...base.crowded, minAprPct: base.crowded.minAprPct * k } };
}

/** The applied multiplier of `kind`'s knob relative to the code defaults (read from its first knob parameter). */
export function multiplierOf(th: ExtremeThresholds, kind: ExtremeKind, base: ExtremeThresholds = DEFAULT_EXTREME_THRESHOLDS): number {
  const [a, b] =
    kind === "price_dislocation" ? [th.price.z["4h"], base.price.z["4h"]] : kind === "oi_flush" ? [th.oiFlush.z["1h"], base.oiFlush.z["1h"]] : [th.crowded.minAprPct, base.crowded.minAprPct];
  return b > 0 ? round3(a / b) : 1;
}

const sectionOf = (th: ExtremeThresholds, kind: ExtremeKind) => (kind === "price_dislocation" ? { price: th.price } : kind === "oi_flush" ? { oiFlush: th.oiFlush } : { crowded: th.crowded });
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Field-wise the looser of two threshold sets (every cut is "at least", except maxFollowZ, "at most"). */
export function looser(a: ExtremeThresholds, b: ExtremeThresholds): ExtremeThresholds {
  const lo = <T>(x: T, y: T): T =>
    (typeof x === "number" ? Math.min(x, y as number) : Object.fromEntries(Object.entries(x as object).map(([k, v]) => [k, lo(v, (y as Record<string, unknown>)[k])]))) as T;
  const out = lo(a, b);
  out.crowded.maxFollowZ = Math.max(a.crowded.maxFollowZ, b.crowded.maxFollowZ);
  return out;
}

// ---------------------------------------------------------------- readings once, events per candidate

export type StepReadings = { now: number; readings: ExtremeReadings[] };

/**
 * Readings at each step for each coin in the step's universe (default: every stream), in replayExtremes' order (grid,
 * then stream order), keeping only those where some reading fires under `floor`: nothing stricter can fire on the rest.
 */
export function collectReadings(o: { streams: Map<string, RingPoint[]>; grid: number[]; floor: ExtremeThresholds; universe?: (now: number) => Set<string> }): StepReadings[] {
  const btc = o.streams.get(BTC_COIN) ?? null;
  const out: StepReadings[] = [];
  for (const now of o.grid) {
    const inUniverse = o.universe?.(now);
    const readings: ExtremeReadings[] = [];
    for (const [coin, points] of o.streams) {
      if (inUniverse && !inUniverse.has(coin)) continue;
      const r = readExtremes({ coin, points, btc: coin === BTC_COIN ? null : btc, now }, o.floor);
      if (r.price.some((x) => x.fires) || r.oi.some((x) => x.fires) || r.crowded?.fires) readings.push(r);
    }
    if (readings.length) out.push({ now, readings });
  }
  return out;
}

/** The events the live job would store under `th`: re-thresholded readings, one per kind and coin, per-key cooldown from the event's own step. */
export function eventsFromReadings(steps: StepReadings[], th: ExtremeThresholds, cooldownMs: number): ExtremeEvent[] {
  const last = new Map<string, number>();
  const out: ExtremeEvent[] = [];
  for (const { now, readings } of steps) {
    for (const r of readings) {
      for (const e of eventsOf(rethreshold(r, th), th)) {
        const prev = last.get(e.key);
        if (prev != null && now - prev < cooldownMs) continue;
        last.set(e.key, now);
        out.push(e);
      }
    }
  }
  return out;
}

/** The job's universe at each step: top N by the latest 24 h volume stored in [now − RANK_WINDOW_MS, now], plus BTC. */
export function universeFromStreams(streams: Map<string, RingPoint[]>, top: number, rankWindowMs = RANK_WINDOW_MS): (now: number) => Set<string> {
  return (now) => {
    const ranked: Array<{ coin: string; dayNtlVlm: number }> = [];
    for (const [coin, pts] of streams) {
      let lo = 0;
      let hi = pts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid]!.ts <= now) lo = mid + 1;
        else hi = mid;
      }
      const p = pts[lo - 1];
      if (p && p.ts >= now - rankWindowMs && Number.isFinite(p.dayNtlVlm)) ranked.push({ coin, dayNtlVlm: p.dayNtlVlm });
    }
    return new Set(selectUniverse(ranked, { top, mine: [BTC_COIN] }).map((c) => c.coin));
  };
}

/** Whole 24 h windows ending at `to`, counted back until the first with fewer than DENSE_TICKS_PER_DAY distinct snapshot times. */
export function denseDays(streams: Map<string, RingPoint[]>, to: number): number {
  const ts = new Set<number>();
  for (const pts of streams.values()) for (const p of pts) if (p.ts <= to) ts.add(p.ts);
  const perDay = new Map<number, number>();
  for (const t of ts) {
    const d = Math.floor((to - t) / DAY);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  let n = 0;
  while ((perDay.get(n) ?? 0) >= DENSE_TICKS_PER_DAY) n++;
  return n;
}

// ---------------------------------------------------------------- rate and the search

/** Events a week with each coin's contribution capped at `cap` (one coin cannot carry the estimate), plus the busiest coin. */
export function cappedRate(events: ExtremeEvent[], kind: ExtremeKind, weeks: number, cap: number): { events: number; rate: number | null; top: { coin: string; events: number } | null } {
  const per = new Map<string, number>();
  for (const e of events) if (e.kind === kind) per.set(e.coin, (per.get(e.coin) ?? 0) + 1);
  let n = 0;
  let capped = 0;
  let top: { coin: string; events: number } | null = null;
  for (const [coin, c] of [...per].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    n += c;
    capped += Math.min(c, cap);
    if (!top || c > top.events) top = { coin, events: c };
  }
  return { events: n, rate: weeks > 0 ? capped / weeks : null, top };
}

function forward(events: ExtremeEvent[], kind: ExtremeKind, streams: Map<string, RingPoint[]>, toleranceMs: number) {
  const es = events.filter((e) => e.kind === kind);
  return HORIZONS_MS.map((h) => {
    const s = returnStats(es.flatMap((e) => {
      const g = gradeEvent(e, streams, h, toleranceMs);
      return g ? [{ x: g.abs, atMs: Date.parse(e.ts) }] : [];
    }), h);
    return { horizon: `${h / HOUR}h`, abs: { n: s.n, hitRate: s.hitRate, median: s.median } };
  });
}

export interface CalibrateOpts {
  /** Each coin's stored history (snapshot streams; the CLI reads them one coin at a time). */
  streams: Map<string, RingPoint[]>;
  /** Steps to replay, ascending. */
  grid: number[];
  /** The thresholds the live job applies now (latest applied calibration, else the code defaults). */
  current: ExtremeThresholds;
  targets: CalibrationTargets;
  limits: CalibrationLimits;
  cooldownMs: number;
  /** The universe at a step (universeFromStreams); default every stream at every step. */
  universe?: (now: number) => Set<string>;
  /** Forward returns exit at the first point at most this long after the horizon (stored snapshots carry jitter). */
  gradeToleranceMs?: number;
}

/** The loosest thresholds a run can try: the current ones and every kind at the lowest multiplier. */
export function calibrationFloor(current: ExtremeThresholds, limits: CalibrationLimits): ExtremeThresholds {
  let floor = current;
  for (const kind of EXTREME_KINDS) floor = looser(floor, withMultiplier(current, kind, limits.minMultiplier));
  return floor;
}

function span(o: Pick<CalibrateOpts, "streams" | "grid" | "limits">) {
  const from = o.grid[0] ?? null;
  const to = o.grid.at(-1) ?? null;
  const weeks = from != null && to != null ? (to - from) / WEEK : 0;
  const dense = to != null ? denseDays(o.streams, to) : 0;
  const l = o.limits;
  const runReason =
    dense < l.minDenseDays ? `${dense} days of dense history, needs ${l.minDenseDays}`
    : weeks * 7 < l.minReplayDays ? `${(weeks * 7).toFixed(1)} days replayed, needs ${l.minReplayDays} (the detectors need 14 days of history before the first step)`
    : null;
  return { from, to, weeks, dense, runReason };
}

/** Takes the readings once (collectReadings under calibrationFloor) and decides (calibrateFromReadings). */
export function calibrateExtremes(o: CalibrateOpts): ExtremeCalibrationResult {
  const steps = span(o).runReason ? [] : collectReadings({ streams: o.streams, grid: o.grid, floor: calibrationFloor(o.current, o.limits), universe: o.universe });
  return calibrateFromReadings(o, steps);
}

/** The decision on readings already taken over `o.grid` under a floor at least as loose as calibrationFloor(o.current, o.limits). */
export function calibrateFromReadings(o: CalibrateOpts, readings: StepReadings[]): ExtremeCalibrationResult {
  const { targets: t, limits: l, current } = o;
  const { from, to, weeks, dense, runReason } = span(o);
  const hasOi = [...o.streams.values()].some((pts) => pts.some((p) => p.oiUsd > 0));
  const steps = runReason ? [] : readings;
  const eventsUnder = (th: ExtremeThresholds) => eventsFromReadings(steps, th, o.cooldownMs);
  const tol = o.gradeToleranceMs ?? 0;

  const before = eventsUnder(current);
  let thresholds = current;
  const decided = EXTREME_KINDS.map((kind) => {
    const reason = runReason ?? (READS_OI[kind] && !hasOi ? "reads OI; the streams carry none" : null);
    const b = cappedRate(before, kind, weeks, l.perCoinCap);
    const kBefore = multiplierOf(current, kind);
    const base = { kind, evaluable: !reason, reason, knob: CALIBRATION_KNOBS[kind], eventsBefore: b.events, rateBefore: reason ? null : b.rate, topCoinBefore: b.top, multiplierBefore: kBefore };
    if (reason || b.rate == null) return { ...base, evaluable: false, reason: reason ?? "nothing replayed", multiplier: kBefore, changed: false, unchanged: "not_evaluable" as const, limited: null };
    if (b.rate >= t.min && b.rate <= t.max) return { ...base, multiplier: kBefore, changed: false, unchanged: "in_band" as const, limited: null };

    // Candidates within this run's step and the cumulative clamp.
    const stepLo = kBefore * (1 - l.maxStep);
    const stepHi = kBefore * (1 + l.maxStep);
    let lo = Math.max(l.minMultiplier, stepLo);
    let hi = Math.min(l.maxMultiplier, stepHi);
    if (lo > hi) lo = hi = kBefore < l.minMultiplier ? l.minMultiplier : l.maxMultiplier;
    const ks = [...new Set([...Array.from({ length: CANDIDATES }, (_, i) => round3(lo * (hi / lo) ** (i / (CANDIDATES - 1)))), ...(kBefore >= lo && kBefore <= hi ? [kBefore] : [])])];
    const scored = ks.map((k) => ({ k, rate: cappedRate(eventsUnder(withMultiplier(current, kind, k)), kind, weeks, l.perCoinCap).rate! }));
    // Nearest the target; ties to the multiplier closest to the applied one (no move without a reason).
    const best = scored.sort((x, y) => Math.abs(x.rate - t.perWeek) - Math.abs(y.rate - t.perWeek) || Math.abs(Math.log(x.k / kBefore)) - Math.abs(Math.log(y.k / kBefore)))[0]!;
    if (Math.abs(best.rate - t.perWeek) >= Math.abs(b.rate - t.perWeek) || best.k === kBefore) {
      return { ...base, multiplier: kBefore, changed: false, unchanged: "clamped" as const, limited: null };
    }
    thresholds = { ...thresholds, ...sectionOf(withMultiplier(current, kind, best.k), kind) };
    const atBound = best.k === round3(lo) || best.k === round3(hi);
    const outOfBand = best.rate < t.min || best.rate > t.max;
    const limited = atBound && outOfBand ? ((best.k === round3(hi) ? hi === l.maxMultiplier : lo === l.minMultiplier) ? ("clamp" as const) : ("step" as const)) : null;
    return { ...base, multiplier: best.k, changed: true, unchanged: null, limited };
  });

  const after = eventsUnder(thresholds);
  const kinds: ExtremeCalibrationKind[] = decided.map((d) => {
    const a = cappedRate(after, d.kind, weeks, l.perCoinCap);
    return { ...d, eventsAfter: a.events, rateAfter: d.evaluable ? a.rate : null, forwardBefore: forward(before, d.kind, o.streams, tol), forwardAfter: forward(after, d.kind, o.streams, tol) };
  });
  return {
    from: from == null ? null : new Date(from).toISOString(),
    to: to == null ? null : new Date(to).toISOString(),
    weeks, denseDays: dense, coins: [...o.streams.keys()], target: { ...t }, reset: false, kinds, thresholds,
  };
}

/** The `--reset` row: the code defaults, applied as is (rollback). */
export function resetResult(targets: CalibrationTargets, ranAt: number): ExtremeCalibrationResult {
  const iso = new Date(ranAt).toISOString();
  return { from: iso, to: iso, weeks: 0, denseDays: 0, coins: [], target: { ...targets }, reset: true, kinds: [], thresholds: DEFAULT_EXTREME_THRESHOLDS };
}

// ---------------------------------------------------------------- applied thresholds (the live job's read)

export type AppliedThresholds = { thresholds: ExtremeThresholds; source: { id: number; ranAt: string } | "defaults" };
const loggedBad = new Set<number>();

/** A stored row's thresholds, zod-parsed (a stored row is a trust boundary). No row, or one that fails to parse: the code defaults (a bad row is logged once per process). */
export function thresholdsOfRun(row: StoredExtremeCalibration | null, log: (m: string) => void = console.error): AppliedThresholds {
  if (!row) return { thresholds: DEFAULT_EXTREME_THRESHOLDS, source: "defaults" };
  const p = ExtremeThresholdsSchema.safeParse(row.thresholds);
  if (p.success) return { thresholds: p.data, source: { id: row.id, ranAt: row.ranAt } };
  if (!loggedBad.has(row.id)) {
    loggedBad.add(row.id);
    log(`[extremes] calibration ${row.id} (${row.ranAt}) has unreadable thresholds, using the code defaults: ${p.error.issues[0]?.message ?? "invalid"}`);
  }
  return { thresholds: DEFAULT_EXTREME_THRESHOLDS, source: "defaults" };
}

/** The thresholds the live job applies: the latest applied calibration, else the code defaults (also when the read fails). */
export async function appliedThresholds(store: Pick<PlatformStore, "latestAppliedExtremeCalibration">, log: (m: string) => void = console.error): Promise<AppliedThresholds> {
  try {
    return thresholdsOfRun(await store.latestAppliedExtremeCalibration(), log);
  } catch (err) {
    log(`[extremes] calibration read failed, using the code defaults: ${err instanceof Error ? err.message : String(err)}`);
    return { thresholds: DEFAULT_EXTREME_THRESHOLDS, source: "defaults" };
  }
}

// ---------------------------------------------------------------- output

const r1 = (x: number | null) => (x == null ? "-" : x.toFixed(1));

/** One info push when an applied run changed a threshold (facts only); null when nothing changed. */
export function calibrationAlert(r: ExtremeCalibrationResult): Alert | null {
  if (!r.kinds.some((k) => k.changed)) return null;
  const parts = r.kinds.map((k) =>
    k.changed ? `${k.kind} ×${k.multiplier.toFixed(2)} (${r1(k.rateBefore)} → ${r1(k.rateAfter)}/wk)`
    : k.unchanged === "not_evaluable" ? `${k.kind} not evaluable`
    : `${k.kind} unchanged (${r1(k.rateBefore)}/wk)`,
  );
  return { level: "info", title: "Extremes recalibrated", body: parts.join(", ") };
}

/** The compact table (markdown: the CLI prints it, the workflow appends it to the step summary). */
export function calibrationTable(r: ExtremeCalibrationResult, run: { id: number; applied: boolean }): string[] {
  const head = r.reset
    ? `Extremes calibration #${run.id}: reset to the code defaults${run.applied ? " (applied)" : ""}`
    : `Extremes calibration #${run.id}: ${r.from ?? "-"} → ${r.to ?? "-"} (${r.weeks.toFixed(1)} weeks, ${r.coins.length} coins, ${r.denseDays} dense days), target ${r.target.perWeek}/wk in [${r.target.min}, ${r.target.max}], ${run.applied ? "applied" : "not applied"}`;
  if (r.reset) return [head];
  const lines = [head, "", "| kind | evaluable | rate/wk before → after | events | multiplier | changed |", "|---|---|---|---|---|---|"];
  for (const k of r.kinds) {
    const why = k.changed ? `yes${k.limited ? ` (${k.limited})` : ""}` : `no (${k.unchanged === "not_evaluable" ? k.reason : k.unchanged})`;
    const top = k.topCoinBefore && k.topCoinBefore.events > 1 ? `, top ${k.topCoinBefore.coin} ${k.topCoinBefore.events}` : "";
    lines.push(`| ${k.kind} | ${k.evaluable ? "yes" : "no"} | ${r1(k.rateBefore)} → ${r1(k.rateAfter)} | ${k.eventsBefore} → ${k.eventsAfter}${top} | ${k.multiplierBefore.toFixed(2)} → ${k.multiplier.toFixed(2)} | ${why} |`);
  }
  lines.push("", "Rates count at most the per-coin cap of events per coin. Forward returns are in the JSON for information; they never enter the objective.");
  return lines;
}
