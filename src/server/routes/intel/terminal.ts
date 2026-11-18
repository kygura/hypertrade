import { Hono, type Context } from "hono";
import {
  BriefLatestQuerySchema,
  BriefRequestSchema,
  ManualPositionInputSchema,
  ReviewsQuerySchema,
  WatchlistPutSchema,
  type WatchlistResponse,
} from "../../../shared/intel.js";
import { monitoringWatchlist } from "../../intel/positions.js";
import { buildBrief, type TerminalDeps } from "../../intel/terminal.js";
import { body, failure, invalid } from "./http.js";

// /api/intel terminal endpoints (docs/SPEC.md § Intel I2). Session-cookie auth
// comes from the global gate. Mounted by the intel aggregator.
//
// GET    /positions             → PositionsResponse (manual + hl + desk)
// POST   /positions             manual only → 201 ManualPosition
// PUT    /positions/:id         manual only (hl:/desk: ids are read-only → 400)
// DELETE /positions/:id         manual only
// GET    /watchlist             → {items, fallback} (DESK_WATCHLIST when empty)
// PUT    /watchlist {items}     replaces the list
// POST   /brief {via?}          computes a ui brief and logs a review
// GET    /brief/latest?surface  last stored brief, no compute
// GET    /reviews?limit

export interface TerminalRouteDeps extends TerminalDeps {
  /** DESK_WATCHLIST source for the watchlist fallback. */
  env?: Record<string, string | undefined>;
}

const MANUAL_ID = /^[0-9a-f-]{36}$/i;

/** hl:/desk: positions are read-only views of other books; anything else that is not a uuid is not an id at all. */
function manualId(c: Context): string | Response {
  const id = c.req.param("id") ?? "";
  if (/^(hl|desk):/.test(id)) return c.json({ error: "only manual positions can be changed here", field: "id" }, 400);
  if (!MANUAL_ID.test(id)) return c.json({ error: "invalid id", field: "id" }, 400);
  return id;
}

export function createTerminalRoutes(deps: TerminalRouteDeps) {
  const { store } = deps;
  const env = deps.env ?? process.env;

  // The editor shows the stored list, so a store error is a 5xx here, not the silent fallback watchedAssets uses.
  const watchlist = async (): Promise<WatchlistResponse> => monitoringWatchlist(await store.getWatchlist(), env);

  return new Hono()
    .onError((err, c) => failure(c, err, "intel"))
    .get("/positions", async (c) => c.json(await deps.exposure()))
    .post("/positions", async (c) => {
      const parsed = ManualPositionInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error, "position");
      return c.json(await store.createManualPosition(parsed.data), 201);
    })
    .put("/positions/:id", async (c) => {
      const id = manualId(c);
      if (typeof id !== "string") return id;
      const parsed = ManualPositionInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error, "position");
      const row = await store.updateManualPosition(id, parsed.data);
      return row ? c.json(row) : c.json({ error: "position not found" }, 404);
    })
    .delete("/positions/:id", async (c) => {
      const id = manualId(c);
      if (typeof id !== "string") return id;
      return (await store.deleteManualPosition(id)) ? c.json({ ok: true }) : c.json({ error: "position not found" }, 404);
    })
    .get("/watchlist", async (c) => c.json(await watchlist()))
    .put("/watchlist", async (c) => {
      const parsed = WatchlistPutSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error, "watchlist");
      await store.putWatchlist(parsed.data.items);
      return c.json(await watchlist());
    })
    .post("/brief", async (c) => {
      // An empty body is a plain UI open. No request signal: a brief the
      // operator navigates away from still finishes and is stored.
      const parsed = BriefRequestSchema.safeParse((await body(c)) ?? {});
      if (!parsed.success) return invalid(c, parsed.error, "brief request");
      return c.json(await buildBrief(deps, { surface: "ui", via: parsed.data.via }));
    })
    .get("/brief/latest", async (c) => {
      const parsed = BriefLatestQuerySchema.safeParse(c.req.query());
      if (!parsed.success) return invalid(c, parsed.error, "query");
      return c.json({ brief: await store.latestBrief(parsed.data.surface) });
    })
    .get("/reviews", async (c) => {
      const parsed = ReviewsQuerySchema.safeParse(c.req.query());
      if (!parsed.success) return invalid(c, parsed.error, "query");
      return c.json({ reviews: await store.listReviews(parsed.data.limit) });
    });
}
