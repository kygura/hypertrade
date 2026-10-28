import { Hono } from "hono";
import { SECTORS_HISTORY } from "../../../../data/sectors/index.js";
import sectorsLatest from "../../../../data/sectors/latest.json" with { type: "json" };
import { NarrativeViewInputSchema, type NarrativeContrast, type NarrativeFlow, type NarrativesResponse, type NarrativeView } from "../../../shared/intel.js";
import { SectorsDataSchema } from "../../../shared/schemas.js";
import type { SectorsData } from "../../../shared/types.js";
import { CONTRAST_RUNS_SETTING, CONTRASTS_SETTING, contrastDailyLimit, HEADLINE_HOURS, runContrast, VIEWS_SETTING } from "../../intel/narrativeContrast.js";
import { loadNarrativeFlows, narrativeHeadlines } from "../../intel/narratives.js";
import type { IntelStore } from "../../intel/store.js";
import type { LlmDeps } from "../../intel/llm.js";
import { utcDayStart } from "../../intel/research.js";
import { body, failure, invalid } from "./http.js";

// /intel narrative endpoints (docs/SPEC.md § Narratives).
//
// GET  /narratives → NarrativesResponse: every routine sector basket with its HTF stage, LTF windows, the
//     operator's view, the latest contrast and its last HEADLINE_HOURS of headlines (≤ HEADLINES_PER_ROW, one
//     per cluster), strongest LTF flow first. Flows are cached FLOW_CACHE_MS; events are read per request.
// PUT  /narratives/:id/view {lean, note} → NarrativeView. 404 for an id not in the current sector file.
// POST /narratives/:id/contrast → NarrativeContrast (research, synchronous within CONTRAST_DEADLINE_MS).
//     409 while a run for any narrative is in flight, 429 at INTEL_NARRATIVE_DAILY runs since UTC midnight.

export const FLOW_CACHE_MS = 120_000;
export const HEADLINES_PER_ROW = 5;

export interface NarrativeRouteDeps {
  store: Pick<IntelStore, "snapshotRange" | "listEvents" | "getSetting" | "setSetting">;
  llm: LlmDeps;
  now(): Date;
  env?: Record<string, string | undefined>;
  /** Defaults to the committed routine files. */
  sectors?: () => SectorsData;
  history?: Array<{ date: string; data: unknown }>;
}

type Runs = { day: string; n: number };

export function createNarrativeRoutes(deps: NarrativeRouteDeps) {
  const { store } = deps;
  const env = deps.env ?? process.env;
  const limit = contrastDailyLimit(env);
  const sectors = deps.sectors ?? (() => SectorsDataSchema.parse(sectorsLatest));
  const history = deps.history ?? SECTORS_HISTORY;
  let cache: { at: number; asOf: string; flows: NarrativeFlow[] } | null = null;
  let running = false;

  const flows = async (): Promise<{ asOf: string; flows: NarrativeFlow[] }> => {
    const data = sectors();
    const t = deps.now().getTime();
    if (cache && cache.asOf === data.generated_at && t - cache.at < FLOW_CACHE_MS) return cache;
    cache = { at: t, asOf: data.generated_at, flows: await loadNarrativeFlows({ store, now: deps.now, sectors: data, history }) };
    return cache;
  };
  const views = async () => (await store.getSetting<Record<string, NarrativeView>>(VIEWS_SETTING)) ?? {};
  const contrasts = async () => (await store.getSetting<Record<string, NarrativeContrast>>(CONTRASTS_SETTING)) ?? {};
  const sectorOf = (id: string) => sectors().sectors.find((s) => s.id === id);

  return new Hono()
    .get("/narratives", async (c) => {
      try {
        const since = new Date(deps.now().getTime() - HEADLINE_HOURS * 3_600_000);
        const [f, v, k, events] = await Promise.all([flows(), views(), contrasts(), store.listEvents({ since, limit: 300 })]);
        const res: NarrativesResponse = {
          generatedAt: deps.now().toISOString(),
          sectorsAsOf: f.asOf,
          narratives: f.flows.map((n) => ({ ...n, view: v[n.id] ?? null, contrast: k[n.id] ?? null, headlines: narrativeHeadlines(events, n.tokens, HEADLINES_PER_ROW) })),
        };
        return c.json(res);
      } catch (err) {
        return failure(c, err, "intel:narratives", "narratives unavailable");
      }
    })
    .put("/narratives/:id/view", async (c) => {
      const id = c.req.param("id");
      if (!sectorOf(id)) return c.json({ error: "unknown narrative", field: "id" }, 404);
      const parsed = NarrativeViewInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error, "view");
      try {
        const view: NarrativeView = { ...parsed.data, updatedAt: deps.now().toISOString() };
        await store.setSetting(VIEWS_SETTING, { ...(await views()), [id]: view });
        return c.json(view);
      } catch (err) {
        return failure(c, err, "intel:narratives", "narratives unavailable");
      }
    })
    .post("/narratives/:id/contrast", async (c) => {
      const id = c.req.param("id");
      const sector = sectorOf(id);
      if (!sector) return c.json({ error: "unknown narrative", field: "id" }, 404);
      if (running) return c.json({ error: "a contrast run is already in flight" }, 409);
      running = true;
      try {
        const day = utcDayStart(deps.now()).toISOString();
        const runs = await store.getSetting<Runs>(CONTRAST_RUNS_SETTING);
        const used = runs?.day === day ? runs.n : 0;
        if (used >= limit) return c.json({ error: `daily contrast limit reached (${limit})` }, 429);
        const flow = (await flows()).flows.find((n) => n.id === id);
        if (!flow) return c.json({ error: "unknown narrative", field: "id" }, 404);
        const result = await runContrast({ store, llm: deps.llm, now: deps.now }, { flow, rationale: sector.rationale, view: (await views())[id] ?? null });
        // A run that reached no provider costs nothing and does not count.
        if (result.status !== "no_web_search") await store.setSetting(CONTRAST_RUNS_SETTING, { day, n: used + 1 } satisfies Runs);
        if (result.status === "done") await store.setSetting(CONTRASTS_SETTING, { ...(await contrasts()), [id]: result });
        return c.json(result);
      } catch (err) {
        return failure(c, err, "intel:narratives", "narratives unavailable");
      } finally {
        running = false;
      }
    });
}
