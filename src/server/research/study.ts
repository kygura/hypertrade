import { z } from "zod";
import { EventStudyResultSchema, StudySummarySchema, type StudyRequest, type StudyResponse, type StudySummary } from "../../shared/research.js";
import { ruleId } from "../lab/engine/rules.js";
import type { LabStore } from "../lab/store.js";
import type { ToolContext } from "../mcp/types.js";

// Board studies (docs/RESEARCH.md B2): a lab_event_study run through the Lab tool (so it is a trial exactly as a
// direct call is), projected to a StudySummary and cached in process by rule hash, scope and UTC day. Runs only on
// a person's request; the cache and the in-flight sharing keep one request (or a double click) to one trial. The
// cache writes through to the Lab store (research_studies), so a restart neither loses today's evidence nor re-runs it.

export type EventStudyOutput = StudyResponse["study"];

/** Projection of a lab_event_study result: its own numbers, nothing recomputed. Expectancy is signed for the rule's side. */
export function studySummary(r: EventStudyOutput, asOf: string): StudySummary {
  return {
    verdict: r.verdict,
    events: r.screen.events,
    weeks: r.screen.weeks,
    expectancy: r.screen.expectancy,
    upper95: r.screen.upper95,
    holdoutExpectancy: r.holdout.expectancy,
    idea: r.idea ?? null,
    asOf,
  };
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const tenth = (x: number) => Math.round(x * 10) / 10;
/** Exits to 0.1 ATR: 1.51 and 1.5 are one study (one trial), and the key cannot be fanned out by float noise. */
export const quantize = (q: StudyRequest): StudyRequest => ({ ...q, stopAtr: tenth(q.stopAtr), targetAtr: tenth(q.targetAtr) });

/** The cache key and study id: rule hash, coin (or `*` = the default universe), exits to 0.1 ATR and a UTC day. */
export function studyKey(q: StudyRequest, nowMs: number): string {
  const n = quantize(q);
  return `${ruleId(n.rule)}:${n.coin?.toUpperCase() ?? "*"}:${n.stopAtr}:${n.targetAtr}:${utcDay(nowMs)}`;
}

export interface StudyCacheEntry {
  summary: StudySummary;
  study: EventStudyOutput;
}

export const STUDY_CACHE_MAX = 200;

/** Where studies outlive the process: the Lab store's study rows (memory, Postgres or the JSON file). */
export type StudyStore = Pick<LabStore, "getStudies" | "putStudy">;
const StoredEntrySchema = z.object({ summary: StudySummarySchema, study: EventStudyResultSchema });

/** Longest a study or the board waits on a store read (study rows, catalogue lookup) before going on without it. */
export const STUDY_STORE_TIMEOUT_MS = 3_000;

/** `p`, or `fallback` once `ms` pass or `p` rejects (logged as `what`). Never rejects; a late answer is dropped. */
export function bounded<T>(p: Promise<T>, fallback: T, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((res) => (timer = setTimeout(() => (console.error(`[research] ${what}: no answer within ${ms} ms; going on without it`), res(fallback)), ms)));
  const settled = p.catch((err) => (console.error(`[research] ${what} failed; going on without it:`, err), fallback));
  return Promise.race([settled, late]).finally(() => clearTimeout(timer));
}

/**
 * Keyed by studyKey. Entries of an earlier UTC day are dropped once the day turns; past `max`, the oldest goes.
 * With a store, the map is a read-through front: `load` fills it from the store (one read for many keys, bounded
 * by `storeTimeoutMs`), `set` writes through in the background, so a restart keeps today's studies. A slow or
 * failing store is logged and the cache acts in memory only.
 */
export function createStudyCache(now: () => number = Date.now, max = STUDY_CACHE_MAX, store: StudyStore | null = null, storeTimeoutMs = STUDY_STORE_TIMEOUT_MS) {
  const map = new Map<string, StudyCacheEntry>();
  const prune = () => {
    const day = utcDay(now());
    for (const k of map.keys()) if (!k.endsWith(`:${day}`)) map.delete(k);
  };
  const remember = (key: string, e: StudyCacheEntry) => {
    prune();
    map.delete(key);
    map.set(key, e);
    while (map.size > max) map.delete(map.keys().next().value!);
  };
  return {
    get(key: string): StudyCacheEntry | undefined {
      prune();
      return map.get(key);
    },
    /**
     * Reads the keys not in memory from the store, in one call, waiting at most `storeTimeoutMs`; a bad row, a store
     * failure or no answer in time reads as a miss. Never rejects.
     */
    async load(keys: readonly string[]): Promise<void> {
      prune();
      const day = `:${utcDay(now())}`;
      const missing = [...new Set(keys)].filter((k) => k.endsWith(day) && !map.has(k));
      if (!store || !missing.length) return;
      const rows = await bounded(Promise.resolve().then(() => store.getStudies(missing)), new Map(), storeTimeoutMs, "study store read");
      for (const [k, v] of rows) {
        const e = StoredEntrySchema.safeParse(v);
        if (!e.success) console.error(`[research] stored study ${k} does not parse; ignored`);
        else if (!map.has(k)) remember(k, e.data);
      }
    },
    /** Remembers the entry; the store write runs in the background (not awaited; a failure is logged, the entry stays in memory). */
    set(key: string, e: StudyCacheEntry): void {
      remember(key, e);
      if (!store) return;
      Promise.resolve()
        .then(() => store.putStudy(key, e, new Date(now())))
        .catch((err) => console.error("[research] study store write failed; in-memory only:", err));
    },
    size: () => (prune(), map.size),
  };
}
export type StudyCache = ReturnType<typeof createStudyCache>;

/** Calls lab_event_study (the registered tool) with these arguments. */
export type RunEventStudy = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface StudyRunnerDeps {
  cache: StudyCache;
  eventStudy: RunEventStudy;
  now: () => number;
}

/** A study as the runner returns it; the route adds the live `catalogueId`. */
export type StudyRun = Omit<StudyResponse, "catalogueId">;

/**
 * Cached study for today, else one lab_event_study run (concurrent asks for the same study share it, so it is one
 * trial). The key uses the UTC day the run started. Lab errors (ToolInputError, UpstreamError) propagate unchanged
 * and nothing is cached.
 */
export function createStudyRunner(deps: StudyRunnerDeps) {
  const inflight = new Map<string, Promise<StudyRun>>();
  return async function runStudy(request: StudyRequest, ctx: ToolContext): Promise<StudyRun> {
    const q = quantize(request);
    const key = studyKey(q, deps.now());
    const hit = deps.cache.get(key);
    if (hit) return { studyId: key, cached: true, ...hit };
    const running = inflight.get(key);
    if (running) return running;
    const p = (async () => {
      // Today's study may be in the store from before a restart: then it is not run (nor counted) again. The read is
      // bounded (a stalled store is a miss), and the write below is not awaited, so the caller always gets an answer.
      await deps.cache.load([key]);
      const stored = deps.cache.get(key);
      if (stored) return { studyId: key, cached: true, ...stored };
      const args = { rule: q.rule, stopAtr: q.stopAtr, targetAtr: q.targetAtr, ...(q.coin ? { coins: [q.coin] } : {}) };
      const study = EventStudyResultSchema.parse(await deps.eventStudy(args, ctx));
      const entry = { summary: studySummary(study, new Date(deps.now()).toISOString()), study };
      deps.cache.set(key, entry);
      return { studyId: key, cached: false, ...entry };
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
export type StudyRunner = ReturnType<typeof createStudyRunner>;
