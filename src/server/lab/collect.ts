// Cron collector for Lab history: every collectable provider metric (cm per
// LAB_ASSETS, fng, llama, bc, deribit) into observations as
// lab.<provider>.<key>[.<asset>], which the registry then reads before going
// live. First sync of a series pulls its full history; after that a tail
// from the last sync minus a week, at most once per 20 h. One dead source
// never stops the others.
import type { CollectorResult } from "../collectors/types.js";
import * as db from "../db.js";
import type { Observation, SyncState } from "../db.js";
import { PROVIDERS } from "./providers/registry.js";
import { HttpError, isCollectable, labSeriesId } from "./providers/series.js";
import type { LabProvider, MetricDef } from "./types.js";
import { mapLimit, msg } from "./util.js";

const COLLECTOR = "lab";
/** sync_state.coin for Lab series; sync_state.series is the series id. */
export const LAB_SYNC_COIN = "_lab";
const DAY_MS = 86_400_000;
/** Refetch a series at most this often (upstreams update daily). */
export const REFRESH_MS = 20 * 3_600_000;
/** After a failed sync, wait this long before trying the series again. */
export const RETRY_MS = 3_600_000;
/** Overlap on incremental fetches: upstreams revise recent days. */
export const OVERLAP_MS = 7 * DAY_MS;
const OBS_CHUNK = 5000;
const CONCURRENCY = 3;
/**
 * Providers whose requests go one at a time with a pause between: Coin
 * Metrics' community tier allows ~10 requests per 6 s.
 */
const SERIAL_GAP_MS: Record<string, number> = { cm: 700 };
export const DEFAULT_LAB_ASSETS = ["BTC", "ETH"];

export interface LabJob {
  /** Observation series id, also the sync_state key. */
  id: string;
  provider: LabProvider & { history(key: string, asset: string, sinceMs: number | null): Promise<{ t: number[]; v: number[] }> };
  def: MetricDef;
  asset: string;
}

/** LAB_ASSETS (comma-separated tickers), default BTC,ETH. */
export function labAssets(env: Record<string, string | undefined> = process.env): string[] {
  const list = (env.LAB_ASSETS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{1,20}$/.test(s));
  return list.length ? [...new Set(list)] : DEFAULT_LAB_ASSETS;
}

/** Every series to collect: global metrics once, asset metrics per asset. */
export function labJobs(providers: LabProvider[] = PROVIDERS, assets: string[] = labAssets()): LabJob[] {
  return providers.filter(isCollectable).flatMap((provider) =>
    provider.metrics().flatMap((def) =>
      (def.scope === "global" ? [""] : assets).map((asset) => ({ id: labSeriesId(def, asset), provider, def, asset })),
    ),
  );
}

export type LabCollectDeps = Pick<typeof db, "getSyncState" | "saveSyncState" | "ensureSeries" | "upsertObservations" | "recordCollectorRun">;

export interface LabCollectOptions {
  now?: () => number;
  /** Stop starting new series after this epoch ms (the cron's budget). */
  deadline?: number;
  /** Ignore the once-a-day gate and refetch full history. */
  force?: boolean;
  jobs?: LabJob[];
  sleep?: (ms: number) => Promise<void>;
}

export type LabSourceStatus = "ok" | "skipped" | "error";
export type LabCollectResult = CollectorResult & { sources: Record<string, LabSourceStatus> };

/** A refusal (4xx other than 429) will not fix itself within the hour: wait a full refresh. */
const backoffMs = (err: unknown) => (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429 ? REFRESH_MS : RETRY_MS);

type LabExt = { lab?: { attemptedAt?: number; retryAfter?: number } };

export async function collectLab(deps: LabCollectDeps = db, opts: LabCollectOptions = {}): Promise<LabCollectResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = new Date(now());
  const jobs = opts.jobs ?? labJobs();
  const sources: Record<string, LabSourceStatus> = {};
  const errors: string[] = [];
  let written = 0;

  /** Syncs one series if due; false when it was skipped (no request made). */
  async function run(job: LabJob): Promise<boolean> {
    const t0 = now();
    const skip = () => ((sources[job.id] = "skipped"), false);
    if (opts.deadline && t0 > opts.deadline) return skip();
    try {
      const state = await deps.getSyncState(LAB_SYNC_COIN, job.id);
      // sync_state.ext is the candle sync's per-layer map; Lab series keep their
      // last attempt there so a dead upstream is not hit every cron run.
      const lab = (state.ext as LabExt).lab;
      const fresh = state.syncedAt !== null && t0 - state.syncedAt < REFRESH_MS;
      const backingOff = state.error !== null && lab?.retryAfter !== undefined && t0 < lab.retryAfter;
      if (!opts.force && (fresh || backingOff)) return skip();
      const ext = (lab: LabExt["lab"]) => ({ ...state.ext, lab }) as unknown as SyncState["ext"];
      const since = opts.force || state.syncedAt === null ? null : state.syncedAt - OVERLAP_MS;
      try {
        const s = await job.provider.history(job.def.key, job.asset, since);
        const floor = since ?? -Infinity;
        const rows: Observation[] = [];
        for (let i = 0; i < s.t.length; i++) if (s.t[i]! >= floor && s.t[i]! <= t0) rows.push({ seriesId: job.id, ts: new Date(s.t[i]!), value: s.v[i]! });
        if (rows.length === 0 && since === null) throw new Error("no history returned");
        await deps.ensureSeries([{ id: job.id, source: job.def.provider, units: job.def.units, description: `${job.def.name}${job.asset ? ` (${job.asset})` : ""}: ${job.def.description}` }]);
        // Ascending chunks: a run cut short leaves a stale tail, which readers treat as missing.
        for (let i = 0; i < rows.length; i += OBS_CHUNK) {
          const n = await deps.upsertObservations(rows.slice(i, i + OBS_CHUNK));
          written += n; // not `written += await`: that reads `written` before other lanes add to it
        }
        await deps.saveSyncState({ ...state, ext: ext({ attemptedAt: t0 }), syncedAt: t0, error: null });
        sources[job.id] = "ok";
      } catch (err) {
        const e = `${job.id}: ${msg(err)}`.slice(0, 500);
        errors.push(e);
        sources[job.id] = "error";
        await deps.saveSyncState({ ...state, ext: ext({ attemptedAt: t0, retryAfter: t0 + backoffMs(err) }), error: e }).catch(() => {});
      }
    } catch (err) {
      // sync_state itself unreadable: report, carry on with the rest.
      errors.push(`${job.id}: ${msg(err)}`);
      sources[job.id] = "error";
    }
    return true;
  }

  // Rate-limited providers get one serial lane each; the rest share a small pool.
  const lanes = new Map<string, LabJob[]>();
  const pooled: LabJob[] = [];
  for (const j of jobs) {
    if (!SERIAL_GAP_MS[j.provider.id]) pooled.push(j);
    else if (lanes.has(j.provider.id)) lanes.get(j.provider.id)!.push(j);
    else lanes.set(j.provider.id, [j]);
  }
  await Promise.all([
    ...[...lanes].map(async ([pid, lane]) => {
      for (const j of lane) if (await run(j)) await sleep(SERIAL_GAP_MS[pid]!);
    }),
    mapLimit(pooled, CONCURRENCY, run),
  ]);

  const attempted = Object.values(sources).filter((s) => s !== "skipped").length;
  const ok = errors.length === 0 || errors.length < attempted;
  const error = errors.length ? errors.join("; ") : undefined;
  await deps.recordCollectorRun(COLLECTOR, startedAt, ok, error ?? null).catch(() => {});
  return { ok, ...(error ? { error } : {}), written, sources };
}
