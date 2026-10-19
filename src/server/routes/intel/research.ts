import { Hono } from "hono";
import { z } from "zod";
import { AssetSchema, type ResearchResult } from "../../../shared/intel.js";
import { researchDailyLimit, researchDeps, runResearch, utcDayStart } from "../../intel/research.js";
import { body, failure, invalid } from "./http.js";
import type { TerminalRouteDeps } from "./terminal.js";

// /intel research endpoints (docs/SPEC.md § Scout S1).
//
// POST /research {question, asset?, flagId?} → ResearchResult. Synchronous within RESEARCH_DEADLINE_MS (the function
//     allows 300 s). Always trigger "manual" (a chip-started run stores flagId). 409 while a run is in flight, 429 at
//     INTEL_RESEARCH_DAILY manual runs since UTC midnight, 200 with status "capped" over the dollar cap.
// GET  /research?asset&limit=20 → {items, usedToday, limit}

// Stored as typed (HL symbols are case-sensitive: kPEPE, xyz:TSLA); the store matches assets case-insensitively.
const Asset = AssetSchema;
const RequestSchema = z.object({
  question: z.string().trim().min(3).max(500),
  asset: Asset.optional(),
  flagId: z.string().min(1).max(200).optional(),
});
const ListQuerySchema = z.object({ asset: Asset.optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });

export type ResearchRouteDeps = Pick<TerminalRouteDeps, "store" | "exposure" | "llm" | "now" | "env">;

export function createResearchRoutes(deps: ResearchRouteDeps) {
  const { store } = deps;
  const env = deps.env ?? process.env;
  const limit = researchDailyLimit(env);

  return new Hono()
    .post("/research", async (c) => {
      const parsed = RequestSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error, "research request");
      const { question, flagId } = parsed.data;
      try {
        const now = deps.now();
        if ((await store.researchCountSince(utcDayStart(now), "manual")) >= limit) return c.json({ error: `daily research limit reached (${limit})` }, 429);
        const flag = flagId ? (await store.getEventByKey(`flow:${flagId}`))?.flag : undefined;
        if (flagId && !flag) return c.json({ error: "unknown flag", field: "flagId" }, 404);
        const result = await runResearch(researchDeps(deps), { question, asset: parsed.data.asset ?? flag?.asset ?? null, trigger: "manual", flag });
        return result ? c.json(result) : c.json({ error: "a research run is already in flight" }, 409);
      } catch (err) {
        return failure(c, err, "intel:research", "research unavailable");
      }
    })
    .get("/research", async (c) => {
      const q = ListQuerySchema.safeParse({ asset: c.req.query("asset"), limit: c.req.query("limit") });
      if (!q.success) return invalid(c, q.error, "query");
      try {
        const [items, usedToday] = await Promise.all([store.listResearch(q.data), store.researchCountSince(utcDayStart(deps.now()), "manual")]);
        const res: { items: ResearchResult[]; usedToday: number; limit: number } = { items, usedToday, limit };
        return c.json(res);
      } catch (err) {
        return failure(c, err, "intel:research", "research unavailable");
      }
    });
}
