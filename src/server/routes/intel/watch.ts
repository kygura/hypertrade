import { Hono } from "hono";
import { WatchInputSchema, type Watch } from "../../../shared/intel.js";
import { checkWatch, type DocwatchDeps } from "../../intel/docwatch.js";
import { body, failure, invalid } from "./http.js";

// /api/intel/watches — doc/contract watcher (SPEC.md § Intel I0.19, I2).
// GET    /watches              → {watches} (metadata: lastSnapshot stays server-side)
// POST   /watches  WatchInput  → Watch (201; the first check is the baseline)
// DELETE /watches/:id          → {ok: true}
// GET    /watches/:id/changes  → {changes} (newest first, ≤ 50)
// POST   /watches/:id/check    → {result, watch} (runs one check now)

const ID = /^[0-9a-f-]{36}$/i;
const CHANGES_LIMIT = 50;

/** 500 detail goes to the log only: store errors can carry connection strings or SQL. */
/** A watch as the API returns it: the stored snapshot (up to 200 KB of page text) is never sent. */
function view(w: Watch): Omit<Watch, "lastSnapshot"> {
  const { lastSnapshot: _snapshot, ...rest } = w;
  return rest;
}

export function createWatchRoutes(deps: DocwatchDeps) {
  return new Hono()
    .get("/watches", async (c) => {
      try {
        return c.json({ watches: (await deps.store.listWatches()).map(view) });
      } catch (err) {
        return failure(c, err, "intel:watches", "watches error");
      }
    })
    .post("/watches", async (c) => {
      const parsed = WatchInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error);
      try {
        return c.json(view(await deps.store.insertWatch(parsed.data)), 201);
      } catch (err) {
        return failure(c, err, "intel:watches", "watches error");
      }
    })
    .delete("/watches/:id", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        return (await deps.store.deleteWatch(id)) ? c.json({ ok: true }) : c.json({ error: "watch not found" }, 404);
      } catch (err) {
        return failure(c, err, "intel:watches", "watches error");
      }
    })
    .get("/watches/:id/changes", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        if (!(await deps.store.getWatch(id))) return c.json({ error: "watch not found" }, 404);
        return c.json({ changes: await deps.store.listWatchChanges(id, CHANGES_LIMIT) });
      } catch (err) {
        return failure(c, err, "intel:watches", "watches error");
      }
    })
    .post("/watches/:id/check", async (c) => {
      const id = c.req.param("id");
      if (!ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        const watch = await deps.store.getWatch(id);
        if (!watch) return c.json({ error: "watch not found" }, 404);
        const result = await checkWatch(deps, watch);
        const after = await deps.store.getWatch(id);
        return c.json({ result, watch: after && view(after) });
      } catch (err) {
        return failure(c, err, "intel:watches", "watches error");
      }
    });
}
