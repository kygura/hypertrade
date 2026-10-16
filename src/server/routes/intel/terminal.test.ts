import { describe, expect, test } from "bun:test";
import type { AssetCtx } from "../../../shared/types.js";
import { loadExposure, watchedAssets } from "../../intel/positions.js";
import { MemoryIntelStore } from "../../intel/store.js";
import { createTerminalRoutes } from "./terminal.js";

const env = { DESK_WATCHLIST: "BTC,ETH" };

function app() {
  const store = new MemoryIntelStore();
  let llmCalls = 0;
  const ctxs: AssetCtx[] = [{ name: "SOL", szDecimals: 2, markPx: 160, oraclePx: 160, midPx: 160, dayNtlVlm: 1e6, prevDayPx: 150, openInterest: 10, funding: 1e-5, premium: 0, dayChange: 0, isDelisted: false }];
  const routes = createTerminalRoutes({
    store,
    env,
    exposure: (marks) => loadExposure({ store, marks: async () => marks ?? { SOL: 160 } }),
    watched: () => watchedAssets(store, env),
    ctxs: async () => ctxs,
    candles1h: async () => [],
    observations: async () => [],
    funding: async () => [],
    ingestHealth: async () => [],
    llm: { makeProvider: () => (llmCalls++, null), cache: store, now: () => new Date(), dailyCap: 200 },
    thresholds: { minZ: 2, topK: 5, pushMateriality: 0.35, digestMateriality: 0.1 },
    now: () => new Date(),
  });
  const call = (method: string, path: string, body?: unknown) =>
    routes.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { store, call, llmCalls: () => llmCalls };
}

const sol = { asset: "SOL", side: "long", size: 10, entryPx: 150, stopPx: 140, leverage: 3 };

describe("positions", () => {
  test("manual CRUD; GET unifies with marks", async () => {
    const { call } = app();
    const created = await call("POST", "/positions", sol);
    expect(created.status).toBe(201);
    const pos = (await created.json()) as { id: string; venue: string };
    expect(pos.venue).toBe("manual");

    const list = (await (await call("GET", "/positions")).json()) as { positions: Array<{ id: string; notionalUsd: number }>; totalNotionalUsd: number };
    expect(list.positions).toEqual([expect.objectContaining({ id: pos.id, notionalUsd: 1600 })]);
    expect(list.totalNotionalUsd).toBe(1600);

    const put = await call("PUT", `/positions/${pos.id}`, { ...sol, size: 5 });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { size: number }).size).toBe(5);

    expect((await call("DELETE", `/positions/${pos.id}`)).status).toBe(200);
    expect((await call("DELETE", `/positions/${pos.id}`)).status).toBe(404);
    expect((await call("PUT", `/positions/${pos.id}`, sol)).status).toBe(404);
  });

  test("validation: 400 with the field; hl/desk ids are read-only", async () => {
    const { call } = app();
    const bad = await call("POST", "/positions", { ...sol, size: -1 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "size" });
    expect((await call("POST", "/positions", { ...sol, extra: 1 })).status).toBe(400);
    expect((await call("POST", "/positions", { ...sol, asset: "BTC; drop" })).status).toBe(400);
    expect((await call("POST", "/positions", "{not json")).status).toBe(400);
    for (const id of ["hl:ETH", "desk:BTC"]) {
      const r = await call("PUT", `/positions/${id}`, sol);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ field: "id" });
      expect((await call("DELETE", `/positions/${id}`)).status).toBe(400);
    }
    expect((await call("DELETE", "/positions/not-an-id")).status).toBe(400);
  });
});

describe("watchlist", () => {
  test("falls back to DESK_WATCHLIST until set; duplicates refused", async () => {
    const { call } = app();
    expect(await (await call("GET", "/watchlist")).json()).toEqual({ items: [{ asset: "BTC", tags: [] }, { asset: "ETH", tags: [] }], fallback: true });
    const dup = await call("PUT", "/watchlist", { items: [{ asset: "SOL" }, { asset: "SOL" }] });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ field: "items" });
    const put = await call("PUT", "/watchlist", { items: [{ asset: "kPEPE", tags: ["meme"] }, { asset: "SOL" }] });
    expect(await put.json()).toEqual({ items: [{ asset: "kPEPE", tags: ["meme"] }, { asset: "SOL", tags: [] }], fallback: false });
    expect(((await (await call("GET", "/watchlist")).json()) as { fallback: boolean }).fallback).toBe(false);
  });
});

describe("brief and reviews", () => {
  test("POST /brief logs a review (via ui or deeplink); latest and reviews read back", async () => {
    const { call, llmCalls } = app();
    const res = await call("POST", "/brief");
    expect(res.status).toBe(200);
    const brief = (await res.json()) as { id: string; silent: boolean; surface: string };
    expect(brief).toMatchObject({ silent: true, surface: "ui" }); // no snapshots yet: nothing to diff
    expect(llmCalls()).toBe(0);
    expect((await call("POST", "/brief", { via: "deeplink" })).status).toBe(200);
    expect((await call("POST", "/brief", { via: "email" })).status).toBe(400);

    const latest = (await (await call("GET", "/brief/latest")).json()) as { brief: { id: string } | null };
    expect(latest.brief?.id).not.toBe(brief.id);
    expect(await (await call("GET", "/brief/latest?surface=cron")).json()).toEqual({ brief: null });
    expect((await call("GET", "/brief/latest?surface=bad")).status).toBe(400);

    const reviews = (await (await call("GET", "/reviews?limit=5")).json()) as { reviews: Array<{ via: string; briefId: string }> };
    expect(reviews.reviews.map((r) => r.via)).toEqual(["deeplink", "ui"]);
    expect(reviews.reviews[1]!.briefId).toBe(brief.id);
    expect(((await (await call("GET", "/reviews?limit=1")).json()) as { reviews: unknown[] }).reviews).toHaveLength(1);
    expect((await call("GET", "/reviews?limit=0")).status).toBe(400);
  });

  test("a store failure is a 500 with the message", async () => {
    const { store, call } = app();
    store.listReviews = async () => Promise.reject(new Error("db down"));
    const r = await call("GET", "/reviews");
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "db down" });
  });
});
