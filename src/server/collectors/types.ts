import { ensureSeries, recordCollectorRun, upsertObservations } from "../db.js";

export type CollectorResult = { ok: boolean; error?: string; written: number };

/** db.ts calls, injectable so tests never need a live DATABASE_URL. */
export type CollectorDbDeps = { ensureSeries: typeof ensureSeries; upsertObservations: typeof upsertObservations; recordCollectorRun: typeof recordCollectorRun };
export const collectorDb: CollectorDbDeps = { ensureSeries, upsertObservations, recordCollectorRun };
