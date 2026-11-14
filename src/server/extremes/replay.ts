import { EXTREME_KINDS, type ExtremeEvent, type ExtremeKind } from "../../shared/extremes.js";
import { median } from "../../shared/signalMath.js";
import type { RingPoint } from "../platform/features.js";
import { BTC_COIN, DEFAULT_EXTREME_THRESHOLDS, detectExtremes, type ExtremeThresholds } from "./detect.js";

// Replay of the extremes detector over historical streams (pure). Each grid step runs detectExtremes per coin on the
// points up to that step, with a per-key cooldown as the live job applies it (an event blocks its key for cooldownMs
// from its own ts; a suppressed hit does not extend it). Each event is graded on the fade side (event.side) at fixed
// horizons: the gross return from the mark at the event to the stream's mark at ts + horizon (exactly, or the first
// point within gradeToleranceMs after it), absolute and minus BTC's return over the same span. No fees or funding.
// A kind reading OI is not evaluable when no stream carries OI (HL candles have none): reported as such, never as 0 events.

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const DEFAULT_EXTREME_COOLDOWN_MS = 24 * HOUR;
const DEFAULT_EXTREME_HORIZONS_MS = [4 * HOUR, 24 * HOUR, 72 * HOUR];
const READS_OI: Record<ExtremeKind, boolean> = { price_dislocation: false, oi_flush: true, crowded_asymmetry: true };

export type ReturnStats = { n: number; hitRate: number | null; median: number | null; mean: number | null };
type ExtremeReplayRow = {
  kind: ExtremeKind;
  evaluable: boolean;
  reason?: string;
  events: number;
  long: number;
  short: number;
  /** Events per week over the grid span, null when not evaluable. */
  perWeek: number | null;
  horizons: Array<{ horizon: string; abs: ReturnStats; vsBtc: ReturnStats }>;
};
export type ExtremeReplayResult = { from: number | null; to: number | null; weeks: number; coins: string[]; rows: ExtremeReplayRow[]; events: ExtremeEvent[] };

export interface ExtremeReplayOpts {
  streams: Map<string, RingPoint[]>;
  /** Steps to evaluate at, ascending. */
  grid: number[];
  cooldownMs?: number;
  horizonsMs?: number[];
  thresholds?: ExtremeThresholds;
  /** Exit at the first point at most this long after the horizon (stored snapshots carry clock jitter); 0 = exactly there. */
  gradeToleranceMs?: number;
}

/** Index of the first point with ts >= t. */
function lower(points: RingPoint[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Mark of the first point in [t, t + toleranceMs] (0 on the candle grid: exactly t), else null. */
function markAt(points: RingPoint[] | undefined, t: number, toleranceMs: number): number | null {
  const p = points?.[lower(points, t)];
  return p && p.ts <= t + toleranceMs && p.mark > 0 ? p.mark : null;
}

const horizonLabel = (ms: number) => (ms % HOUR === 0 ? `${ms / HOUR}h` : `${ms / 60_000}m`);

export function returnStats(xs: number[]): ReturnStats {
  if (!xs.length) return { n: 0, hitRate: null, median: null, mean: null };
  return { n: xs.length, hitRate: xs.filter((x) => x > 0).length / xs.length, median: median(xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length };
}

/** Fade-side return of an event at a horizon, absolute and vs BTC (null for BTC itself or without BTC marks). */
export function gradeEvent(e: ExtremeEvent, streams: Map<string, RingPoint[]>, horizonMs: number, toleranceMs = 0): { abs: number; vsBtc: number | null } | null {
  const t0 = Date.parse(e.ts);
  const exit = markAt(streams.get(e.coin), t0 + horizonMs, toleranceMs);
  if (exit == null) return null;
  const sign = e.side === "long" ? 1 : -1;
  const ret = exit / e.mark - 1;
  const btc = streams.get(BTC_COIN);
  const [b0, b1] = [markAt(btc, t0, toleranceMs), markAt(btc, t0 + horizonMs, toleranceMs)];
  return { abs: sign * ret, vsBtc: e.coin !== BTC_COIN && b0 != null && b1 != null ? sign * (ret - (b1 / b0 - 1)) : null };
}

export function replayExtremes(o: ExtremeReplayOpts): ExtremeReplayResult {
  const cooldownMs = o.cooldownMs ?? DEFAULT_EXTREME_COOLDOWN_MS;
  const horizons = o.horizonsMs ?? DEFAULT_EXTREME_HORIZONS_MS;
  const thresholds = o.thresholds ?? DEFAULT_EXTREME_THRESHOLDS;
  const btc = o.streams.get(BTC_COIN) ?? null;
  const last = new Map<string, number>();
  const events: ExtremeEvent[] = [];
  for (const now of o.grid) {
    for (const [coin, points] of o.streams) {
      for (const e of detectExtremes({ coin, points, btc: coin === BTC_COIN ? null : btc, now }, thresholds)) {
        const prev = last.get(e.key);
        if (prev != null && now - prev < cooldownMs) continue;
        last.set(e.key, now);
        events.push(e);
      }
    }
  }
  const hasOi = [...o.streams.values()].some((pts) => pts.some((p) => p.oiUsd > 0));
  const from = o.grid[0] ?? null;
  const to = o.grid.at(-1) ?? null;
  const weeks = from != null && to != null ? (to - from) / WEEK : 0;
  const rows = EXTREME_KINDS.map((kind): ExtremeReplayRow => {
    const es = events.filter((e) => e.kind === kind);
    const evaluable = !READS_OI[kind] || hasOi;
    return {
      kind, evaluable, ...(!evaluable && { reason: "reads OI; the streams carry none (HL candles have no OI history)" }),
      events: es.length, long: es.filter((e) => e.side === "long").length, short: es.filter((e) => e.side === "short").length,
      perWeek: evaluable && weeks > 0 ? es.length / weeks : null,
      horizons: horizons.map((h) => {
        const g = es.flatMap((e) => gradeEvent(e, o.streams, h, o.gradeToleranceMs) ?? []);
        return { horizon: horizonLabel(h), abs: returnStats(g.map((x) => x.abs)), vsBtc: returnStats(g.flatMap((x) => x.vsBtc ?? [])) };
      }),
    };
  });
  return { from, to, weeks, coins: [...o.streams.keys()], rows, events };
}
