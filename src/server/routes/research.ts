import { Hono, type Context } from "hono";
import { resolve } from "node:path";
import { PRE_DECISION_STATUSES } from "../../shared/platform.js";
import { BoardResponseSchema, RadarResponseSchema, StudyRequestSchema, StudyResponseSchema, type RadarResponse } from "../../shared/research.js";
import { databaseUrl } from "../db.js";
import { getLabService, labTools } from "../lab/tools.js";
import { labDeadlineMs, SERVER_DEADLINE_MS } from "../mcp/lab.js";
import { ToolInputError, UpstreamError, type ToolDef } from "../mcp/types.js";
import { dbPlatformContext, getPlatformContext, type PlatformContext } from "../platform/context.js";
import { PgPlatformStore } from "../platform/store-pg.js";
import { boardDepsFor, buildBoard, SourceUnavailable, type BoardDeps } from "../research/board.js";
import { isGuest } from "../auth.js";
import { readRadar } from "../research/radar.js";
import { bounded, createStudyCache, createStudyRunner, STUDY_CACHE_MAX, STUDY_STORE_TIMEOUT_MS, type RunEventStudy, type StudyRunner } from "../research/study.js";
import { ruleId } from "../lab/engine/rules.js";
import type { LabStore } from "../lab/store.js";
import type { Rule } from "../lab/types.js";
import { invalid } from "./intel/http.js";

// /api/research and /api/radar (docs/RESEARCH.md B2). Inputs and outputs zod-parsed against src/shared/research.ts.
// GET /research/board   → BoardResponse: every source loads on its own; a failing one is `unavailable` with a reason.
// POST /research/study  { rule, coin?, stopAtr?, targetAtr? } → StudyResponse. Runs the lab_event_study tool, so it
//                       is a trial exactly as a direct call; cached by rule hash, scope, exits and UTC day (in process,
//                       written through to the Lab store); `catalogueId` is looked up live on every answer. Runs
//                       only on request: nothing in the process studies on its own (machine runs would inflate N).
//                       400 { error, field? } bad input · 502 upstream data · 500 otherwise.
// GET /radar            → RadarResponse from data/radar/ (state `unavailable` + reason when the files are absent).
// Auth (auth.ts): GETs are read paths (cookie, or the LAB_API_TOKEN bearer on GET); /radar is not guest-readable in
// PUBLIC_MODE (LLM-written theses). The study POST takes the same cookie-or-bearer as the Lab tool POSTs.

export interface ResearchRouteDeps {
  board: () => Omit<BoardDeps, "cache">;
  runStudy: StudyRunner;
  cache: BoardDeps["cache"];
  /** The rule's catalogue id if it is in the catalogue now, else null (the Lab store's id: ruleId, as on save). */
  catalogueId: (rule: Rule) => Promise<string | null>;
  /** Longest the catalogue lookup may take before the answer says null. Default STUDY_STORE_TIMEOUT_MS. */
  storeTimeoutMs?: number;
  /** Deadline for a study run on request (the Lab route's). */
  deadlineMs: () => number | undefined;
  /** A PUBLIC_MODE guest (no session, no bearer): the board leaves the radar out. Default: auth.ts isGuest. */
  isGuest?: (c: Context) => boolean;
}

export function researchRoutes(deps: ResearchRouteDeps) {
  return new Hono()
    .get("/board", async (c) =>
      c.json(BoardResponseSchema.parse(await buildBoard({ ...boardDepsFor(deps.board(), (deps.isGuest ?? isGuest)(c)), cache: deps.cache }))),
    )
    .post("/study", async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "body must be JSON" }, 400);
      }
      const q = StudyRequestSchema.safeParse(raw);
      if (!q.success) return invalid(c, q.error, "study");
      try {
        const run = await deps.runStudy(q.data, { source: "ui", deadlineMs: deps.deadlineMs() });
        // Live, never from the cache: the rule may have been saved (or removed) since the study ran.
        const catalogueId = await bounded(Promise.resolve().then(() => deps.catalogueId(q.data.rule)), null, deps.storeTimeoutMs ?? STUDY_STORE_TIMEOUT_MS, "catalogue lookup");
        return c.json(StudyResponseSchema.parse({ ...run, study: { ...run.study, catalogueId }, catalogueId }));
      } catch (err) {
        if (err instanceof ToolInputError) return c.json({ error: err.message, ...(err.field !== undefined && { field: err.field }) }, 400);
        if (err instanceof UpstreamError) return c.json({ error: err.message }, 502);
        console.error("[research] study", err);
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });
}

export function radarRoutes(read: () => Promise<RadarResponse> = () => readRadar(RADAR_DIR)) {
  return new Hono().get("/", async (c) => c.json(RadarResponseSchema.parse(await read())));
}

export const RADAR_DIR = resolve(process.cwd(), "data/radar");

// ---------------------------------------------------------------- process defaults

/** lab_event_study through the registered tool: its own argument parse and defaults, and its trial. */
export const toolEventStudy = (tools: () => ToolDef[] = labTools): RunEventStudy => (args, ctx) => {
  const tool = tools().find((t) => t.name === "lab_event_study");
  if (!tool) throw new Error("lab_event_study is not registered");
  return tool.run(args, ctx);
};

/** Market Pulse loads every catalogue asset's data: kept this long between board loads. */
const PULSE_TTL_MS = 5 * 60_000;
let pulseMemo: { at: number; value: ReturnType<BoardDeps["pulse"]> } | null = null;
let dbCtx: PlatformContext | null = null;

/** The worker's context on the always-on server, else Postgres-only reads; null with neither. */
const platformContext = () => getPlatformContext() ?? (databaseUrl() ? (dbCtx ??= dbPlatformContext(new PgPlatformStore())) : null);

export function defaultBoardDeps(env: Record<string, string | undefined> = process.env): Omit<BoardDeps, "cache"> {
  return {
    now: Date.now,
    pulse: () => {
      if (pulseMemo && Date.now() - pulseMemo.at < PULSE_TTL_MS) return pulseMemo.value;
      const service = getLabService();
      const value = Promise.all([service.marketPulse({}, { deadlineMs: labDeadlineMs(env, SERVER_DEADLINE_MS) }), service.deps.store.listCatalogue()]).then(([pulse, catalogue]) => ({ pulse, catalogue }));
      const memo = { at: Date.now(), value };
      pulseMemo = memo;
      // A late failure clears only its own memo, never a newer one.
      value.catch(() => {
        if (pulseMemo === memo) pulseMemo = null;
      });
      return value;
    },
    novelty: async (sinceBar) => {
      // The novelty loop runs only with a database (its daily inputs live in Postgres).
      if (!databaseUrl()) throw new SourceUnavailable("needs a database (DATABASE_URL unset)");
      const ctx = platformContext();
      if (!ctx) throw new SourceUnavailable("platform offline (no worker loop and no database)");
      return ctx.store.listNovelty(sinceBar);
    },
    opportunities: async (limit) => {
      const ctx = platformContext();
      if (!ctx) throw new SourceUnavailable("platform offline (no worker loop and no database)");
      return ctx.store.listOpportunities({ statuses: [...PRE_DECISION_STATUSES], limit });
    },
    radarCalls: async () => {
      const r = await readRadar(RADAR_DIR);
      if (r.state === "unavailable") throw new SourceUnavailable(r.reason ?? "radar files unreadable");
      return r.calls;
    },
  };
}

let shared: { cache: ResearchRouteDeps["cache"]; runStudy: StudyRunner } | null = null;
/** One study cache and runner per process, the cache in front of the Lab store (so studies survive a restart). */
export function researchRuntime() {
  if (!shared) {
    const store = () => getLabService().deps.store; // resolved on first use, not at import
    const cache = createStudyCache(Date.now, STUDY_CACHE_MAX, { getStudies: (k) => store().getStudies(k), putStudy: (k, v, at) => store().putStudy(k, v, at) });
    shared = { cache, runStudy: createStudyRunner({ cache, eventStudy: toolEventStudy(), now: Date.now }) };
  }
  return shared;
}

/** The catalogue id of a rule if saved: the Lab store's own key (ruleId, as lab_catalogue_save uses). */
export const catalogueIdOf = (store: Pick<LabStore, "getCatalogueEntry">) => async (rule: Rule) => (await store.getCatalogueEntry(ruleId(rule)))?.id ?? null;

export function defaultResearchDeps(env: Record<string, string | undefined> = process.env): ResearchRouteDeps {
  const { cache, runStudy } = researchRuntime();
  return {
    board: () => defaultBoardDeps(env),
    cache,
    runStudy,
    catalogueId: (rule) => catalogueIdOf(getLabService().deps.store)(rule), // resolved per call, not at import
    deadlineMs: () => labDeadlineMs(env, SERVER_DEADLINE_MS),
  };
}
