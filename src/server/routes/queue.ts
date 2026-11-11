import { Hono, type Context } from "hono";
import type { AgentRecord, TriageItem } from "../../shared/agentRecords.js";
import type { Opportunity } from "../../shared/platform.js";
import { parseQueueItemId, QueueDismissResponseSchema, QueueResponseSchema, type QueueResponse } from "../../shared/queue.js";
import type { RadarCall } from "../../shared/radar.js";
import { isGuest } from "../auth.js";
import type { AgentDeps } from "../moves/agent.js";
import { latestTriageScan, type TriageScan } from "../moves/agentLoop.js";
import { readTriageScan, triageNote } from "../moves/stored.js";
import { agentBlockedReason, agentStore, sharedAgentDeps } from "../moves/agentRoutes.js";
import { triageBudget, triageId, utcDay, utcDayStart } from "../moves/triage.js";
import type { PlatformStore, QueueDismissal } from "../platform/store.js";
import { mergeQueue, type SourceInput } from "../queue/merge.js";
import { readRadar } from "../research/radar.js";
import { bounded } from "../research/study.js";
import { platformContext, RADAR_DIR } from "./research.js";

// /api/queue (docs/SPEC.md § Queue): one short list of what deserves a look, merged from the moves triage queue,
// ready platform opportunities and landed radar calls under one daily budget (MOVES_TRIAGE_DAILY).
//   GET  /               → QueueResponse. Guest-readable in PUBLIC_MODE: a guest gets no radar and no agent record.
//   POST /:id/dismiss    → QueueDismissResponse: hides the coin for the UTC day and dismisses its triage item too.
//                          400 {error, field: "id"} for a bad id or another day; 503 {error, reason} without a store.
// Each source loads under SOURCE_TIMEOUT_MS; a failing source is `unavailable` with its reason, the rest still merge.
// The queue sends nothing (no push); nothing here approves an opportunity or places an order.

export interface QueueRouteDeps {
  now(): Date;
  /** MOVES_TRIAGE_DAILY: the one attention budget across sources. */
  cap: number;
  /** The platform store (triage items, agent records, queue dismissals); null without the worker or a database. */
  store(): PlatformStore | null;
  /** Why the moves source cannot be read in this process, or null (the default: the stored triage serves every runtime). */
  movesUnavailable(): string | null;
  /** Ready opportunities and those whose status moved since `dayStart`; throws when the platform is offline. */
  opportunities(dayStart: Date): Promise<Opportunity[]>;
  /** Landed radar calls; throws with the reason when the files are unavailable. */
  radar(): Promise<RadarCall[]>;
  /** The latest triage pass, stored by the moves-agent job or loop (its `watched` count, as /api/moves/triage reads it). */
  scan(): TriageScan | null | Promise<TriageScan | null>;
  /** The agent's deps less the store (daily cap, LLM wiring). */
  agent(): Omit<AgentDeps, "store">;
  isGuest?: (c: Context) => boolean;
  /** Per-source timeout; default SOURCE_TIMEOUT_MS. */
  timeoutMs?: number;
}

export const SOURCE_TIMEOUT_MS = 3_000;
const NO_STORE = "needs the always-on server or a database (the queue lives in the platform store)";
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "unavailable";

/** A source's rows, or `unavailable` with why: a throw, or no answer within `ms`. */
async function load<T>(what: string, f: () => Promise<T[]>, ms: number): Promise<SourceInput<T>> {
  const timedOut = { unavailable: `no answer within ${ms / 1000} s` };
  return bounded(f().then((ok): SourceInput<T> => ({ ok }), (e): SourceInput<T> => ({ unavailable: why(e) })), timedOut, ms, `queue ${what}`);
}

export function queueRoutes(d: QueueRouteDeps) {
  const guest = (c: Context) => (d.isGuest ?? isGuest)(c);
  const ms = d.timeoutMs ?? SOURCE_TIMEOUT_MS;
  return new Hono()
    .get("/", async (c) => {
      const now = d.now();
      const day = utcDay(now);
      const dayStart = utcDayStart(now);
      const since = dayStart.toISOString();
      const hide = guest(c);
      const agent = d.agent();
      const store = d.store();
      const off = d.movesUnavailable();
      const none = <T>(reason: string): Promise<SourceInput<T>> => Promise.resolve({ unavailable: reason });
      const [triage, opportunities, radar, records, dismissals, runs, scan] = await Promise.all([
        off ? none<TriageItem>(off) : store ? load("triage", () => store.listTriage(day), ms) : none<TriageItem>(NO_STORE),
        store ? load("opportunities", () => d.opportunities(dayStart), ms) : none<Opportunity>(NO_STORE),
        hide ? none<RadarCall>("sign in required") : load("radar", () => d.radar(), ms),
        store && !hide ? load<AgentRecord>("records", () => store.listAgentRecords({ since, limit: 1000 }), ms) : none<AgentRecord>(NO_STORE),
        store ? load<QueueDismissal>("dismissals", () => store.listQueueDismissals(day), ms) : none<QueueDismissal>(NO_STORE),
        store ? bounded(store.agentRunsSince(since), 0, ms, "queue agent runs") : Promise.resolve(0),
        off ? null : bounded(Promise.resolve(d.scan()).catch(() => null), null, ms, "queue triage scan"),
      ]);
      const merged = mergeQueue({
        day, now, cap: d.cap, guest: hide, triage, opportunities, radar,
        records: "ok" in records ? records.ok : [],
        dismissals: "ok" in dismissals ? dismissals.ok : [],
      });
      const blocked = off ?? (store ? await agentBlockedReason(agent, runs) : NO_STORE);
      // The moves source states how fresh its triage pass is (none stored yet, stale, or the pass's own reason).
      const sources = merged.sources.moves.state === "ok" ? { ...merged.sources, moves: { ...merged.sources.moves, reason: triageNote(scan, now.getTime()) } } : merged.sources;
      const body: QueueResponse = { ...merged, sources, agentRuns: runs, agentCap: agent.dailyCap, agentBlockedReason: blocked, watched: scan?.watched ?? 0 };
      return c.json(QueueResponseSchema.parse(body));
    })
    .post("/:id/dismiss", async (c) => {
      const now = d.now();
      const id = parseQueueItemId(c.req.param("id"));
      if (!id) return c.json({ error: "invalid queue item id", field: "id" }, 400);
      if (id.day !== utcDay(now)) return c.json({ error: "only today's queue items can be dismissed", field: "id" }, 400);
      const store = d.store();
      if (!store) return c.json({ error: "unavailable", reason: NO_STORE }, 503);
      const at = now.toISOString();
      const row = await store.dismissQueue(id.day, id.coin, at);
      // Keeps MOVES in sync; a no-op (null) when the coin has no triage item today.
      await store.dismissTriage(triageId(id.day, id.coin), at);
      return c.json(QueueDismissResponseSchema.parse({ id: `${row.day}:${row.coin}`, dismissedAt: row.dismissedAt }));
    });
}

/** Decided opportunities read per poll (score order; filtered to today in code: the store has no since filter). */
const DECIDED_SCAN_LIMIT = 200;

export const defaultQueueDeps = (): QueueRouteDeps => ({
  now: () => new Date(),
  cap: triageBudget(),
  store: agentStore,
  movesUnavailable: () => null,
  opportunities: async (dayStart) => {
    const ctx = platformContext();
    if (!ctx) throw new Error("platform offline (no worker loop and no database)");
    const [ready, decided] = await Promise.all([
      ctx.store.listOpportunities({ statuses: ["ready"], limit: 200 }),
      ctx.store.listOpportunities({ statuses: ["approved", "rejected", "open", "closed", "failed"], limit: DECIDED_SCAN_LIMIT }),
    ]);
    return [...ready, ...decided.filter((o) => Date.parse(o.statusChangedAt) >= dayStart.getTime())];
  },
  radar: async () => {
    const r = await readRadar(RADAR_DIR);
    if (r.state === "unavailable") throw new Error(r.reason ?? "radar files unreadable");
    return r.calls;
  },
  scan: () => readTriageScan(agentStore(), latestTriageScan),
  agent: sharedAgentDeps,
});
