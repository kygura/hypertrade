import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  AgentRecordSchema,
  AgentRecordsResponseSchema,
  AGENT_RECORD_STATUSES,
  AgentStatsResponseSchema,
  MoveWindowSchema,
  TriageItemSchema,
  TriageResponseSchema,
  type AgentRecord,
  type TriageResponse,
} from "../../shared/agentRecords.js";
import { AssetSchema } from "../../shared/intel.js";
import { isGuest } from "../auth.js";
import { databaseUrl } from "../db.js";
import { intelProviderFactory, type LlmDeps } from "../intel/llm.js";
import { PgIntelStore } from "../intel/store.js";
import { getPlatformContext } from "../platform/context.js";
import type { PlatformStore } from "../platform/store.js";
import { PgPlatformStore } from "../platform/store-pg.js";
import { getCtxs } from "../routes/hl.js";
import { MemoryLlmCache } from "../routine/llm.js";
import { invalid } from "../routes/intel/http.js";
import { agentBlockedReason, investigate, NO_PROVIDER, NO_WEB_SEARCH, type AgentDeps } from "./agent.js";
import { agentStats } from "./agentGrade.js";
import { latestTriageScan, linkTriage, type TriageScan } from "./agentLoop.js";
import { readTriageScan, triageNote } from "./stored.js";
import { getMovesService, type MovesService } from "./service.js";
import { agentDailyCap, triageBudget, utcDay, utcDayStart } from "./triage.js";

export { agentBlockedReason };

// Agent watch routes (docs/SPEC.md § Moves), mounted by routes/moves.ts before its own /:coin handler:
//   GET  /triage                 → TriageResponse: the day's queue under MOVES_TRIAGE_DAILY, each item with its record
//   GET  /records?coin=&status=  → AgentRecordsResponse (signed in only: model-written claims, as /radar)
//   GET  /records/stats          → AgentStatsResponse: n, clusters, mean vs BTC and hit rate (null under 5 clusters)
//   POST /triage/:id/dismiss     → { item }: hides it for the day; it still counts against the budget
//   POST /:coin/investigate?window= → AgentRecord: one LLM run. 409 one in flight · 429 cap reached · 503 no provider
// Every route reads and writes the platform store, so they work on Vercel with a database: the triage pass is the one
// stored by the moves-agent job or loop (stored.ts), its staleness stated in `reason`. Without a store the triage
// answer is `unavailable` and the POSTs 503. Nothing here approves an opportunity or places an order.

export interface MoveAgentDeps {
  /** Why the agent watch cannot run in this process, or null (the default: the store decides). */
  unavailable(): string | null;
  /** The platform store holding records and triage items; null without the worker or a database. */
  store(): PlatformStore | null;
  moves(): Pick<MovesService, "coin">;
  /** The agent's deps less the store. */
  agent(): Omit<AgentDeps, "store">;
  /** MOVES_TRIAGE_DAILY. */
  budget: number;
  /** Live mark (BTC is the grading baseline); null when unknown. */
  mark(coin: string): Promise<number | null>;
  /** The latest triage pass (watched, overBudget): the stored one, else this process's. */
  scan(): TriageScan | null | Promise<TriageScan | null>;
  now(): Date;
  isGuest?: (c: Context) => boolean;
}

const NO_STORE = "needs the always-on server or a database (agent records live in the platform store)";

const RecordsQuerySchema = z.object({
  coin: AssetSchema.optional(),
  status: z.enum(AGENT_RECORD_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export function moveAgentRoutes(deps: MoveAgentDeps): Hono {
  const guest = (c: Context) => (deps.isGuest ?? isGuest)(c);
  const unavailable = (c: Context, reason: string) => c.json({ error: "unavailable", reason }, 503);
  return new Hono()
    .get("/triage", async (c) => {
      const now = deps.now();
      const day = utcDay(now);
      const agent = deps.agent();
      const empty: TriageResponse = {
        state: "unavailable", reason: null, day, budget: deps.budget, surfaced: 0, overBudget: 0, watched: 0,
        agentRuns: 0, agentCap: agent.dailyCap, agentBlockedReason: null, items: [],
      };
      const off = deps.unavailable();
      const store = deps.store();
      if (off || !store) {
        const reason = off ?? NO_STORE;
        return c.json(TriageResponseSchema.parse({ ...empty, reason, agentBlockedReason: reason }));
      }
      const since = utcDayStart(now).toISOString();
      const [items, records, runs, scan] = await Promise.all([store.listTriage(day), store.listAgentRecords({ since, limit: 1000 }), store.agentRunsSince(since), deps.scan()]);
      const byId = new Map(records.map((r) => [r.id, r]));
      const today = scan?.day === day ? scan : null;
      const hide = guest(c);
      return c.json(
        TriageResponseSchema.parse({
          ...empty,
          state: "ok",
          reason: triageNote(scan, now.getTime()),
          surfaced: items.length,
          overBudget: today?.overBudget ?? 0,
          watched: scan?.watched ?? 0,
          agentRuns: runs,
          agentBlockedReason: await agentBlockedReason(agent, runs),
          items: items.map((t) => ({ ...t, record: !hide && t.recordId ? (byId.get(t.recordId) ?? null) : null })),
        }),
      );
    })
    .get("/records/stats", async (c) => {
      const store = deps.store();
      const records = store ? await store.listAgentRecords({ limit: 100_000 }) : [];
      return c.json(AgentStatsResponseSchema.parse(agentStats(records)));
    })
    .get("/records", async (c) => {
      if (guest(c)) return c.json({ error: "sign in required" }, 401);
      const q = RecordsQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      const store = deps.store();
      const records = store ? await store.listAgentRecords(q.data) : [];
      return c.json(AgentRecordsResponseSchema.parse({ records }));
    })
    .post("/triage/:id/dismiss", async (c) => {
      const off = deps.unavailable();
      const store = deps.store();
      if (off || !store) return unavailable(c, off ?? NO_STORE);
      const item = await store.dismissTriage(c.req.param("id"), deps.now().toISOString());
      if (!item) return c.json({ error: "no such triage item", field: "id" }, 404);
      return c.json({ item: TriageItemSchema.parse(item) });
    })
    .post("/:coin/investigate", async (c) => {
      const coin = AssetSchema.safeParse(c.req.param("coin"));
      if (!coin.success) return invalid(c, coin.error, "coin");
      const window = MoveWindowSchema.safeParse(c.req.query("window") ?? "24h");
      if (!window.success) return invalid(c, window.error, "window");
      const off = deps.unavailable();
      const store = deps.store();
      if (off || !store) return unavailable(c, off ?? NO_STORE);
      const agent = deps.agent();
      if (agent.inflight.has(coin.data)) return c.json({ error: `an investigation of ${coin.data} is in flight` }, 409);
      const detail = await deps.moves().coin(coin.data, window.data);
      if (detail.state !== "ok" || !(detail.mark > 0)) return unavailable(c, detail.reason ?? `no moves data for ${coin.data}`);
      const btc = await deps.mark("BTC");
      if (btc == null || !(btc > 0)) return unavailable(c, "no BTC mark (the grading baseline)");
      const record = await investigate({ ...agent, store }, { detail, btcMark: btc, trigger: "manual" });
      if (!record) return c.json({ error: `an investigation of ${detail.coin} is in flight` }, 409);
      if (record.status !== "capped" && record.error !== NO_PROVIDER) await linkTriage(store, utcDay(deps.now()), detail.coin, record.id).catch(() => {});
      const body = AgentRecordSchema.parse(record);
      if (record.status === "capped") return c.json(body, 429);
      if (record.error === NO_PROVIDER || record.error === NO_WEB_SEARCH) return c.json(body, 503);
      return c.json(body);
    });
}

// ---------------------------------------------------------------- production wiring

const envNum = (v: string | undefined, def: number) => (v?.trim() && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : def);

/** In-flight coins of this process, shared by the routes and the loop. */
const INFLIGHT = new Set<string>();
let pgStore: PgPlatformStore | null = null;
let agentDeps: Omit<AgentDeps, "store"> | null = null;

/** The platform store the records live in: the worker's, else Postgres when configured, else none. */
export function agentStore(): PlatformStore | null {
  const ctx = getPlatformContext();
  if (ctx) return ctx.store;
  if (!databaseUrl()) return null;
  return (pgStore ??= new PgPlatformStore());
}

/**
 * The agent's LLM wiring: Intel's provider factory and daily caps (INTEL_LLM_DAILY_CAP, INTEL_LLM_DAILY_USD). With a
 * database the call counter is the Intel cache table, so the spend is shared with Intel and shown in health; without
 * one an in-process MemoryLlmCache. Plus MOVES_AGENT_DAILY, counted from the platform store.
 */
export function defaultAgentDeps(env: Record<string, string | undefined> = process.env): Omit<AgentDeps, "store"> {
  const llm: LlmDeps = {
    makeProvider: intelProviderFactory(env),
    cache: databaseUrl(env) ? new PgIntelStore() : new MemoryLlmCache(),
    now: () => new Date(),
    dailyCap: Math.round(envNum(env.INTEL_LLM_DAILY_CAP, 200)),
    dailyUsd: envNum(env.INTEL_LLM_DAILY_USD, 2),
  };
  return { llm, now: () => new Date(), dailyCap: agentDailyCap(env), inflight: INFLIGHT };
}

/** This process's agent deps (one LLM counter and in-flight set for the routes and the loop). */
export const sharedAgentDeps = () => (agentDeps ??= defaultAgentDeps());

/** Live mark from HL's cached asset contexts (60 s). */
export async function liveMark(coin: string): Promise<number | null> {
  const ctx = (await getCtxs().catch(() => null))?.ctxs.find((x) => x.name === coin);
  return ctx && ctx.markPx > 0 ? ctx.markPx : null;
}

export function defaultMoveAgentDeps(): MoveAgentDeps {
  return {
    unavailable: () => null,
    store: agentStore,
    moves: getMovesService,
    agent: sharedAgentDeps,
    budget: triageBudget(),
    mark: liveMark,
    scan: () => readTriageScan(agentStore(), latestTriageScan),
    now: () => new Date(),
  };
}

/** The coin's latest agent record for the detail view; null when none exists or the store is unreachable. */
export async function latestAgentRecord(coin: string): Promise<AgentRecord | null> {
  const store = agentStore();
  if (!store) return null;
  return (await store.listAgentRecords({ coin, limit: 1 }).catch(() => []))[0] ?? null;
}
