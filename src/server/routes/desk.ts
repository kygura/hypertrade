import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { deskProviderFactory, runDesk, type ProviderFactory } from "../desk/agents.js";
import { loadDeskConfig } from "../desk/config.js";
import { liveMarketData } from "../desk/data.js";
import { createNotifier } from "../desk/notify.js";
import { DeskError, DeskService } from "../desk/service.js";
import { PgStore } from "../desk/store.js";
import { handleTelegramUpdate, type TelegramUpdate } from "../desk/telegram.js";
import { SPECIALISTS } from "../desk/prompts.js";
import { tick } from "../desk/watch.js";
import { ExitProposalSchema } from "../desk/types.js";

// /desk — the agentic portfolio desk (SPEC.md "Desk"). Session-cookie
// protected by the global gate, except /desk/tick (x-cron-token, like
// /cron/*) and /desk/telegram (Telegram's secret-token header); both are
// listed in auth.ts.
//
// POST /desk/ask {question, history?, act?} → text/event-stream of DeskEvent
//   (event name = type): run_start, agent_start, text, reasoning, tool_call,
//   tool_result, proposal, alert, agent_done, citations, error, done
// POST /desk/review → same stream, an operator-requested review cycle (acts)
// GET  /desk/status · /desk/portfolio · /desk/runs · /desk/runs/:id
//      /desk/proposals?status · /desk/alerts
// POST /desk/proposals/:id/approve · /desk/proposals/:id/reject
// POST /desk/exit {coin, fraction, reason} · /desk/kill {on, reason}
// PUT  /desk/approval {approval} · POST /desk/paper/reset {confirm: true}
// POST /desk/tick {runCycle?, forceReview?} (x-cron-token)
// POST /desk/telegram (X-Telegram-Bot-Api-Secret-Token)

export const RUN_TIMEOUT_MS = 240_000;

const AskBody = z.object({
  question: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
    .max(20)
    .optional(),
  act: z.boolean().optional(),
});

export interface DeskRouteOptions {
  service?: () => DeskService;
  makeProvider?: ProviderFactory;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

let shared: DeskService | null = null;
export function defaultDeskService(): DeskService {
  shared ??= new DeskService({ config: loadDeskConfig(), store: new PgStore(), data: liveMarketData, notifier: createNotifier() });
  return shared;
}

function safeEqual(a: string, b: string): boolean {
  const d = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(d(a), d(b));
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function deskError(c: Context, err: unknown) {
  if (err instanceof DeskError) return c.json({ error: err.message }, err.status);
  console.error("[desk]", err);
  return c.json({ error: err instanceof Error ? err.message : "desk error" }, 500);
}

export function createDeskRoutes(o: DeskRouteOptions = {}) {
  const service = o.service ?? defaultDeskService;
  const env = o.env ?? process.env;
  const makeProvider = o.makeProvider ?? deskProviderFactory(env);
  const timeoutMs = o.timeoutMs ?? RUN_TIMEOUT_MS;

  const stream = (c: Context, kind: "ask" | "cycle", input: string, act: boolean, history?: Array<{ role: "user" | "assistant"; content: string }>) => {
    if (!makeProvider("pm")) return c.json({ error: "desk not configured: no model provider (set an analyst provider key)" }, 503);
    c.header("cache-control", "no-store");
    c.header("x-accel-buffering", "no");
    return streamSSE(c, async (s) => {
      const disconnect = new AbortController();
      s.onAbort(() => disconnect.abort());
      // A run the operator walks away from still finishes and is recorded;
      // only the stream stops.
      try {
        await runDesk({ service: service(), kind, input, act, history, makeProvider, timeoutMs, trigger: kind === "cycle" ? { by: "operator" } : undefined }, (e) => {
          if (disconnect.signal.aborted) return;
          const { type, ...data } = e;
          void s.writeSSE({ event: type, data: JSON.stringify(data) }).catch(() => undefined);
        });
      } catch (err) {
        await s.writeSSE({ event: "error", data: JSON.stringify({ agent: "desk", error: err instanceof Error ? err.message : String(err) }) });
      }
    });
  };

  return new Hono()
    .get("/status", async (c) => {
      const s = service();
      const pm = makeProvider("pm");
      const specialist = makeProvider("specialist");
      try {
        const [kill, approval] = await Promise.all([s.killSwitch(), s.approval()]);
        return c.json({
          configured: !!pm,
          model: pm ? { provider: pm.id, label: pm.label ?? pm.id, pm: pm.model, scouts: specialist?.model ?? pm.model, scoutProvider: specialist?.id ?? pm.id, webSearch: pm.webSearch } : null,
          venue: s.broker.venue,
          live: s.broker.live,
          venueAccount: s.config.hl?.account ?? null,
          venueNote: s.config.venueNote ?? null,
          approval,
          killSwitch: kill,
          limits: s.config.limits,
          watchlist: s.config.watchlist,
          watchAddress: s.config.watchAddress ?? null,
          cyclesConnected: !!s.config.cyclesUrl,
          channels: s.notifier.channels,
          specialists: SPECIALISTS.map((x) => ({ id: x.id, role: x.role, brief: x.brief, webSearch: x.webSearch })),
          schedule: { reviewEveryHours: s.config.reviewEveryHours, maxCyclesPerDay: s.config.maxCyclesPerDay, cycleCooldownMin: s.config.cycleCooldownMin },
        });
      } catch (err) {
        return deskError(c, err);
      }
    })
    .get("/portfolio", async (c) => {
      const s = service();
      try {
        const [desk, watched, fills] = await Promise.all([s.account(), s.watchedAccount(), s.store.listFills(30)]);
        return c.json({ desk, watched, fills, startingEquity: s.config.paperStartingEquity });
      } catch (err) {
        return deskError(c, err);
      }
    })
    .post("/ask", async (c) => {
      const parsed = AskBody.safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid request", field: parsed.error.issues[0]?.path.join(".") }, 400);
      return stream(c, "ask", parsed.data.question, parsed.data.act ?? false, parsed.data.history);
    })
    .post("/review", async (c) => stream(c, "cycle", "operator-requested review", true))
    .get("/runs", async (c) => {
      const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
      try {
        return c.json({ runs: await service().store.listRuns(limit) });
      } catch (err) {
        return deskError(c, err);
      }
    })
    .get("/runs/:id", async (c) => {
      const id = c.req.param("id");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "invalid id" }, 400);
      try {
        const run = await service().store.getRun(id);
        return run ? c.json(run) : c.json({ error: "run not found" }, 404);
      } catch (err) {
        return deskError(c, err);
      }
    })
    .get("/proposals", async (c) => {
      const status = c.req.query("status");
      const valid = ["pending", "rejected", "blocked", "executed", "failed", "expired"] as const;
      const st = valid.find((v) => v === status);
      if (status && !st) return c.json({ error: "invalid status" }, 400);
      const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 30) || 30));
      try {
        await service().expirePending();
        return c.json({ proposals: await service().store.listProposals({ status: st, limit }) });
      } catch (err) {
        return deskError(c, err);
      }
    })
    .post("/proposals/:id/approve", async (c) => {
      try {
        return c.json(await service().approve(c.req.param("id"), "operator"));
      } catch (err) {
        return deskError(c, err);
      }
    })
    .post("/proposals/:id/reject", async (c) => {
      try {
        return c.json(await service().reject(c.req.param("id"), "operator"));
      } catch (err) {
        return deskError(c, err);
      }
    })
    .post("/exit", async (c) => {
      const parsed = ExitProposalSchema.safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid exit", field: parsed.error.issues[0]?.path.join(".") }, 400);
      try {
        return c.json(await service().submitExit(parsed.data, null));
      } catch (err) {
        return deskError(c, err);
      }
    })
    .post("/kill", async (c) => {
      const parsed = z.object({ on: z.boolean(), reason: z.string().max(300).optional() }).safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid request" }, 400);
      try {
        await service().setKillSwitch(parsed.data.on, parsed.data.reason || "from the Desk page", "operator");
        return c.json(await service().killSwitch());
      } catch (err) {
        return deskError(c, err);
      }
    })
    .put("/approval", async (c) => {
      const parsed = z.object({ approval: z.enum(["manual", "auto"]) }).safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "approval must be manual or auto" }, 400);
      try {
        await service().setApproval(parsed.data.approval, "operator");
        return c.json({ approval: await service().approval() });
      } catch (err) {
        return deskError(c, err);
      }
    })
    .post("/paper/reset", async (c) => {
      const parsed = z.object({ confirm: z.literal(true) }).safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "send {confirm: true} to reset the paper book" }, 400);
      try {
        const b = service().broker;
        if (!b.reset) return c.json({ error: `the ${b.venue} venue has no paper book to reset` }, 409);
        await b.reset();
        return c.json({ ok: true });
      } catch (err) {
        return deskError(c, err);
      }
    })
    .get("/alerts", async (c) => {
      const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
      try {
        return c.json({ alerts: await service().store.listAlerts(limit) });
      } catch (err) {
        return deskError(c, err);
      }
    })
    .post("/tick", async (c) => {
      const parsed = z.object({ runCycle: z.boolean().optional(), forceReview: z.boolean().optional() }).safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid request" }, 400);
      try {
        const res = await tick(service(), { ...parsed.data, makeProvider, cycleTimeoutMs: timeoutMs });
        return c.json(res);
      } catch (err) {
        return deskError(c, err);
      }
    })
    .post("/telegram", async (c) => {
      const secret = env.DESK_TELEGRAM_WEBHOOK_SECRET?.trim();
      const token = env.DESK_TELEGRAM_BOT_TOKEN?.trim();
      const chatId = env.DESK_TELEGRAM_CHAT_ID?.trim();
      if (!secret || !token || !chatId) return c.json({ error: "telegram not configured" }, 503);
      const got = c.req.header("x-telegram-bot-api-secret-token") ?? "";
      if (!safeEqual(got, secret)) return c.json({ error: "unauthorized" }, 401);
      const update = (await body(c)) as TelegramUpdate;
      try {
        await handleTelegramUpdate(service(), update, { token, chatId });
      } catch (err) {
        console.error("[desk] telegram update failed", err);
      }
      // Always 200 so Telegram does not redeliver a handled (or unhandleable) update.
      return c.json({ ok: true });
    });
}

export const deskRoutes = createDeskRoutes();
