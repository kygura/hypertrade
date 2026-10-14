import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { OrderIntent } from "../../../shared/intel.js";
import type { AssetCtx } from "../../../shared/types.js";
import { ApiError } from "../../../ui/lib/api.js";
import { intel } from "../../../ui/lib/intel.js";
import { makeService, ScriptedProvider } from "../../desk/testkit.js";
import { ensureSeedEdges } from "../../intel/graph.js";
import type { LlmDeps } from "../../intel/llm.js";
import { loadExposure, watchedAssets } from "../../intel/positions.js";
import type { ReadClient } from "../../intel/screener.js";
import { MemoryIntelStore } from "../../intel/store.js";
import { createIntelRoutes, type IntelDeps } from "./index.js";

// Contract test: the real UI client (src/ui/lib/intel.ts) against
// createIntelRoutes with in-memory deps. Every client call must reach a route
// (a handler's own 404 is fine, Hono's "no route" is not), and every 2xx must
// parse with the shared schema the client uses.

const NOW = new Date("2026-10-13T12:00:00Z");
const env = { DESK_WATCHLIST: "BTC,ETH" };
const intent: OrderIntent = { asset: "ETH", side: "long", leverage: 3, size: { usd: 800 }, entry: { type: "market" }, stop: { type: "pct", pct: 5 } };
const thesisEmit = {
  assets: ["SOL"],
  claims: [{ kind: "claim", text: "Funding stays positive", check: { kind: "funding_sign", asset: "SOL", sign: "positive" } }],
  invalidation: [{ text: "SOL below $100", check: { kind: "price_vs_level", asset: "SOL", op: "<", level: 100 } }],
  wrongIf: [{ tag: "hypothesis", text: "Spot demand fades." }],
};

const sol: AssetCtx = { name: "SOL", szDecimals: 2, markPx: 160, oraclePx: 160, midPx: 160, dayNtlVlm: 1e6, prevDayPx: 150, openInterest: 10, funding: 1e-5, premium: 0, dayChange: 0, isDelisted: false };

function setup() {
  const store = new MemoryIntelStore(() => NOW);
  const llm: LlmDeps = { makeProvider: () => null, cache: store, now: () => NOW, dailyCap: 200 };
  const kit = makeService();
  const thesisProvider = new ScriptedProvider("strong-model", () => [{ calls: [{ name: "emit", input: thesisEmit }] }]);
  const failing: ReadClient = { begin: async () => Promise.reject(new Error("no database in tests")) };
  const deps: IntelDeps = {
    store,
    env,
    exposure: (marks) => loadExposure({ store, marks: async () => marks ?? { SOL: 160 } }),
    watched: () => watchedAssets(store, env),
    ctxs: async () => [sol],
    candles1h: async () => [],
    observations: async () => [],
    funding: async () => [],
    ingestHealth: async () => [],
    llm,
    thresholds: { minZ: 2, topK: 5, pushMateriality: 0.35 },
    now: () => NOW,
    journal: () => ({ store, llm, now: () => NOW, deskFills: async () => [] }),
    thesis: { store, llm: { ...llm, makeProvider: () => thesisProvider }, now: () => NOW, ctxs: async () => [sol] },
    copilot: () => ({ llm, desk: kit.service }),
    docwatch: { store, llm, now: () => NOW, env: {}, fetch: async () => new Response("<p>v1</p>", { headers: { "content-type": "text/html" } }), lookup: async () => [{ address: "93.184.216.34", family: 4 }], routeAlert: async () => ({ alertedAssets: [] }) },
    queryClient: () => failing,
  };
  const app = new Hono().basePath("/api").route("/intel", createIntelRoutes(deps));
  app.notFound((c) => c.json({ route: "missing" }, 404));
  return { app, store, kit };
}

let h: ReturnType<typeof setup>;
const realFetch = globalThis.fetch;
const seen: Array<{ method: string; path: string; status: number; routed: boolean }> = [];

beforeAll(async () => {
  h = setup();
  await ensureSeedEdges(h.store);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const res = await h.app.request(path, init);
    const body = await res.clone().json().catch(() => null);
    seen.push({ method: init?.method ?? "GET", path, status: res.status, routed: !(res.status === 404 && body?.route === "missing") });
    return res;
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Runs a client call; returns its value, or the HTTP status of a server error. */
async function call<T>(f: () => Promise<T>): Promise<T | { status: number }> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status };
    throw err; // a schema mismatch or anything else fails the test
  }
}

describe("createIntelRoutes ↔ ui/lib/intel.ts", () => {
  test("every client endpoint resolves to a route and every 2xx parses with the client's schema", async () => {
    const pos = (await call(() => intel.addPosition({ asset: "SOL", side: "long", size: 2, entryPx: 150, stopPx: 140 }))) as { id: string };
    expect(pos.id).toBeString();
    expect(await call(() => intel.updatePosition(pos.id, { asset: "SOL", side: "long", size: 3, entryPx: 150 }))).toMatchObject({ size: 3 });
    expect((await call(() => intel.positions())) as { totalNotionalUsd: number }).toMatchObject({ totalNotionalUsd: 480 });
    expect(await call(() => intel.watchlist())).toMatchObject({ fallback: true });
    expect(await call(() => intel.putWatchlist([{ asset: "SOL", tags: ["core"] }]))).toEqual({ items: [{ asset: "SOL", tags: ["core"] }], fallback: false });

    expect(await call(() => intel.brief("deeplink"))).toMatchObject({ surface: "ui", silent: true });
    expect(await call(() => intel.latestBrief())).toMatchObject({ surface: "ui" });
    expect(await call(() => intel.reviews(5))).toMatchObject([{ via: "deeplink" }]);

    expect(await call(() => intel.alerts({ since: NOW.toISOString(), kind: "mapper" }))).toEqual([]);
    expect(await call(() => intel.alertFeedback("00000000-0000-4000-8000-000000000999", 1))).toEqual({ status: 404 });
    expect(await call(() => intel.events({ type: "macro" }))).toEqual([]);
    await call(() => intel.addCatalyst({ title: "SOL upgrade", assets: ["SOL"], scheduledAt: "2026-10-20T12:00:00.000Z" }));
    const cats = (await call(() => intel.catalysts(14))) as Array<{ eventId: string; exposed: string[] }>;
    expect(cats).toMatchObject([{ exposed: ["SOL"] }]);
    await call(() => intel.deleteCatalyst(cats[0]!.eventId));
    expect(await call(() => intel.feedbackReport())).toBeNull();
    await h.store.insertReport({ kind: "feedback_weekly", buckets: [{ eventType: "hack", edgeType: "collateral", hops: 1, up: 0, down: 3, total: 3, suggestion: "lower the collateral edge weight" }] });
    expect(await call(() => intel.feedbackReport())).toMatchObject({ kind: "feedback_weekly", buckets: [{ eventType: "hack", hops: 1 }] });

    expect(await call(() => intel.graph("SOL"))).toMatchObject({ asset: "SOL" });
    expect(await call(() => intel.addEdge({ src: "PURR", dst: "SOL", type: "narrative", source: "https://example.com/purr" }))).toMatchObject({ origin: "user", src: "PURR" });
    await call(() => intel.deleteEdge({ src: "PURR", dst: "SOL", type: "narrative" }));

    expect(await call(() => intel.journal(30))).toMatchObject({ trades: [], stats: [] });
    expect(await call(() => intel.saveNote("desk:ETH:1", "late entry"))).toMatchObject({ tradeId: "desk:ETH:1", note: "late entry" });
    expect(await call(() => intel.tagUntagged(7))).toEqual({ status: 503 }); // no provider
    expect(await call(() => intel.latestReport())).toBeNull();
    expect(await call(() => intel.generateReport())).toMatchObject({ kind: "journal_weekly" });
    expect(await call(() => intel.latestReport())).toMatchObject({ kind: "journal_weekly" });

    const thesis = (await call(() => intel.createThesis("SOL holds up because funding stays positive"))) as { id: string };
    expect(thesis.id).toBeString();
    expect(await call(() => intel.theses())).toHaveLength(1);
    expect(await call(() => intel.checkThesis(thesis.id))).toMatchObject({ id: thesis.id });
    await call(() => intel.deleteThesis(thesis.id));

    expect(await call(() => intel.parseQuery("funding flips"))).toEqual({ status: 503 }); // no provider
    expect(await call(() => intel.runQuery({ source: "snapshots", select: ["asset"], since_h: 24 }))).toEqual({ status: 500 }); // fake client refuses

    const watch = (await call(() => intel.addWatch({ kind: "url", target: "https://docs.example.com/fees", label: "Fees", asset: "SOL" }))) as { id: string };
    expect(watch.id).toBeString();
    await call(() => intel.checkWatch(watch.id));
    expect(await call(() => intel.watches())).toMatchObject([{ id: watch.id, lastHash: expect.any(String) }]);
    expect(await call(() => intel.watchChanges(watch.id))).toEqual([]);
    await call(() => intel.deleteWatch(watch.id));

    await call(() => intel.deletePosition(pos.id));
    expect(await call(() => intel.positions())).toMatchObject({ positions: [] });

    expect(seen.filter((s) => !s.routed)).toEqual([]);
    const hit = new Set(seen.map((s) => `${s.method} ${s.path.replace(/\?.*$/, "").replace(/[0-9a-f-]{36}/g, ":id")}`));
    for (const ep of [
      "POST /api/intel/positions", "PUT /api/intel/positions/:id", "DELETE /api/intel/positions/:id", "GET /api/intel/positions",
      "GET /api/intel/watchlist", "PUT /api/intel/watchlist", "POST /api/intel/brief", "GET /api/intel/brief/latest", "GET /api/intel/reviews",
      "GET /api/intel/alerts", "POST /api/intel/alerts/:id/feedback", "GET /api/intel/events", "GET /api/intel/catalysts", "POST /api/intel/catalysts", "DELETE /api/intel/catalysts/:id", "GET /api/intel/feedback/report/latest",
      "GET /api/intel/graph", "POST /api/intel/graph/edges", "DELETE /api/intel/graph/edges",
      "GET /api/intel/journal", "PUT /api/intel/journal/desk%3AETH%3A1/note", "POST /api/intel/journal/tag", "GET /api/intel/journal/report/latest", "POST /api/intel/journal/report",
      "GET /api/intel/theses", "POST /api/intel/theses", "POST /api/intel/theses/:id/check", "DELETE /api/intel/theses/:id",
      "POST /api/intel/query/parse", "POST /api/intel/query/run",
      "GET /api/intel/watches", "POST /api/intel/watches", "DELETE /api/intel/watches/:id", "GET /api/intel/watches/:id/changes", "POST /api/intel/watches/:id/check",
    ]) {
      expect(hit.has(ep)).toBe(true);
    }
  });

  test("order: preview never executes; confirm is reachable only as POST with the preview's hash", async () => {
    const fills = () => h.kit.store.listFills(10);
    const preview = (await call(() => intel.previewOrder({ intent }))) as { previewHash: string; venue: string };
    expect(preview.venue).toBe("paper");
    expect(await fills()).toHaveLength(0);

    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const res = await h.app.request("/api/intel/order/confirm", { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify({ intent, previewHash: preview.previewHash }) });
      expect(res.status).toBe(404);
    }
    expect(await call(() => intel.confirmOrder(intent, ""))).toEqual({ status: 400 });
    const noHash = await h.app.request("/api/intel/order/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent }) });
    expect(noHash.status).toBe(400);
    expect(await call(() => intel.confirmOrder(intent, "f".repeat(64)))).toEqual({ status: 409 });
    expect(await fills()).toHaveLength(0);

    expect(await call(() => intel.confirmOrder(intent, preview.previewHash))).toMatchObject({ status: "executed" });
    expect(await fills()).toHaveLength(1);
    expect(await call(() => intel.previewOrder({ text: "long eth 3x 800" }))).toEqual({ status: 503 }); // no provider: nothing parsed, nothing sent
  });
});
