import { Hono } from "hono";
import { ThesisInputSchema } from "../../../shared/intel.js";
import { checkThesis, createThesis, type ThesisDeps } from "../../intel/thesis.js";
import { body, failure, invalid } from "./http.js";

// /api/intel/theses — thesis stress-tester (SPEC.md § Intel I0.16, I2).
// GET    /theses            → {theses}
// POST   /theses {text}     → Thesis (extracted by the model, checked by code)
// POST   /theses/:id/check  → Thesis (re-evaluated from its saved checks, no model call)
// DELETE /theses/:id        → {ok: true}

const ID = /^[0-9a-f-]{36}$/i;

/** completeStructured's fail-closed errors → HTTP status. */
export function llmErrorStatus(error: string): 429 | 502 | 503 {
  if (error === "llm not configured") return 503;
  if (error.startsWith("LLM cap reached")) return 429;
  return 502;
}

export function createThesesRoutes(deps: ThesisDeps) {
  return new Hono()
    .get("/theses", async (c) => {
      try {
        return c.json({ theses: await deps.store.listTheses() });
      } catch (err) {
        return failure(c, err, "intel:theses");
      }
    })
    .post("/theses", async (c) => {
      const parsed = ThesisInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error);
      try {
        const r = await createThesis(deps, parsed.data.text);
        if (!r.ok) return c.json({ error: r.error }, llmErrorStatus(r.error));
        return c.json(r.thesis, 201);
      } catch (err) {
        return failure(c, err, "intel:theses");
      }
    })
    .post("/theses/:id/check", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        const t = await checkThesis(deps, id);
        return t ? c.json(t) : c.json({ error: "thesis not found" }, 404);
      } catch (err) {
        return failure(c, err, "intel:theses");
      }
    })
    .delete("/theses/:id", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        return (await deps.store.deleteThesis(id)) ? c.json({ ok: true }) : c.json({ error: "thesis not found" }, 404);
      } catch (err) {
        return failure(c, err, "intel:theses");
      }
    });
}
