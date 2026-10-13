import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { DocwatchDeps, FetchFn } from "../../intel/docwatch.js";
import { EmitProvider, llmDeps } from "../../intel/fixtures/emit-provider.js";
import { MemoryIntelStore } from "../../intel/store.js";
import { createWatchRoutes } from "./watch.js";

const NOW = new Date("2026-10-13T12:00:00Z");

function app(fetchFn: FetchFn) {
  const store = new MemoryIntelStore(() => NOW);
  const provider = new EmitProvider(() => ({ summary: [{ tag: "hypothesis", text: "Fee terms changed." }] }));
  const deps: DocwatchDeps = {
    store,
    llm: llmDeps(provider, store, () => NOW),
    now: () => NOW,
    fetch: fetchFn,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    env: {},
    routeAlert: async () => ({ alertedAssets: ["HYPE"] }),
  };
  return { store, app: new Hono().route("/api/intel", createWatchRoutes(deps)) };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/intel/watches", () => {
  test("create → check (baseline) → check (change) → changes → delete", async () => {
    let page = "<p>v1</p>";
    const { app: a } = app(async () => new Response(page, { headers: { "content-type": "text/html" } }));
    expect(await (await a.request("/api/intel/watches")).json()).toEqual({ watches: [] });

    const res = await a.request("/api/intel/watches", post({ kind: "url", target: "https://docs.example.com/fees", label: "Fees", asset: "HYPE" }));
    expect(res.status).toBe(201);
    const w = await res.json();
    expect(w).toMatchObject({ kind: "url", chain: null, asset: "HYPE", lastHash: null });
    expect((await (await a.request("/api/intel/watches")).json()).watches).toHaveLength(1);

    const c1 = await (await a.request(`/api/intel/watches/${w.id}/check`, { method: "POST" })).json();
    expect(c1.result.status).toBe("baseline");
    expect(c1.watch.lastHash).toMatch(/^[0-9a-f]{64}$/);

    page = "<p>v2</p>";
    const c2 = await (await a.request(`/api/intel/watches/${w.id}/check`, { method: "POST" })).json();
    expect(c2.result.status).toBe("changed");
    expect(c2.result.change.alertedAssets).toEqual(["HYPE"]);

    const changes = await (await a.request(`/api/intel/watches/${w.id}/changes`)).json();
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]).toMatchObject({ facts: ["+1 −1 lines"], diff: "- v1\n+ v2", lines: [{ tag: "hypothesis", text: "Fee terms changed." }] });

    expect((await a.request(`/api/intel/watches/${w.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await a.request(`/api/intel/watches/${w.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await a.request(`/api/intel/watches/${w.id}/changes`)).status).toBe(404);
    expect((await a.request(`/api/intel/watches/${w.id}/check`, { method: "POST" })).status).toBe(404);
  });

  test("watch bodies never carry the stored page snapshot", async () => {
    const { app: a, store } = app(async () => new Response("<p>secret page text</p>", { headers: { "content-type": "text/html" } }));
    const w = await (await a.request("/api/intel/watches", post({ kind: "url", target: "https://docs.example.com/", label: "Docs" }))).json();
    expect("lastSnapshot" in w).toBe(false);
    const checked = await (await a.request(`/api/intel/watches/${w.id}/check`, { method: "POST" })).json();
    expect(checked.watch.lastHash).toMatch(/^[0-9a-f]{64}$/);
    expect("lastSnapshot" in checked.watch).toBe(false);
    const list = await (await a.request("/api/intel/watches")).json();
    expect(list.watches[0]).toMatchObject({ id: w.id, lastHash: checked.watch.lastHash });
    expect(JSON.stringify(list)).not.toContain("secret page text");
    expect((await store.getWatch(w.id))!.lastSnapshot).toBe("secret page text"); // kept server-side
  });

  test("500s do not leak error details", async () => {
    const { app: a, store } = app(async () => new Response(""));
    store.listWatches = async () => Promise.reject(new Error("connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432/app"));
    const orig = console.error;
    console.error = () => {};
    try {
      const res = await a.request("/api/intel/watches");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "watches error" });
    } finally {
      console.error = orig;
    }
  });

  test("check of an unreachable page reports the error on the watch", async () => {
    const { app: a } = app(async () => new Response("nope", { status: 503, headers: { "content-type": "text/html" } }));
    const w = await (await a.request("/api/intel/watches", post({ kind: "url", target: "https://docs.example.com/", label: "Docs" }))).json();
    const r = await (await a.request(`/api/intel/watches/${w.id}/check`, { method: "POST" })).json();
    expect(r.result).toEqual({ status: "error", watchId: w.id, error: "HTTP 503" });
    expect(r.watch.error).toBe("HTTP 503");
  });

  test("400 on bad bodies (incl. SSRF targets) and ids", async () => {
    const { app: a } = app(async () => new Response(""));
    const ip = await a.request("/api/intel/watches", post({ kind: "url", target: "https://127.0.0.1/admin", label: "x" }));
    expect(ip.status).toBe(400);
    expect((await ip.json()).field).toBe("target");
    expect((await a.request("/api/intel/watches", post({ kind: "url", target: "https://localhost/", label: "x" }))).status).toBe(400);
    expect((await a.request("/api/intel/watches", post({ kind: "evm_contract", target: "0x123", chain: "ethereum", label: "x" }))).status).toBe(400);
    expect((await a.request("/api/intel/watches", post({ kind: "evm_wallet", target: `0x${"1".repeat(40)}`, chain: "solana", label: "x" }))).status).toBe(400);
    expect((await a.request("/api/intel/watches", post({ kind: "url", target: "https://a.example.com/", label: "x", rpc: "https://evil" }))).status).toBe(400);
    expect((await a.request("/api/intel/watches", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await a.request("/api/intel/watches/nope/changes")).status).toBe(400);
    expect((await a.request("/api/intel/watches/1;drop", { method: "DELETE" })).status).toBe(400);
    expect((await a.request("/api/intel/watches/x/check", { method: "POST" })).status).toBe(400);
  });
});
