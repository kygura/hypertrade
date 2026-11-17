import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requireAuth } from "../auth.js";
import { makeService, ScriptedProvider } from "../desk/testkit.js";
import { createDeskRoutes } from "./desk.js";
import { DeskCooldownResponseSchema, DeskPlanListResponseSchema, DeskPlanSubmitResponseSchema, PlanCheckSchema } from "../../shared/deskPlan.js";

function app(opts: { provider?: ScriptedProvider | null; env?: Record<string, string> } = {}) {
  const kit = makeService();
  const provider = opts.provider === undefined ? new ScriptedProvider("claude-opus-5-5", () => [{ text: "**Verdict:** mixed, low confidence." }]) : opts.provider;
  const routes = createDeskRoutes({ service: () => kit.service, makeProvider: () => provider, env: opts.env ?? {} });
  return { ...kit, app: new Hono().route("/desk", routes) };
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const trade = {
  coin: "ETH",
  side: "long",
  setup: "manual test",
  thesis: "Operator-entered trade for the route test, long enough.",
  horizon: "swing",
  confidence: "medium",
  stop: 3800,
  target: 4500,
  riskPct: 0.5,
  invalidation: "close under 3850",
  evidence: [
    { source: "a", point: "one" },
    { source: "b", point: "two" },
  ],
};

describe("/desk routes", () => {
  test("status reports model, venue, approval and the roster", async () => {
    const { app: a } = app();
    const res = await a.request("/desk/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ configured: true, venue: "paper", approval: "auto", killSwitch: { on: false }, live: false, venueAccount: null, venueNote: null });
    expect(body.specialists.map((s: { id: string }) => s.id)).toContain("macro");
  });

  test("ask streams the run as SSE and records it", async () => {
    const { app: a, store } = app();
    const res = await a.request("/desk/ask", json({ question: "Is the current rally a bull trap?" }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: run_start");
    expect(text).toContain("event: agent_start");
    expect(text).toContain("**Verdict:**");
    expect(text).toContain("event: done");
    const runs = await store.listRuns(5);
    expect(runs[0]).toMatchObject({ kind: "ask", status: "done" });
  });

  test("ask without a model is 503; a bad body is 400", async () => {
    expect((await app({ provider: null }).app.request("/desk/ask", json({ question: "q" }))).status).toBe(503);
    expect((await app().app.request("/desk/ask", json({ question: "" }))).status).toBe(400);
  });

  test("manual approval round trip over HTTP", async () => {
    const kit = app();
    await kit.app.request("/desk/approval", { ...json({ approval: "manual" }), method: "PUT" });
    const rec = await kit.service.submitOpen(trade as never, null);
    expect(rec.status).toBe("pending");
    const list = await (await kit.app.request("/desk/proposals?status=pending")).json();
    expect(list.proposals).toHaveLength(1);
    const ok = await kit.app.request(`/desk/proposals/${rec.id}/approve`, { method: "POST" });
    expect((await ok.json()).status).toBe("executed");
    const again = await kit.app.request(`/desk/proposals/${rec.id}/approve`, { method: "POST" });
    expect(again.status).toBe(409);
    const port = await (await kit.app.request("/desk/portfolio")).json();
    expect(port.desk.positions[0].coin).toBe("ETH");
    const exit = await kit.app.request("/desk/exit", json({ coin: "ETH", fraction: 1, reason: "operator flatten" }));
    expect((await exit.json()).status).toBe("executed");
  });

  test("review interval settings: round trip, validation, and status reflects the source", async () => {
    const kit = app({ env: { DESK_REVIEW_HOURS: "8" } });
    const status1 = await (await kit.app.request("/desk/status")).json();
    expect(status1.schedule).toMatchObject({ reviewEveryHours: 8, reviewEveryHoursSource: "env" });

    for (const bad of [-1, 169, 2.5]) {
      const res = await kit.app.request("/desk/settings", { ...json({ reviewEveryHours: bad }), method: "PUT" });
      expect(res.status).toBe(400);
    }

    const ok = await kit.app.request("/desk/settings", { ...json({ reviewEveryHours: 24 }), method: "PUT" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ hours: 24, source: "ui" });
    const status2 = await (await kit.app.request("/desk/status")).json();
    expect(status2.schedule).toMatchObject({ reviewEveryHours: 24, reviewEveryHoursSource: "ui" });
  });

  test("kill switch and paper reset", async () => {
    const kit = app();
    expect((await (await kit.app.request("/desk/kill", json({ on: true, reason: "test" }))).json()).on).toBe(true);
    expect((await kit.app.request("/desk/paper/reset", json({}))).status).toBe(400);
    expect((await kit.app.request("/desk/paper/reset", json({ confirm: true }))).status).toBe(200);
  });

  test("telegram webhook requires the secret header", async () => {
    const env = { DESK_TELEGRAM_WEBHOOK_SECRET: "s3cret", DESK_TELEGRAM_BOT_TOKEN: "t", DESK_TELEGRAM_CHAT_ID: "42" };
    const { app: a } = app({ env });
    expect((await a.request("/desk/telegram", json({ update_id: 1 }))).status).toBe(401);
    const res = await a.request("/desk/telegram", { ...json({ update_id: 1 }), headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "s3cret" } });
    expect(res.status).toBe(200);
    expect((await app().app.request("/desk/telegram", json({}))).status).toBe(503);
  });
});

describe("auth gate", () => {
  test("/desk/tick takes the cron token, /desk/telegram passes to the route, the rest need a session", async () => {
    const prev = { CRON_TOKEN: process.env.CRON_TOKEN, CRON_SECRET: process.env.CRON_SECRET };
    process.env.CRON_TOKEN = "cron-token";
    try {
      const a = new Hono().basePath("/api");
      a.use("*", requireAuth);
      a.post("/desk/tick", (c) => c.json({ ok: true }));
      a.post("/desk/telegram", (c) => c.json({ ok: true }));
      a.get("/desk/status", (c) => c.json({ ok: true }));
      a.put("/desk/settings", (c) => c.json({ ok: true }));
      expect((await a.request("/api/desk/tick", { method: "POST" })).status).toBe(401);
      expect((await a.request("/api/desk/tick", { method: "POST", headers: { "x-cron-token": "cron-token" } })).status).toBe(200);
      expect((await a.request("/api/desk/telegram", { method: "POST" })).status).toBe(200);
      expect((await a.request("/api/desk/status")).status).toBe(401);
      expect((await a.request("/api/desk/settings", { method: "PUT" })).status).toBe(401);
    } finally {
      process.env.CRON_TOKEN = prev.CRON_TOKEN;
      process.env.CRON_SECRET = prev.CRON_SECRET;
    }
  });
});

describe("/desk plans and cooldown", () => {
  const plan = { coin: "ETH", side: "long", rungs: [{ px: 4000, size: 0.1 }], stopPx: 3800, targetPx: 4500 };

  test("check answers a PlanCheck and saves nothing; a bad body is 400", async () => {
    const { app: a, store } = app();
    const res = await a.request("/desk/plans/check", json({ plan }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(PlanCheckSchema.parse(body)).toMatchObject({ blockers: [], metrics: { lossAtStopUsd: 20, rrFull: 2.5 } });
    expect(await store.listPlans(5)).toEqual([]);
    expect((await a.request("/desk/plans/check", json({ plan: { ...plan, rungs: [] } }))).status).toBe(400);
    expect((await a.request("/desk/plans/check", json({ plan: { ...plan, extra: 1 } }))).status).toBe(400);
  });

  test("a plan with no stop can be checked (and is blocked)", async () => {
    const res = await app().app.request("/desk/plans/check", json({ plan: { ...plan, stopPx: null } }));
    expect((await res.json()).blockers).toContain("no stop: every plan needs one");
  });

  test("submit journals and places; list is newest first; place needs to be explicit", async () => {
    const { app: a, store } = app();
    expect((await a.request("/desk/plans", json({ plan }))).status).toBe(400);
    const saved = DeskPlanSubmitResponseSchema.parse(await (await a.request("/desk/plans", json({ plan, place: false }))).json());
    expect(saved).toMatchObject({ placed: false, record: { placed: false } });
    const placed = DeskPlanSubmitResponseSchema.parse(await (await a.request("/desk/plans", json({ plan, place: true }))).json());
    expect(placed).toMatchObject({ placed: true, record: { placed: true, placement: { status: "executed" } } });
    expect((await store.listProposals({ limit: 5 }))[0]).toMatchObject({ decidedBy: "operator:plan", status: "executed" });
    const list = DeskPlanListResponseSchema.parse(await (await a.request("/desk/plans?limit=10")).json());
    expect(list.plans.map((p) => p.id)).toEqual([placed.record.id, saved.record.id]);
  });

  test("cooldown lists each lock with its journal entry", async () => {
    const { app: a, service } = app();
    expect(DeskCooldownResponseSchema.parse(await (await a.request("/desk/cooldown")).json())).toEqual({ coins: [], all: null, stopOutsToday: 0 });
    await service.recordStopOut("ETH", new Date("2026-10-05T11:30:00Z"), { source: "paper", proposalId: null, fill: { side: "long", size: 0.1, px: 3800, pnl: -20 } });
    const body = DeskCooldownResponseSchema.parse(await (await a.request("/desk/cooldown")).json());
    expect(body).toMatchObject({ all: null, stopOutsToday: 1, coins: [{ coin: "ETH", until: "2026-10-05T15:30:00.000Z", stopOutAt: "2026-10-05T11:30:00.000Z", plan: null, ref: { fill: { pnl: -20 } } }] });
    const check = await (await a.request("/desk/plans/check", json({ plan }))).json();
    expect(check.blockers.join()).toContain("cooldown: ETH stopped out");
  });
});
