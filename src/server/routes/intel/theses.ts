import { Hono } from "hono";
import { ThesisInputSchema } from "../../../shared/intel.js";
import { checkThesis, createThesis, type ThesisDeps } from "../../intel/thesis.js";
import { body, failure, invalid } from "./http.js";

// /api/intel/theses — thesis stress-tester (docs/SPEC.md § Intel I0.16, I2).
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
    .onError((err, c) => failure(c, err, "intel:theses"))
    .get("/theses", async (c) => c.json({ theses: await deps.store.listTheses() }))
    .post("/theses", async (c) => {
      const parsed = ThesisInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error);
      const r = await createThesis(deps, parsed.data.text);
      if (!r.ok) return c.json({ error: r.error }, llmErrorStatus(r.error));
      return c.json(r.thesis, 201);
    })
    .post("/theses/:id/check", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      const t = await checkThesis(deps, id);
      return t ? c.json(t) : c.json({ error: "thesis not found" }, 404);
    })
    .delete("/theses/:id", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      return (await deps.store.deleteThesis(id)) ? c.json({ ok: true }) : c.json({ error: "thesis not found" }, 404);
    });
}
