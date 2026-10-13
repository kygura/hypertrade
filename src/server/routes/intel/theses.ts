import { Hono, type Context } from "hono";
import type { ZodError } from "zod";
import { ThesisInputSchema } from "../../../shared/intel.js";
import { checkThesis, createThesis, type ThesisDeps } from "../../intel/thesis.js";

// /api/intel/theses — thesis stress-tester (SPEC.md § Intel I0.16, I2).
// GET    /theses            → {theses}
// POST   /theses {text}     → Thesis (extracted by the model, checked by code)
// POST   /theses/:id/check  → Thesis (re-evaluated from its saved checks, no model call)
// DELETE /theses/:id        → {ok: true}

const ID = /^[0-9a-f-]{36}$/i;

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

const invalid = (c: Context, e: ZodError) => {
  const issue = e.issues[0];
  return c.json({ error: `invalid request: ${issue?.message ?? "bad body"}`, field: issue?.path.join(".") || undefined }, 400);
};

/** completeStructured's fail-closed errors → HTTP status. */
export function llmErrorStatus(error: string): 429 | 502 | 503 {
  if (error === "llm not configured") return 503;
  if (error === "LLM cap reached") return 429;
  return 502;
}

function serverError(c: Context, err: unknown) {
  console.error("[intel] theses", err);
  return c.json({ error: err instanceof Error ? err.message : "theses error" }, 500);
}

export function createThesesRoutes(deps: ThesisDeps) {
  return new Hono()
    .get("/theses", async (c) => {
      try {
        return c.json({ theses: await deps.store.listTheses() });
      } catch (err) {
        return serverError(c, err);
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
        return serverError(c, err);
      }
    })
    .post("/theses/:id/check", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        const t = await checkThesis(deps, id);
        return t ? c.json(t) : c.json({ error: "thesis not found" }, 404);
      } catch (err) {
        return serverError(c, err);
      }
    })
    .delete("/theses/:id", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        return (await deps.store.deleteThesis(id)) ? c.json({ ok: true }) : c.json({ error: "thesis not found" }, 404);
      } catch (err) {
        return serverError(c, err);
      }
    });
}
