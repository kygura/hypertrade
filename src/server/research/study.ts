import { EventStudyResultSchema, type StudyRequest, type StudyResponse, type StudySummary } from "../../shared/research.js";
import { ruleId } from "../lab/engine/rules.js";
import type { ToolContext } from "../mcp/types.js";

// Board studies (docs/RESEARCH.md B2): a lab_event_study run through the Lab tool (so it is a trial exactly as a
// direct call is), projected to a StudySummary and cached in process by rule hash, scope and UTC day. The cache is
// in-process by design: a restart re-runs at most a day's studies.

export type EventStudyOutput = StudyResponse["study"];

/** Projection of a lab_event_study result: its own numbers, nothing recomputed. */
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

/** What a study is of, without the day: rule hash, coin (or the default universe) and exits. */
export const studyScope = (q: StudyRequest) => `${ruleId(q.rule)}:${q.coin?.toUpperCase() ?? "*"}:${q.stopAtr}:${q.targetAtr}`;
/** The cache key and study id: scope plus UTC day. */
export const studyKey = (q: StudyRequest, nowMs: number) => `${studyScope(q)}:${utcDay(nowMs)}`;

export interface StudyCacheEntry {
  summary: StudySummary;
  study: EventStudyOutput;
}

/** Today's studies only: entries from an earlier UTC day are dropped as soon as the day turns. */
export function createStudyCache(now: () => number = Date.now) {
  const map = new Map<string, StudyCacheEntry>();
  const prune = () => {
    const day = utcDay(now());
    for (const k of map.keys()) if (!k.endsWith(`:${day}`)) map.delete(k);
  };
  return {
    get(q: StudyRequest): StudyCacheEntry | undefined {
      prune();
      return map.get(studyKey(q, now()));
    },
    set(q: StudyRequest, e: StudyCacheEntry) {
      prune();
      map.set(studyKey(q, now()), e);
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
 * trial). Lab errors (ToolInputError, UpstreamError) propagate unchanged and nothing is cached.
 */
export function createStudyRunner(deps: StudyRunnerDeps) {
  const inflight = new Map<string, Promise<StudyResponse>>();
  return async function runStudy(q: StudyRequest, ctx: ToolContext): Promise<StudyResponse> {
    const key = studyKey(q, deps.now());
    const hit = deps.cache.get(q);
    if (hit) return { studyId: key, cached: true, ...hit };
    const running = inflight.get(key);
    if (running) return running;
    const p = (async () => {
      const args = { rule: q.rule, stopAtr: q.stopAtr, targetAtr: q.targetAtr, ...(q.coin ? { coins: [q.coin] } : {}) };
      const study = EventStudyResultSchema.parse(await deps.eventStudy(args, ctx));
      const entry = { summary: studySummary(study, new Date(deps.now()).toISOString()), study };
      deps.cache.set(q, entry);
      return { studyId: key, cached: false, ...entry };
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
export type StudyRunner = ReturnType<typeof createStudyRunner>;
