import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requireAuth } from "../auth.js";
import { makeService, ScriptedProvider } from "../desk/testkit.js";
import { createDeskRoutes } from "./desk.js";

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
    expect(body).toMatchObject({ configured: true, venue: "paper", approval: "auto", killSwitch: { on: false }, liveVenue: { available: false } });
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
      expect((await a.request("/api/desk/tick", { method: "POST" })).status).toBe(401);
      expect((await a.request("/api/desk/tick", { method: "POST", headers: { "x-cron-token": "cron-token" } })).status).toBe(200);
      expect((await a.request("/api/desk/telegram", { method: "POST" })).status).toBe(200);
      expect((await a.request("/api/desk/status")).status).toBe(401);
    } finally {
      process.env.CRON_TOKEN = prev.CRON_TOKEN;
      process.env.CRON_SECRET = prev.CRON_SECRET;
    }
  });
});
