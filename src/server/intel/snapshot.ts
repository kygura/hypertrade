import { z } from "zod";
import { hlInfo, hlWeightWaitMs } from "../../shared/hl-client.js";
import type { PositionsResponse, SnapshotRow } from "../../shared/intel.js";
import type { AssetCtx } from "../../shared/types.js";
import type { IntelStore, StopRow } from "./store.js";

// Snapshot rows (SPEC.md § Intel I0.3). Written inside POST /api/cron/collect
// from the same metaAndAssetCtxs fetch: held ∪ watched ∪ top-20 by OI. Book
// depth and spread come from l2Book, fetched only for held ∪ watched (≤ 25
// coins, under the shared HL weight guard). Raw ticks never reach the LLM.
// The same collect records the watched HL account's stop triggers (taken
// from the exposure read the focus list already makes; no extra info call).

export const TOP_OI = 20;
export const MAX_BOOKS = 25;
export const SNAPSHOT_RETENTION_DAYS = 90;
/** intel_stops retention: longer than snapshots, so a long-held trade still finds the stop it was opened with. */
export const STOP_RETENTION_DAYS = 180;
const BOOK_CONCURRENCY = 5;
/** Collector name in collector_runs. Not `intel:*`: those are the news ingest sources the brief reports on. */
export const SNAPSHOT_COLLECTOR = "intel-snapshots";

export interface BookStats {
  mid: number;
  spreadBps: number;
  /** USD resting within ±1% / ±2% of mid. */
  depthBid1: number;
  depthAsk1: number;
  depthBid2: number;
  depthAsk2: number;
}

const LevelSchema = z.object({ px: z.string(), sz: z.string() }).passthrough();
const L2BookSchema = z.object({ levels: z.tuple([z.array(LevelSchema), z.array(LevelSchema)]) }).passthrough();

/**
 * Pure parser for an l2Book payload ({levels: [bids desc, asks asc]}). Null
 * when either side is empty or crossed. `// ponytail:` HL returns 20 levels a
 * side, so on deep books the band is capped at the visible levels.
 */
export function parseL2Book(raw: unknown): BookStats | null {
  const parsed = L2BookSchema.safeParse(raw);
  if (!parsed.success) return null;
  const side = (rows: z.infer<typeof LevelSchema>[]) =>
    rows.map((r) => ({ px: Number(r.px), sz: Number(r.sz) })).filter((r) => r.px > 0 && r.sz > 0 && Number.isFinite(r.px) && Number.isFinite(r.sz));
  const bids = side(parsed.data.levels[0]);
  const asks = side(parsed.data.levels[1]);
  const bid = Math.max(...bids.map((b) => b.px));
  const ask = Math.min(...asks.map((a) => a.px));
  if (!bids.length || !asks.length || !(ask > bid)) return null;
  const mid = (bid + ask) / 2;
  const usd = (rows: { px: number; sz: number }[], keep: (px: number) => boolean) => rows.reduce((s, r) => (keep(r.px) ? s + r.px * r.sz : s), 0);
  return {
    mid,
    spreadBps: ((ask - bid) / mid) * 1e4,
    depthBid1: usd(bids, (px) => px >= mid * 0.99),
    depthAsk1: usd(asks, (px) => px <= mid * 1.01),
    depthBid2: usd(bids, (px) => px >= mid * 0.98),
    depthAsk2: usd(asks, (px) => px <= mid * 1.02),
  };
}

export async function fetchL2Book(coin: string, fetchFn: typeof fetch = fetch): Promise<BookStats | null> {
  return parseL2Book(await hlInfo<unknown>({ type: "l2Book", coin }, fetchFn));
}

/** One row from a parsed asset context (+ book). Null when the mark is unusable. */
export function snapshotRow(c: AssetCtx, ts: Date, book?: BookStats | null): SnapshotRow | null {
  if (!(c.markPx > 0) || !Number.isFinite(c.markPx)) return null;
  const fin = (n: number) => (Number.isFinite(n) ? n : null);
  return {
    asset: c.name,
    ts: ts.toISOString(),
    price: c.markPx,
    vol24h: fin(c.dayNtlVlm),
    funding: fin(c.funding),
    oiUsd: fin(c.openInterest * c.markPx),
    premium: fin(c.premium),
    basis: c.oraclePx > 0 ? fin((c.markPx - c.oraclePx) / c.oraclePx) : null,
    depthBid1: book?.depthBid1 ?? null,
    depthAsk1: book?.depthAsk1 ?? null,
    depthBid2: book?.depthBid2 ?? null,
    depthAsk2: book?.depthAsk2 ?? null,
    spreadBps: book?.spreadBps ?? null,
  };
}

/**
 * Which coins get a row (held ∪ watched ∪ top-20 by notional OI) and which
 * get a book (held ∪ watched, at most MAX_BOOKS). Only coins listed in
 * `ctxs` (and not delisted) count.
 */
export function selectSnapshotAssets(ctxs: AssetCtx[], focus: string[]): { rows: string[]; books: string[] } {
  const listed = new Set(ctxs.filter((c) => !c.isDelisted).map((c) => c.name));
  const books = [...new Set(focus)].filter((a) => listed.has(a)).slice(0, MAX_BOOKS);
  const top = ctxs
    .filter((c) => !c.isDelisted && c.openInterest > 0)
    .sort((a, b) => b.openInterest * b.markPx - a.openInterest * a.markPx)
    .slice(0, TOP_OI)
    .map((c) => c.name);
  return { rows: [...new Set([...focus.filter((a) => listed.has(a)), ...top])], books };
}

/** A reduce-only stop trigger on a watched-HL position (readHlAccount's frontendOpenOrders), without its timestamp. */
export type HlStop = Omit<StopRow, "ts">;

/**
 * Held (any position source) and watched assets, as one deduped list, plus
 * the stop of each `hl` position that has one (only read when
 * DESK_WATCH_ADDRESS is set). Never throws; a failure is returned in `errors`.
 */
export async function focusAssets(
  exposure: () => Promise<PositionsResponse>,
  watched: () => Promise<string[]>,
): Promise<{ held: string[]; watched: string[]; stops: HlStop[]; errors: string[] }> {
  const errors: string[] = [];
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const [positions, watch] = await Promise.all([
    exposure().then(
      (r) => {
        for (const s of r.sources) if (!s.ok && s.error && !/not configured/.test(s.error)) errors.push(`${s.source}: ${s.error}`);
        return r.positions;
      },
      (e) => (errors.push(`positions: ${msg(e)}`), [] as PositionsResponse["positions"]),
    ),
    watched().catch((e) => (errors.push(`watchlist: ${msg(e)}`), [] as string[])),
  ]);
  const stops = positions.flatMap((p) =>
    p.source === "hl" && p.stopPx != null && Number.isFinite(p.stopPx) && p.stopPx > 0 ? [{ asset: p.asset, side: p.side, stopPx: p.stopPx }] : [],
  );
  return { held: [...new Set(positions.map((p) => p.asset))], watched: watch, stops, errors };
}

export interface SnapshotDeps {
  store: Pick<IntelStore, "insertSnapshots" | "recordStops">;
  /** `stops` (watched-HL stop triggers) are recorded at the snapshot's ts for the journal's R (I0.15). */
  focus(): Promise<{ held: string[]; watched: string[]; stops?: HlStop[]; errors: string[] }>;
  l2Book(coin: string): Promise<BookStats | null>;
  recordRun(collector: string, startedAt: Date, ok: boolean, error?: string | null): Promise<void>;
  /** Epoch ms after which no further book is started (rows are still written). */
  deadline?: number;
}

export interface SnapshotResult {
  ok: boolean;
  written: number;
  assets: number;
  books: number;
  errors: string[];
  error?: string;
}

/**
 * Writes this collect's snapshot rows. Never throws: a failure is recorded
 * in collector_runs and returned, so it can never fail the collect itself.
 * One coin's book failing only leaves that coin's depth null.
 */
export async function collectIntelSnapshots(deps: SnapshotDeps, ctxs: AssetCtx[], ts: Date): Promise<SnapshotResult> {
  const startedAt = new Date();
  const errors: string[] = [];
  try {
    const focus = await deps.focus();
    errors.push(...focus.errors);
    const { rows, books } = selectSnapshotAssets(ctxs, [...focus.held, ...focus.watched]);
    const stats = new Map<string, BookStats>();
    for (let i = 0; i < books.length; i += BOOK_CONCURRENCY) {
      if (deps.deadline != null && Date.now() + hlWeightWaitMs() >= deps.deadline) {
        errors.push(`books: deadline, skipped ${books.length - i}`);
        break;
      }
      await Promise.all(
        books.slice(i, i + BOOK_CONCURRENCY).map(async (coin) => {
          try {
            const b = await deps.l2Book(coin);
            if (b) stats.set(coin, b);
            else errors.push(`${coin} book: empty or crossed`);
          } catch (e) {
            errors.push(`${coin} book: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );
    }
    const byName = new Map(ctxs.map((c) => [c.name, c]));
    const out = rows.flatMap((a) => {
      const r = snapshotRow(byName.get(a)!, ts, stats.get(a));
      return r ? [r] : [];
    });
    const written = await deps.store.insertSnapshots(out);
    if (focus.stops?.length) {
      await deps.store.recordStops(focus.stops.map((s) => ({ ...s, ts: ts.toISOString() }))).catch((e) => errors.push(`stops: ${e instanceof Error ? e.message : String(e)}`));
    }
    await deps.recordRun(SNAPSHOT_COLLECTOR, startedAt, true, errors.length ? errors.join("; ").slice(0, 500) : null).catch(() => {});
    return { ok: true, written, assets: out.length, books: stats.size, errors };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await deps.recordRun(SNAPSHOT_COLLECTOR, startedAt, false, error).catch(() => {});
    return { ok: false, written: 0, assets: 0, books: 0, errors, error };
  }
}
