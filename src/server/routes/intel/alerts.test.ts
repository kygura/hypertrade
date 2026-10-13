import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { MemoryIntelStore, type NewAlert, type NewEvent } from "../../intel/store.js";
import { createAlertsRoutes } from "./alerts.js";

const now = new Date("2026-10-13T12:00:00Z");
const H = 3_600_000;
const at = (h: number) => new Date(now.getTime() + h * H).toISOString();

function setup() {
  const store = new MemoryIntelStore(() => now);
  const app = new Hono().route("/intel", createAlertsRoutes({ store, targets: async () => ["SOL", "BTC"], now: () => now }));
  return { store, app };
}

const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const alert = (o: Partial<NewAlert> = {}): NewAlert => ({
  kind: "mapper",
  ref: "c1",
  window: null,
  asset: "SOL",
  title: "Jito exploit",
  eventType: "exploit",
  line: { tag: "hypothesis", text: "Long SOL. Exposed via jitoSOL → SOL (collateral)." },
  path: [{ from: "jitoSOL", to: "SOL", type: "collateral" }],
  edgeType: "collateral",
  hops: 1,
  pathWeight: 0.8,
  sources: [],
  materiality: 0.8,
  pricedIn: null,
  route: "push",
  ...o,
});

const event = (o: Partial<NewEvent> = {}): NewEvent => ({
  key: "calendar:cpi",
  type: "macro",
  title: "US CPI release",
  summary: null,
  entities: ["USD", "DXY"],
  assets: ["BTC"],
  magnitude: "high",
  sources: [{ label: "BLS", url: "https://www.bls.gov/schedule/news_release/cpi.htm" }],
  origin: "calendar",
  firstSeen: at(-24),
  scheduledAt: at(5),
  catalyst: null,
  tag: "observed",
  ...o,
});

describe("/intel alerts routes", () => {
  test("GET /alerts filters by kind and since; validates both", async () => {
    const { store, app } = setup();
    await store.insertAlert(alert());
    await store.insertAlert(alert({ kind: "catalyst", ref: "e1", window: "24h" }));
    const all = await (await app.request("/intel/alerts")).json();
    expect(all.alerts.map((a: { kind: string }) => a.kind)).toEqual(["catalyst", "mapper"]);
    const mapper = await (await app.request("/intel/alerts?kind=mapper")).json();
    expect(mapper.alerts).toHaveLength(1);
    expect((await (await app.request(`/intel/alerts?since=${encodeURIComponent(at(1))}`)).json()).alerts).toEqual([]);

    const badKind = await app.request("/intel/alerts?kind=nope");
    expect(badKind.status).toBe(400);
    expect((await badKind.json()).field).toBe("kind");
    const badSince = await app.request("/intel/alerts?since=yesterday");
    expect(badSince.status).toBe(400);
    expect((await badSince.json()).field).toBe("since");
  });

  test("POST /alerts/:id/feedback records a vote", async () => {
    const { store, app } = setup();
    const a = (await store.insertAlert(alert()))!;
    const ok = await app.request(`/intel/alerts/${a.id}/feedback`, send("POST", { vote: -1 }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).alert).toMatchObject({ id: a.id, feedback: -1 });
    expect((await store.feedbackStats())[0]).toMatchObject({ eventType: "exploit", edgeType: "collateral", hops: 1, down: 1 });

    for (const body of [{ vote: 2 }, { vote: "1" }, {}, { vote: 1, extra: true }]) {
      const res = await app.request(`/intel/alerts/${a.id}/feedback`, send("POST", body));
      expect(res.status).toBe(400);
    }
    expect((await (await app.request(`/intel/alerts/${a.id}/feedback`, send("POST", { vote: 2 }))).json()).field).toBe("vote");
    const badId = await app.request("/intel/alerts/not-a-uuid/feedback", send("POST", { vote: 1 }));
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({ error: "invalid id", field: "id" });
    expect((await app.request("/intel/alerts/00000000-0000-4000-8000-000000009999/feedback", send("POST", { vote: 1 }))).status).toBe(404);
  });

  test("GET /events filters by type and since", async () => {
    const { store, app } = setup();
    await store.upsertEvents([event(), event({ key: "rss:1", type: "exploit", title: "Jito drained", origin: "rss", scheduledAt: null, firstSeen: at(-1) })]);
    expect((await (await app.request("/intel/events")).json()).events).toHaveLength(2);
    const ex = await (await app.request("/intel/events?type=exploit")).json();
    expect(ex.events.map((e: { title: string }) => e.title)).toEqual(["Jito drained"]);
    expect((await (await app.request(`/intel/events?since=${encodeURIComponent(at(-2))}`)).json()).events).toHaveLength(1);
    const bad = await app.request("/intel/events?type=rumour");
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe("type");
  });

  test("GET /catalysts: default 14 days, 1–60, exposed = held/watched assets", async () => {
    const { store, app } = setup();
    await store.upsertEvents([
      event(),
      event({ key: "far", title: "Far", scheduledAt: at(20 * 24), assets: ["SOL"] }),
      event({ key: "past", title: "Long past", scheduledAt: at(-3) }),
    ]);
    const res = await app.request("/intel/catalysts");
    expect(res.status).toBe(200);
    const { catalysts } = await res.json();
    expect(catalysts).toHaveLength(1);
    expect(catalysts[0]).toMatchObject({ title: "US CPI release", exposed: ["BTC"], scheduledAt: at(5), origin: "calendar" });
    expect((await (await app.request("/intel/catalysts?days=30")).json()).catalysts.map((c: { title: string }) => c.title)).toEqual(["US CPI release", "Far"]);
    for (const q of ["0", "61", "abc", "1.5"]) {
      const bad = await app.request(`/intel/catalysts?days=${q}`);
      expect(bad.status).toBe(400);
      expect((await bad.json()).field).toBe("days");
    }
  });

  test("POST /catalysts stores a manual catalyst; validates input and refuses past dates", async () => {
    const { store, app } = setup();
    const ok = await app.request("/intel/catalysts", send("POST", { title: "SOL unlock", assets: ["SOL"], scheduledAt: at(48), type: "unlock", url: "https://example.com/unlock" }));
    expect(ok.status).toBe(201);
    const { catalyst } = await ok.json();
    expect(catalyst).toMatchObject({ title: "SOL unlock", origin: "manual", exposed: ["SOL"], tag: "observed", sources: [{ label: "example.com", url: "https://example.com/unlock" }] });
    expect((await store.getEvent(catalyst.eventId))!.origin).toBe("manual");

    const past = await app.request("/intel/catalysts", send("POST", { title: "Old", assets: ["SOL"], scheduledAt: at(-1) }));
    expect(past.status).toBe(400);
    expect(await past.json()).toEqual({ error: "scheduledAt must be in the future", field: "scheduledAt" });
    const cases: Array<[unknown, string]> = [
      [{ assets: ["SOL"], scheduledAt: at(2) }, "title"],
      [{ title: "x", assets: [], scheduledAt: at(2) }, "assets"],
      [{ title: "x", assets: ["<b>"], scheduledAt: at(2) }, "assets.0"],
      [{ title: "x", assets: ["SOL"], scheduledAt: "tomorrow" }, "scheduledAt"],
      [{ title: "x", assets: ["SOL"], scheduledAt: at(2), url: "http://10.0.0.1/x" }, "url"],
      [{ title: "x", assets: ["SOL"], scheduledAt: at(2), origin: "calendar" }, ""],
    ];
    for (const [body, field] of cases) {
      const res = await app.request("/intel/catalysts", send("POST", body));
      expect(res.status).toBe(400);
      expect((await res.json()).field ?? "").toBe(field);
    }
  });

  test("DELETE /catalysts/:id: manual only", async () => {
    const { store, app } = setup();
    const [cal] = await store.upsertEvents([event()]);
    const created = await (await app.request("/intel/catalysts", send("POST", { title: "SOL unlock", assets: ["SOL"], scheduledAt: at(48) }))).json();
    const refused = await app.request(`/intel/catalysts/${cal!.id}`, { method: "DELETE" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "only manual catalysts can be deleted", field: "id" });
    const ok = await app.request(`/intel/catalysts/${created.catalyst.eventId}`, { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: true });
    expect((await app.request(`/intel/catalysts/${created.catalyst.eventId}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/intel/catalysts/xyz", { method: "DELETE" })).status).toBe(400);
  });

  test("GET /feedback/report/latest", async () => {
    const { store, app } = setup();
    expect(await (await app.request("/intel/feedback/report/latest")).json()).toEqual({ report: null });
    await store.insertReport({ kind: "feedback_weekly", buckets: [] });
    const { report } = await (await app.request("/intel/feedback/report/latest")).json();
    expect(report).toMatchObject({ kind: "feedback_weekly", buckets: [] });
  });

  test("store failures are 500s with an error body", async () => {
    const { store, app } = setup();
    store.listAlerts = async () => Promise.reject(new Error("db down"));
    const orig = console.error;
    console.error = () => {};
    try {
      const res = await app.request("/intel/alerts");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "db down" });
    } finally {
      console.error = orig;
    }
  });
});
