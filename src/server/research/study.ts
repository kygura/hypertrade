import { EventStudyResultSchema, type StudyRequest, type StudyResponse, type StudySummary } from "../../shared/research.js";
import { ruleId } from "../lab/engine/rules.js";
import type { ToolContext } from "../mcp/types.js";

// Board studies (docs/RESEARCH.md B2): a lab_event_study run through the Lab tool (so it is a trial exactly as a
// direct call is), projected to a StudySummary and cached in process by rule hash, scope and UTC day. Runs only on
// a person's request; the cache and the in-flight sharing keep one request (or a double click) to one trial.

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

/** Keyed by studyKey. Entries of an earlier UTC day are dropped once the day turns; past `max`, the oldest goes. */
export function createStudyCache(now: () => number = Date.now, max = STUDY_CACHE_MAX) {
  const map = new Map<string, StudyCacheEntry>();
  const prune = () => {
    const day = utcDay(now());
    for (const k of map.keys()) if (!k.endsWith(`:${day}`)) map.delete(k);
  };
  return {
    get(key: string): StudyCacheEntry | undefined {
      prune();
      return map.get(key);
    },
    set(key: string, e: StudyCacheEntry) {
      prune();
      map.delete(key);
      map.set(key, e);
      while (map.size > max) map.delete(map.keys().next().value!);
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

/**
 * Cached study for today, else one lab_event_study run (concurrent asks for the same study share it, so it is one
 * trial). The key uses the UTC day the run started. Lab errors (ToolInputError, UpstreamError) propagate unchanged
 * and nothing is cached.
 */
export function createStudyRunner(deps: StudyRunnerDeps) {
  const inflight = new Map<string, Promise<StudyResponse>>();
  return async function runStudy(request: StudyRequest, ctx: ToolContext): Promise<StudyResponse> {
    const q = quantize(request);
    const key = studyKey(q, deps.now());
    const hit = deps.cache.get(key);
    if (hit) return { studyId: key, cached: true, ...hit };
    const running = inflight.get(key);
    if (running) return running;
    const p = (async () => {
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
