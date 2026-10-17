import { z } from "zod";
import { SnapshotRowSchema, type SnapshotRow } from "../../shared/intel.js";
import type { CollectorRunRow, Observation, SeriesDef } from "../db.js";
import type { StopRow } from "../intel/store.js";

// The 15-minute collect's writes, buffered. Collectors fetch into a batch
// instead of writing as they go, so a slow or wedged database can no longer
// fail a collector mid-fetch or hold the request past its timeout. One flush
// then writes the batch under a fixed budget; whatever it could not write
// comes back as a spill, which the collect workflow caches and sends back
// on the next run to be merged in and written again (all upserts, so a
// replay that overlaps a late commit changes nothing).

export type BatchObservation = { seriesId: string; ts: string; value: number };

export type CollectBatch = {
  series: SeriesDef[];
  observations: BatchObservation[];
  snapshots: SnapshotRow[];
  stops: StopRow[];
  runs: CollectorRunRow[];
  /** When the oldest rows in a spill were first spilled (wall clock; data timestamps can be days old, e.g. FRED). */
  since?: string;
};

const Iso = z.string().datetime({ offset: true });

/** A replayed spill (POST body `{ replay }`). Only cron-token holders reach this. */
export const CollectBatchSchema = z.object({
  series: z.array(z.object({ id: z.string(), source: z.string().optional(), units: z.string().optional(), description: z.string().optional() })).default([]),
  observations: z.array(z.object({ seriesId: z.string(), ts: Iso, value: z.number().finite() })).default([]),
  snapshots: z.array(SnapshotRowSchema).default([]),
  stops: z.array(z.object({ asset: z.string(), side: z.enum(["long", "short"]), ts: Iso, stopPx: z.number().finite() })).default([]),
  runs: z.array(z.object({ collector: z.string(), startedAt: Iso, finishedAt: Iso, ok: z.boolean(), error: z.string().nullable() })).default([]),
  since: Iso.optional(),
});

export const emptyBatch = (): CollectBatch => ({ series: [], observations: [], snapshots: [], stops: [], runs: [] });

export const batchSize = (b: CollectBatch) => b.observations.length + b.snapshots.length + b.stops.length + b.runs.length;

const iso = (ts: Date | string) => (typeof ts === "string" ? new Date(ts) : ts).toISOString();

/**
 * Drop-in for the collectors' db deps and the snapshot store: every write
 * lands in `batch` and reports as written. Never touches the database.
 */
export function createBatchSink(now: () => Date = () => new Date()) {
  const batch = emptyBatch();
  return {
    batch,
    db: {
      ensureSeries: async (defs: SeriesDef[]) => void batch.series.push(...defs),
      upsertObservations: async (rows: Observation[]) => {
        for (const r of rows) batch.observations.push({ seriesId: r.seriesId, ts: iso(r.ts), value: r.value });
        return rows.length;
      },
      recordCollectorRun: async (collector: string, startedAt: Date, ok: boolean, error?: string | null) =>
        void batch.runs.push({ collector, startedAt: startedAt.toISOString(), finishedAt: now().toISOString(), ok, error: error ?? null }),
    },
    store: {
      insertSnapshots: async (rows: SnapshotRow[]) => (batch.snapshots.push(...rows), rows.length),
      recordStops: async (rows: StopRow[]) => (batch.stops.push(...rows), rows.length),
    },
  };
}

/** Last row per key wins, so the fresh batch overrides an older spill of the same point. */
function lastBy<T>(rows: T[], key: (r: T) => string): T[] {
  return [...new Map(rows.map((r) => [key(r), r])).values()];
}

const ms = (ts: string) => Date.parse(ts);

export function mergeBatches(older: CollectBatch, newer: CollectBatch): CollectBatch {
  return {
    series: lastBy([...older.series, ...newer.series], (s) => s.id),
    observations: lastBy([...older.observations, ...newer.observations], (o) => `${o.seriesId}|${ms(o.ts)}`),
    snapshots: lastBy([...older.snapshots, ...newer.snapshots], (s) => `${s.asset}|${ms(s.ts)}`),
    stops: lastBy([...older.stops, ...newer.stops], (s) => `${s.asset}|${s.side}|${ms(s.ts)}`),
    runs: lastBy([...older.runs, ...newer.runs], (r) => `${r.collector}|${ms(r.startedAt)}`),
    ...((older.since ?? newer.since) ? { since: older.since ?? newer.since } : {}),
  };
}

/** Spill caps: a database down for days keeps the newest rows and stays under the request body limit. */
export const SPILL_LIMITS = { observations: 20_000, snapshots: 5_000, stops: 5_000, runs: 2_000 } as const;

function newest<T>(rows: T[], ts: (r: T) => string, max: number): T[] {
  return rows.length <= max ? rows : [...rows].sort((a, b) => ms(ts(a)) - ms(ts(b))).slice(-max);
}

export function capBatch(b: CollectBatch, limits: Record<keyof typeof SPILL_LIMITS, number> = SPILL_LIMITS): CollectBatch {
  const observations = newest(b.observations, (o) => o.ts, limits.observations);
  const ids = new Set(observations.map((o) => o.seriesId));
  return {
    series: b.series.filter((s) => ids.has(s.id)),
    observations,
    snapshots: newest(b.snapshots, (s) => s.ts, limits.snapshots),
    stops: newest(b.stops, (s) => s.ts, limits.stops),
    runs: newest(b.runs, (r) => r.startedAt, limits.runs),
    ...(b.since ? { since: b.since } : {}),
  };
}

export type BatchWriter = {
  ensureSeries(defs: SeriesDef[]): Promise<void>;
  upsertObservations(rows: Observation[]): Promise<number>;
  insertSnapshots(rows: SnapshotRow[]): Promise<number>;
  recordStops(rows: StopRow[]): Promise<number>;
  insertCollectorRuns(rows: CollectorRunRow[]): Promise<number>;
};

export type FlushResult = {
  written: { observations: number; snapshots: number; stops: number; runs: number };
  errors: string[];
  spill: CollectBatch;
};

/** Observations per statement; one collect is a few hundred, a replayed spill up to SPILL_LIMITS. */
export const FLUSH_CHUNK = 2_000;

/**
 * Writes `batch` within `budgetMs`. A statement still running when the budget
 * is spent is no longer waited for: its rows go to the spill with everything
 * not yet started. Observations need their series rows (FK), so a failed
 * series write spills all of them; the other tables are independent.
 */
export async function flushBatch(batch: CollectBatch, writer: BatchWriter, budgetMs: number, clock: () => number = Date.now): Promise<FlushResult> {
  const deadline = clock() + budgetMs;
  const errors: string[] = [];
  const written = { observations: 0, snapshots: 0, stops: 0, runs: 0 };
  const spill = emptyBatch();

  const step = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
    const left = deadline - clock();
    if (left <= 0) {
      errors.push(`${label}: flush budget spent`);
      return null;
    }
    const p = run();
    p.catch(() => {}); // may still settle after the budget; nobody waits for it then
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("flush budget spent")), left)))]);
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const seriesOk = batch.series.length === 0 || (await step("series", () => writer.ensureSeries(batch.series).then(() => true))) === true;
  for (let i = 0; i < batch.observations.length; i += FLUSH_CHUNK) {
    const chunk = batch.observations.slice(i, i + FLUSH_CHUNK);
    const n = seriesOk ? await step("observations", () => writer.upsertObservations(chunk)) : null;
    if (n == null) spill.observations.push(...chunk);
    else written.observations += n;
  }
  const spilledIds = new Set(spill.observations.map((o) => o.seriesId));
  spill.series = batch.series.filter((s) => spilledIds.has(s.id));

  if (batch.snapshots.length) {
    const n = await step("snapshots", () => writer.insertSnapshots(batch.snapshots));
    if (n == null) spill.snapshots = batch.snapshots;
    else written.snapshots = n;
  }
  if (batch.stops.length) {
    const n = await step("stops", () => writer.recordStops(batch.stops));
    if (n == null) spill.stops = batch.stops;
    else written.stops = n;
  }
  // Last: bookkeeping only, it must never cost the data its budget.
  if (batch.runs.length) {
    const n = await step("collector_runs", () => writer.insertCollectorRuns(batch.runs));
    if (n == null) spill.runs = batch.runs;
    else written.runs = n;
  }
  if (batchSize(spill)) spill.since = batch.since ?? new Date(clock()).toISOString();
  return { written, errors, spill: capBatch(spill) };
}
