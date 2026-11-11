import { Hono, type Context } from "hono";
import { z } from "zod";
import { TriageResponseSchema, type AgentRecord } from "../../shared/agentRecords.js";
import { AssetSchema } from "../../shared/intel.js";
import { MoveDetailSchema, MovesResponseSchema, MoveWindowSchema, type LayerState } from "../../shared/moves.js";
import { isGuest } from "../auth.js";
import { agentStore, defaultMoveAgentDeps, latestAgentRecord, moveAgentRoutes } from "../moves/agentRoutes.js";
import { getMovesService, UnknownCoinError, type MovesService } from "../moves/service.js";
import { storedUniverse } from "../moves/stored.js";
import { isServerless } from "../platform/runtime.js";
import type { PlatformStore } from "../platform/store.js";
import { failure, invalid } from "./intel/http.js";

// /api/moves (docs/SPEC.md § Moves): per-coin move attribution (BTC, ETH ex-BTC, sector ex-majors, residual) with
// positioning, liquidation proximity, attention and the ENTER/FADE condition checklists. Explained after the fact.
//   GET /moves?window=4h|24h|72h       → MovesResponse: the in-process run on the always-on server (`pending` on the
//                                        first run); on a serverless runtime the latest run the moves job stored
//                                        (moves/stored.ts: `reason` says when it is over 2 h old; `unavailable`
//                                        "no moves run stored yet" before the first)
//   GET /moves/:coin?window=           → MoveDetail, computed inline (works on Vercel); 404 for an unknown coin
//   /moves/triage, /moves/records*, POST /moves/triage/:id/dismiss, POST /moves/:coin/investigate → the agent watch
//                                        (moves/agentRoutes.ts), mounted before /:coin
// Auth: GETs are guest-readable in PUBLIC_MODE; a guest gets the numbers but no headlines and no agent record.
// 400 {error, field} on a bad query. Every answer is zod-parsed on the way out.

export interface MovesRouteDeps {
  service: () => Pick<MovesService, "universe" | "coin">;
  /** The agent watch sub-app (triage, records, investigate). */
  agents: Hono;
  /** The coin's latest agent record (signed-in detail only). */
  latestRecord: (coin: string) => Promise<AgentRecord | null>;
  isGuest?: (c: Context) => boolean;
  now?: () => number;
}

const QuerySchema = z.object({ window: MoveWindowSchema.default("24h") });
const AGENTS_LAYER_MS = 60_000;

/** The agent layer as the triage endpoint states it: unavailable with its reason, partial when blocked, else ok. */
export function agentsLayer(t: { state: "ok" | "unavailable"; reason: string | null; agentBlockedReason: string | null } | null): LayerState {
  if (!t) return { state: "unavailable", reason: "agent watch not available" };
  if (t.state === "unavailable") return { state: "unavailable", reason: t.reason ?? "agent watch unavailable" };
  if (t.agentBlockedReason) return { state: "partial", reason: `investigations blocked: ${t.agentBlockedReason}` };
  return { state: "ok", reason: null };
}

export function movesRoutes(deps: MovesRouteDeps) {
  const guest = (c: Context) => (deps.isGuest ?? isGuest)(c);
  const now = deps.now ?? Date.now;
  let agents: { at: number; value: Promise<LayerState> } | null = null;
  const agentLayer = (): Promise<LayerState> => {
    if (!agents || now() - agents.at >= AGENTS_LAYER_MS) {
      const value = Promise.resolve()
        .then(() => deps.agents.request("/triage"))
        .then(async (r) => (r.ok ? agentsLayer(TriageResponseSchema.parse(await r.json())) : agentsLayer(null)))
        .catch(() => agentsLayer(null));
      agents = { at: now(), value };
    }
    return agents.value;
  };

  return new Hono()
    .route("/", deps.agents)
    .get("/", async (c) => {
      const q = QuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      try {
        const [r, a] = await Promise.all([deps.service().universe(q.data.window), agentLayer()]);
        return c.json(MovesResponseSchema.parse({ ...r, layers: { ...r.layers, agents: a } }));
      } catch (err) {
        return failure(c, err, "moves", "moves unavailable");
      }
    })
    .get("/:coin", async (c) => {
      const q = QuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const coin = AssetSchema.safeParse(c.req.param("coin"));
      if (!coin.success || coin.data.includes(":")) return c.json({ error: "invalid coin: a main-dex perp name", field: "coin" }, 400);
      try {
        const hide = guest(c);
        const [d, a] = await Promise.all([deps.service().coin(coin.data, q.data.window), agentLayer()]);
        const record = hide || d.state !== "ok" ? null : await deps.latestRecord(d.coin).catch(() => null);
        return c.json(MoveDetailSchema.parse({ ...d, layers: { ...d.layers, agents: a }, headlines: hide ? [] : d.headlines, record }));
      } catch (err) {
        if (err instanceof UnknownCoinError) return c.json({ error: err.message, field: "coin" }, 404);
        return failure(c, err, "moves", "moves unavailable");
      }
    });
}

/**
 * The moves source where no in-process service runs (serverless): the universe from the stored run, the single-coin
 * detail inline (service.ts coin() loads the coin, BTC, ETH and a few peers itself, without an hourly run).
 */
export function storedMovesService(store: () => Pick<PlatformStore, "latestMovesRun"> | null, inline: () => Pick<MovesService, "coin">, now: () => number = Date.now): Pick<MovesService, "universe" | "coin"> {
  return { universe: (w) => storedUniverse(store(), w, now()), coin: (coin, w) => inline().coin(coin, w) };
}

export const defaultMovesRouteDeps = (env: Record<string, string | undefined> = process.env): MovesRouteDeps => ({
  service: isServerless(env) ? () => storedMovesService(agentStore, getMovesService) : getMovesService,
  agents: moveAgentRoutes(defaultMoveAgentDeps()),
  latestRecord: latestAgentRecord,
});
