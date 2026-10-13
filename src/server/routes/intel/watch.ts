import { Hono, type Context } from "hono";
import type { ZodError } from "zod";
import { WatchInputSchema } from "../../../shared/intel.js";
import { checkWatch, type DocwatchDeps } from "../../intel/docwatch.js";

// /api/intel/watches — doc/contract watcher (SPEC.md § Intel I0.19, I2).
// GET    /watches              → {watches}
// POST   /watches  WatchInput  → Watch (201; the first check is the baseline)
// DELETE /watches/:id          → {ok: true}
// GET    /watches/:id/changes  → {changes} (newest first, ≤ 50)
// POST   /watches/:id/check    → {result, watch} (runs one check now)

const ID = /^[0-9a-f-]{36}$/i;
const CHANGES_LIMIT = 50;

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

function serverError(c: Context, err: unknown) {
  console.error("[intel] watches", err);
  return c.json({ error: err instanceof Error ? err.message : "watches error" }, 500);
}

export function createWatchRoutes(deps: DocwatchDeps) {
  return new Hono()
    .get("/watches", async (c) => {
      try {
        return c.json({ watches: await deps.store.listWatches() });
      } catch (err) {
        return serverError(c, err);
      }
    })
    .post("/watches", async (c) => {
      const parsed = WatchInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error);
      try {
        return c.json(await deps.store.insertWatch(parsed.data), 201);
      } catch (err) {
        return serverError(c, err);
      }
    })
    .delete("/watches/:id", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        return (await deps.store.deleteWatch(id)) ? c.json({ ok: true }) : c.json({ error: "watch not found" }, 404);
      } catch (err) {
        return serverError(c, err);
      }
    })
    .get("/watches/:id/changes", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        if (!(await deps.store.getWatch(id))) return c.json({ error: "watch not found" }, 404);
        return c.json({ changes: await deps.store.listWatchChanges(id, CHANGES_LIMIT) });
      } catch (err) {
        return serverError(c, err);
      }
    })
    .post("/watches/:id/check", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        const watch = await deps.store.getWatch(id);
        if (!watch) return c.json({ error: "watch not found" }, 404);
        const result = await checkWatch(deps, watch);
        return c.json({ result, watch: await deps.store.getWatch(id) });
      } catch (err) {
        return serverError(c, err);
      }
    });
}
