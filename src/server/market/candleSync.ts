// Candle sync engine. One stored series per (coin, timeframe), layered by source:
//
//   newest ── Hyperliquid (native interval, latest 5000 bars; the cron keeps
//             persisting them so LTF history outlives HL's window)
//          ── Binance spot (below HL's floor)
//          ── Bitstamp (below Binance's floor; BTC reaches 2011)
//   oldest
//
// 1w and 1M have no external layer of their own: below HL's floor they are
// resampled from stored daily bars, aligned to HL's own weekly phase and to
// calendar months, so the stitched series never shifts its bucket edges.
//
// Every layer only writes strictly below the layer above it, and an external
// source is only trusted after a seam check: its bars must agree with the
// bars it sits under (same coin, not a same-ticker impostor or a rebased token).
import { fetchCandles as fetchHlCandles } from "../../shared/hl-client.js";
import { TF_MS, type Timeframe } from "../../shared/timeframes.js";
import * as db from "../db.js";
import { EXTERNAL_SOURCES, type ExternalSource, type ExtBar } from "./sources.js";

const DAY = 86_400_000;

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  src: string;
}

export type LayerState = db.ExtLayerState;
export type SyncState = db.SyncState;

/** Everything the engine touches, injectable so tests never hit a network or DB. */
export interface SyncDeps {
  now(): number;
  hlCandles(coin: string, tf: Timeframe, start: number, end: number): Promise<Omit<Bar, "src">[]>;
  sources: readonly ExternalSource[];
  getState(coin: string, series: string): Promise<SyncState>;
  saveState(s: SyncState): Promise<void>;
  /** Oldest/newest stored bar of any source. */
  bounds(coin: string, tf: Timeframe): Promise<{ min: number; max: number } | null>;
  between(coin: string, tf: Timeframe, from: number, to: number): Promise<Bar[]>;
  before(coin: string, tf: Timeframe, before: number, limit: number): Promise<Bar[]>;
  upsert(coin: string, tf: Timeframe, bars: Bar[]): Promise<void>;
}

const toBar = (c: db.Candle): Bar => ({
  t: new Date(c.ts).getTime(),
  o: c.o,
  h: c.h,
  l: c.l,
  c: c.c,
  v: c.v ?? 0,
  src: c.src ?? "hl",
});

export const defaultDeps: SyncDeps = {
  now: () => Date.now(),
  hlCandles: (coin, tf, start, end) => fetchHlCandles(coin, tf, start, end),
  sources: EXTERNAL_SOURCES,
  getState: db.getSyncState,
  saveState: db.saveSyncState,
  async bounds(coin, tf) {
    const c = await db.candleCoverage(coin, tf);
    return c ? { min: c.min.getTime(), max: c.max.getTime() } : null;
  },
  async between(coin, tf, from, to) {
    return (await db.getCandlesBetween(coin, tf, new Date(from), new Date(to))).map(toBar);
  },
  async before(coin, tf, before, limit) {
    return (await db.getCandlesBefore(coin, tf, new Date(before), limit)).map(toBar);
  },
  async upsert(coin, tf, bars) {
    if (bars.length === 0) return;
    await db.upsertCandles(bars.map((b) => ({ coin, tf, ts: new Date(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, src: b.src })));
  },
};

// ─── pure helpers ───

/** Start of the UTC calendar month containing t, shifted by `add` months. */
export function monthStart(t: number, add = 0): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1);
}

/** Open time of the bar after the one opening at t. */
export function nextBarT(t: number, tf: Timeframe): number {
  return tf === "1M" ? monthStart(t, 1) : t + TF_MS[tf];
}

/** True when `next` is more than one bar after `prev` (a hole in the series). */
export function isGap(prev: number, next: number, tf: Timeframe): boolean {
  return next > nextBarT(prev, tf) + TF_MS[tf] / 2;
}

/**
 * HL pads the start of a listing with zero-volume bars (hl-cycles merges its
 * daily history from "the first HL candle with non-zero volume"). The series
 * starts at the first real trade, so older history comes from a venue that
 * actually traded it.
 */
export function dropLeadingEmpty<T extends { v: number }>(bars: T[]): T[] {
  const i = bars.findIndex((b) => b.v > 0);
  return i === -1 ? [] : i === 0 ? bars : bars.slice(i);
}

const SEAM_TOLERANCE = 0.03;
const SEAM_ADJACENT_TOLERANCE = 0.1;

/**
 * Does an external page belong under the reference bars (the layer above)?
 * Bars at the same open time must close within 3% of each other (median over
 * the overlap). With no overlap — the venue's history ends before the layer
 * above begins — its last close must be within 10% of the reference's first
 * open and within three bars of it. Anything else is a different asset.
 */
export function seamOk(ext: ExtBar[], ref: { t: number; o: number; c: number }[], tf: Timeframe): boolean {
  if (ext.length === 0 || ref.length === 0) return false;
  const byT = new Map(ref.map((r) => [r.t, r]));
  const devs: number[] = [];
  for (const b of ext) {
    const r = byT.get(b.t);
    if (r && r.c > 0) devs.push(Math.abs(b.c / r.c - 1));
  }
  if (devs.length > 0) {
    devs.sort((a, b) => a - b);
    return devs[Math.floor(devs.length / 2)]! <= SEAM_TOLERANCE;
  }
  const last = ext[ext.length - 1]!;
  const first = [...ref].sort((a, b) => a.t - b.t)[0]!;
  if (first.t - last.t > 3 * TF_MS[tf]) return false;
  return first.o > 0 && Math.abs(last.c / first.o - 1) <= SEAM_ADJACENT_TOLERANCE;
}

/**
 * Aggregates daily bars into 1w/1M buckets. Weekly buckets share `weekPhase`
 * (an HL weekly open time) so they line up with HL's own weekly bars. Only
 * buckets with both their first and last day present are emitted: a partial
 * bucket at the edge of the daily history would draw a fake bar.
 */
export function resampleDaily(daily: Bar[], tf: "1w" | "1M", weekPhase: number): Bar[] {
  const WEEK = 7 * DAY;
  const bucketOf = (t: number) =>
    tf === "1M" ? monthStart(t) : t - ((((t - weekPhase) % WEEK) + WEEK) % WEEK);
  const groups = new Map<number, Bar[]>();
  for (const d of [...daily].sort((a, b) => a.t - b.t)) {
    const k = bucketOf(d.t);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }
  const out: Bar[] = [];
  for (const [start, days] of groups) {
    const end = tf === "1M" ? monthStart(start, 1) : start + WEEK;
    if (days[0]!.t !== start || days[days.length - 1]!.t !== end - DAY) continue;
    const srcCount = new Map<string, number>();
    for (const d of days) srcCount.set(d.src, (srcCount.get(d.src) ?? 0) + 1);
    out.push({
      t: start,
      o: days[0]!.o,
      h: Math.max(...days.map((d) => d.h)),
      l: Math.min(...days.map((d) => d.l)),
      c: days[days.length - 1]!.c,
      v: days.reduce((a, d) => a + d.v, 0),
      src: [...srcCount.entries()].sort((a, b) => b[1] - a[1])[0]![0],
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** One retry after a short pause: public market-data endpoints blip. */
async function fetchWithRetry(src: ExternalSource, coin: string, tf: Timeframe, end: number) {
  try {
    return await src.fetchBefore(coin, tf, end, src.pageSize);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return src.fetchBefore(coin, tf, end, src.pageSize);
  }
}

// ─── head sync ───

const HEAD_MIN_INTERVAL_MS = 30_000;
const HL_WINDOW_BARS = 5000;

/**
 * Brings the newest bars up to date from Hyperliquid. The last stored bar is
 * re-fetched too (it was probably still open). A hole between the stored tail
 * and HL's window — the cron stopped for longer than 5000 bars — is filled
 * from the external layers. Throttled per series unless `force`.
 */
export async function syncHead(coin: string, tf: Timeframe, deps: SyncDeps = defaultDeps, force = false): Promise<void> {
  const now = deps.now();
  const state = await deps.getState(coin, tf);
  if (!force && state.syncedAt != null && now - state.syncedAt < HEAD_MIN_INTERVAL_MS) return;

  const b = await deps.bounds(coin, tf);
  const start = b ? b.max : Math.max(0, now - HL_WINDOW_BARS * TF_MS[tf]);
  try {
    const raw = await deps.hlCandles(coin, tf, start, now);
    const bars = (b == null ? dropLeadingEmpty(raw) : raw).map((c) => ({ ...c, src: "hl" }));
    await deps.upsert(coin, tf, bars);
    if (bars.length > 0) {
      if (b == null && isGap(start, bars[0]!.t, tf)) {
        // Asked for HL's whole window and it starts later: listing date.
        state.hlFloor = bars[0]!.t;
      }
      if (b != null && isGap(b.max, bars[0]!.t, tf)) {
        await fillGapExternal(coin, tf, b.max, bars[0]!.t, deps);
      }
    }
    state.syncedAt = now;
    state.error = null;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  await deps.saveState(state);
}

/** Fills (after, before) exclusive from the first external source that passes the seam check. */
async function fillGapExternal(coin: string, tf: Timeframe, after: number, before: number, deps: SyncDeps): Promise<void> {
  for (const src of deps.sources) {
    if (!src.supports(tf)) continue;
    let end = before - 1;
    for (let page = 0; page < 5 && end > after; page++) {
      const res = await fetchWithRetry(src, coin, tf, end);
      if (res.kind === "unsupported") break;
      const refs = await deps.between(coin, tf, before, nextBarT(before, tf) + 2 * TF_MS[tf]);
      if (page === 0 && !seamOk(res.bars, refs, tf)) break;
      const keep = res.bars.filter((x) => x.t > after && x.t < before);
      await deps.upsert(coin, tf, keep.map((x) => ({ ...x, src: src.id })));
      if (keep.length === 0 || res.bars.length < src.pageSize) return;
      end = keep[0]!.t - 1;
    }
    return;
  }
}

// ─── older history ───

export interface FillResult {
  added: number;
  /** Every layer has been walked to its floor: nothing older exists anywhere. */
  exhausted: boolean;
}

export interface FillBudget {
  /** External pages per call, across all layers. */
  extPages: number;
  deadline: number;
}

const DEFAULT_EXT_PAGES = 5;

/**
 * Stores up to `need` bars older than `endExclusive`, walking down the layers:
 * Hyperliquid first, then each external source below the previous floor.
 */
export async function fillOlder(
  coin: string,
  tf: Timeframe,
  endExclusive: number,
  need: number,
  deps: SyncDeps = defaultDeps,
  budget: FillBudget = { extPages: DEFAULT_EXT_PAGES, deadline: Infinity },
): Promise<FillResult> {
  const state = await deps.getState(coin, tf);
  let cursor = endExclusive;
  let added = 0;
  const tfMs = TF_MS[tf];

  try {
    // Hyperliquid: one request covers its whole remaining window.
    if (state.hlFloor == null || cursor > state.hlFloor) {
      const start = Math.max(0, cursor - (need + 1) * tfMs);
      const raw = await deps.hlCandles(coin, tf, start, cursor - 1);
      const bars = dropLeadingEmpty(raw.filter((c) => c.t < cursor)).map((c) => ({ ...c, src: "hl" }));
      await deps.upsert(coin, tf, bars);
      added += bars.length;
      if (bars.length === 0) {
        state.hlFloor = cursor;
      } else {
        if (isGap(start, bars[0]!.t, tf)) state.hlFloor = bars[0]!.t;
        cursor = bars[0]!.t;
      }
    }

    // Below HL's floor. Weekly/monthly are resampled from daily bars.
    if (added < need && state.hlFloor != null) {
      cursor = Math.min(cursor, state.hlFloor);
      if (tf === "1w" || tf === "1M") {
        const r = await fillResampled(coin, tf, state, cursor, need - added, deps, budget);
        added += r.added;
      } else {
        added += await fillExternal(coin, tf, state, cursor, need - added, deps, budget);
      }
    }
    state.error = null;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  await deps.saveState(state);
  return { added, exhausted: state.error == null && isExhausted(state, tf, deps.sources) };
}

/** No layer has anything left below what is stored. */
export function isExhausted(state: SyncState, tf: Timeframe, sources: readonly ExternalSource[]): boolean {
  if (state.hlFloor == null) return false;
  if (tf === "1w" || tf === "1M") {
    const r = state.ext.resample;
    return r?.exhausted === true || r?.status === "none";
  }
  return sources
    .filter((s) => s.supports(tf))
    .every((s) => {
      const l = state.ext[s.id];
      return l != null && (l.status === "none" || l.exhausted);
    });
}

async function fillExternal(
  coin: string,
  tf: Timeframe,
  state: SyncState,
  cursorIn: number,
  need: number,
  deps: SyncDeps,
  budget: FillBudget,
): Promise<number> {
  let added = 0;
  let cursor = cursorIn;
  let upper = state.hlFloor!; // external bars sit strictly below the layer above
  for (const src of deps.sources) {
    if (!src.supports(tf)) continue;
    const layer: LayerState = state.ext[src.id] ?? { status: "ok", floor: null, exhausted: false };
    // First contact overlaps the layer above by a few bars for the seam check.
    let firstContact = state.ext[src.id] == null;
    if (layer.status === "none") continue;

    cursor = Math.min(cursor, upper);
    while (added < need && budget.extPages > 0 && Date.now() < budget.deadline) {
      if (layer.exhausted && layer.floor != null && cursor <= layer.floor) break;
      budget.extPages--;
      const end = firstContact ? nextBarT(upper, tf) + 2 * TF_MS[tf] : cursor - 1;
      const res = await fetchWithRetry(src, coin, tf, end);
      if (res.kind === "unsupported") {
        layer.status = "none";
        break;
      }
      if (firstContact) {
        const refs = await deps.between(coin, tf, upper, nextBarT(upper, tf) + 3 * TF_MS[tf]);
        if (!seamOk(res.bars, refs, tf)) {
          layer.status = "none";
          break;
        }
      }
      const keep = res.bars.filter((b) => b.t < upper && b.t < cursor);
      await deps.upsert(coin, tf, keep.map((b) => ({ ...b, src: src.id })));
      added += keep.length;
      if (keep.length > 0) {
        cursor = keep[0]!.t;
        layer.floor = layer.floor == null ? cursor : Math.min(layer.floor, cursor);
      }
      // A short page means the venue's listing: nothing older exists here.
      // (A first-contact page may be all overlap; that alone proves nothing.)
      if (res.bars.length < src.pageSize || (keep.length === 0 && !firstContact)) {
        layer.exhausted = true;
        layer.floor = layer.floor ?? cursor;
        break;
      }
      firstContact = false;
    }
    state.ext[src.id] = layer;
    if (layer.status === "ok") {
      if (!layer.exhausted || added >= need) break;
      upper = layer.floor ?? upper; // next source continues below this one
    }
  }
  return added;
}

async function fillResampled(
  coin: string,
  tf: "1w" | "1M",
  state: SyncState,
  cursor: number,
  need: number,
  deps: SyncDeps,
  budget: FillBudget,
): Promise<FillResult> {
  const layer: LayerState = state.ext.resample ?? { status: "ok", floor: null, exhausted: false };
  const upper = state.hlFloor!;
  const span = need * TF_MS[tf] + 2 * TF_MS[tf];
  const from = cursor - span;

  // Make sure daily history reaches `from` first.
  let dailyExhausted = false;
  for (let i = 0; i < 4 && Date.now() < budget.deadline; i++) {
    const d = await deps.bounds(coin, "1d");
    if (d && d.min <= from) break;
    const r = await fillOlder(coin, "1d", d ? d.min : upper, Math.ceil(span / DAY), deps, budget);
    if (r.exhausted || r.added === 0) {
      dailyExhausted = r.exhausted;
      break;
    }
  }
  const daily = await deps.between(coin, "1d", from, Math.min(cursor, upper));
  // Weekly buckets take their phase from an HL weekly open (the floor itself).
  const buckets = resampleDaily(daily, tf, upper).filter((b) => nextBarT(b.t, tf) <= upper && b.t < cursor);
  await deps.upsert(coin, tf, buckets);
  if (buckets.length > 0) layer.floor = Math.min(layer.floor ?? Infinity, buckets[0]!.t);
  if (dailyExhausted) {
    // Daily history has bottomed out; once this pass covered all of it, every
    // complete bucket above it is stored.
    const d = await deps.bounds(coin, "1d");
    if (!d || from <= d.min) layer.exhausted = true;
  }
  state.ext.resample = layer;
  return { added: buckets.length, exhausted: layer.exhausted };
}

// ─── page reads ───

export interface Page {
  bars: Bar[];
  hasMore: boolean;
  error: string | null;
}

/**
 * The chart API: `limit` bars older than `before` (latest when omitted),
 * syncing the head and backfilling older layers as needed so the page is
 * full whenever history exists anywhere.
 */
export async function readPage(
  coin: string,
  tf: Timeframe,
  opts: { before?: number; limit: number; deadlineMs?: number },
  deps: SyncDeps = defaultDeps,
): Promise<Page> {
  const now = deps.now();
  const before = opts.before ?? now + TF_MS[tf];
  if (opts.before == null) await syncHead(coin, tf, deps);

  let bars = await deps.before(coin, tf, before, opts.limit);
  let exhausted = false;
  const budget: FillBudget = { extPages: DEFAULT_EXT_PAGES, deadline: Date.now() + (opts.deadlineMs ?? 20_000) };
  if (bars.length < opts.limit) {
    const end = bars.length ? bars[0]!.t : before;
    const r = await fillOlder(coin, tf, end, opts.limit - bars.length, deps, budget);
    exhausted = r.exhausted;
    if (r.added > 0) bars = await deps.before(coin, tf, before, opts.limit);
  } else {
    exhausted = isExhausted(await deps.getState(coin, tf), tf, deps.sources);
    if (exhausted) {
      const b = await deps.bounds(coin, tf);
      exhausted = b != null && bars[0]!.t <= b.min;
    }
  }
  const state = await deps.getState(coin, tf);
  return { bars, hasMore: bars.length > 0 && !exhausted, error: state.error };
}

/**
 * Ensures stored history reaches back to `from` (bounded work): the
 * simulator's daily backfill and the cron's warm-up use this.
 */
export async function ensureHistory(coin: string, tf: Timeframe, from: number, deps: SyncDeps = defaultDeps, maxRounds = 6): Promise<void> {
  await syncHead(coin, tf, deps);
  for (let i = 0; i < maxRounds; i++) {
    const b = await deps.bounds(coin, tf);
    if (b && b.min <= from + TF_MS[tf]) return;
    const need = Math.ceil(((b ? b.min : deps.now()) - from) / TF_MS[tf]) + 1;
    const r = await fillOlder(coin, tf, b ? b.min : deps.now() + TF_MS[tf], Math.min(need, HL_WINDOW_BARS), deps);
    if (r.exhausted || r.added === 0) return;
  }
}
