import { Hono, type Context } from "hono";
import { z } from "zod";
import { LabSearchRequestSchema } from "../../shared/lab.js";
import { deleteLabRule, getLabRun, listLabRuns } from "../db.js";
import { LabError } from "../lab/search.js";
import { labCatalogue, LabDuplicateError, labEvaluate, LabEvaluateRequestSchema, labFeatures, labSave, LabSaveRequestSchema, labSearch } from "../lab/service.js";

// /api/lab — open-data rule research (SPEC.md "Lab").
//   GET    /features        base series, coverage, transforms
//   POST   /search          run a rule search (kept in run history)
//   POST   /evaluate        score one rule
//   GET    /runs, /runs/:id run history
//   GET    /catalogue       saved rules, live re-check, pulse
//   POST   /catalogue       save a rule report
//   DELETE /catalogue/:id

const UUID = /^[0-9a-f-]{36}$/i;

function badRequest(c: Context, err: z.ZodError) {
  const issue = err.issues[0];
  return c.json({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body", field: issue?.path.join(".") || undefined }, 400);
}

/** LabError = the data cannot answer (422); a missing DB is a config problem (503). */
function failure(c: Context, err: unknown) {
  if (err instanceof LabError) return c.json({ error: err.message }, 422);
  if (err instanceof LabDuplicateError) return c.json({ error: err.message, id: err.id }, 409);
  if (err instanceof Error && err.message.includes("DATABASE_URL is not set")) return c.json({ error: "database not configured" }, 503);
  throw err;
}

async function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

export const labRoutes = new Hono()
  .get("/features", async (c) => {
    try {
      return c.json(await labFeatures());
    } catch (err) {
      return failure(c, err);
    }
  })
  .post("/search", async (c) => {
    const parsed = LabSearchRequestSchema.safeParse((await body(c)) ?? {});
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
      return c.json(await labSearch(parsed.data, { persist: true }));
    } catch (err) {
      return failure(c, err);
    }
  })
  .post("/evaluate", async (c) => {
    const parsed = LabEvaluateRequestSchema.safeParse(await body(c));
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
      return c.json(await labEvaluate(parsed.data));
    } catch (err) {
      return failure(c, err);
    }
  })
  .get("/runs", async (c) => {
    try {
      return c.json(await listLabRuns());
    } catch (err) {
      return failure(c, err);
    }
  })
  .get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "invalid id" }, 400);
    try {
      const run = await getLabRun(id);
      return run ? c.json(run) : c.json({ error: "not found" }, 404);
    } catch (err) {
      return failure(c, err);
    }
  })
  .get("/catalogue", async (c) => {
    try {
      return c.json(await labCatalogue());
    } catch (err) {
      return failure(c, err);
    }
  })
  .post("/catalogue", async (c) => {
    const parsed = LabSaveRequestSchema.safeParse(await body(c));
    if (!parsed.success) return badRequest(c, parsed.error);
    try {
      return c.json(await labSave(parsed.data), 201);
    } catch (err) {
      return failure(c, err);
    }
  })
  .delete("/catalogue/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "invalid id" }, 400);
    try {
      return (await deleteLabRule(id)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
    } catch (err) {
      return failure(c, err);
    }
  });
