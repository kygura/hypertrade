import { Hono } from "hono";
import { renderThesis } from "../../../shared/regime/render.js";
import type { RegimeFeed } from "../../../shared/regime/schema.js";
import { defaultRegimeStore, type RegimeStore } from "../../regime/store.js";
import { failure } from "./http.js";

// /api/intel/regime — the living regime thesis (docs/REGIME.md). Read only: `bun run regime update` (or the Regime
// workflow) writes it; nothing here calls a model.
// GET /regime            → RegimeFeed {persistent, thesis, history}
// GET /regime?format=md  → the thesis as Markdown (text/markdown), 404 before the first version

export interface RegimeRouteDeps {
  /** Built on first request; defaults to defaultRegimeStore(). */
  regime?: () => RegimeStore;
}

const HISTORY_SERVED = 60;

export function createRegimeRoutes(deps: RegimeRouteDeps = {}) {
  let store: RegimeStore | null = null;
  const get = () => (store ??= deps.regime ? deps.regime() : defaultRegimeStore());
  return new Hono().onError((err, c) => failure(c, err, "intel:regime", "regime store error")).get("/regime", async (c) => {
    const s = get();
    const [thesis, history] = await Promise.all([s.thesis(), s.history(HISTORY_SERVED)]);
    if (c.req.query("format") === "md") {
      if (!thesis) return c.json({ error: "no regime thesis yet" }, 404);
      return c.body(renderThesis(thesis, history), 200, { "content-type": "text/markdown; charset=utf-8" });
    }
    const feed: RegimeFeed = { persistent: s.kind !== "memory", thesis, history };
    return c.json(feed);
  });
}
