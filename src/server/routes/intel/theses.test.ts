import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SnapshotRow } from "../../../shared/intel.js";
import { ScriptedProvider } from "../../desk/testkit.js";
import { MemoryIntelStore } from "../../intel/store.js";
import type { ThesisDeps } from "../../intel/thesis.js";
import { createThesesRoutes } from "./theses.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const snap = (ts: string, price: number, oiUsd: number, funding: number): SnapshotRow => ({
  asset: "HYPE", ts, price, vol24h: null, funding, oiUsd, premium: null, basis: null,
  depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null,
});

const emit = {
  assets: ["HYPE"],
  claims: [
    { kind: "claim", text: "OI keeps rising", check: { kind: "oi_change", asset: "HYPE", window_h: 24, op: ">", pct: 5 } },
    { kind: "assumption", text: "Funding stays positive", check: { kind: "funding_sign", asset: "HYPE", sign: "positive" } },
  ],
  invalidation: [{ text: "HYPE below $35", check: { kind: "price_vs_level", asset: "HYPE", op: "<", level: 35 } }],
  wrongIf: [{ tag: "hypothesis", text: "Unlock recipients sell into strength." }],
};

async function app(opts: { provider?: ScriptedProvider | null } = {}) {
  const store = new MemoryIntelStore(() => NOW);
  await store.insertSnapshots([snap("2026-10-12T11:30:00Z", 38, 1_000_000, 0.0001), snap("2026-10-13T11:45:00Z", 40, 1_100_000, 0.0001)]);
  const provider = opts.provider === undefined ? new ScriptedProvider("strong-model", () => [{ calls: [{ name: "emit", input: emit }] }]) : opts.provider;
  const deps: ThesisDeps = { store, llm: { makeProvider: () => provider, cache: store, now: () => NOW, dailyCap: 200 }, now: () => NOW };
  return { store, app: new Hono().route("/api/intel", createThesesRoutes(deps)) };
}

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/intel/theses", () => {
  test("create → list → recheck → delete", async () => {
    const { app: a, store } = await app();
    expect(await (await a.request("/api/intel/theses")).json()).toEqual({ theses: [] });

    const res = await a.request("/api/intel/theses", post({ text: "HYPE grinds higher into the unlock because perp OI keeps rising" }));
    expect(res.status).toBe(201);
    const t = await res.json();
    expect(t.claims.map((c: { status: string }) => c.status)).toEqual(["supported", "supported"]);
    expect(t.invalidation[0].status).toBe("clear");
    expect(t.wrongIf).toEqual([{ tag: "hypothesis", text: "Unlock recipients sell into strength." }]);

    expect((await (await a.request("/api/intel/theses")).json()).theses).toHaveLength(1);

    await store.insertSnapshots([snap("2026-10-13T12:00:00Z", 34, 1_000_000, -0.0001)]);
    const chk = await a.request(`/api/intel/theses/${t.id}/check`, { method: "POST" });
    expect(chk.status).toBe(200);
    const re = await chk.json();
    expect(re.claims.map((c: { status: string }) => c.status)).toEqual(["contradicted", "contradicted"]);
    expect(re.invalidation[0].status).toBe("triggered");

    expect((await a.request(`/api/intel/theses/${t.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await a.request(`/api/intel/theses/${t.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await a.request(`/api/intel/theses/${t.id}/check`, { method: "POST" })).status).toBe(404);
  });

  test("400 on bad bodies and ids", async () => {
    const { app: a } = await app();
    const empty = await a.request("/api/intel/theses", post({ text: "  " }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).field).toBe("text");
    expect((await a.request("/api/intel/theses", post({ text: "x".repeat(4001) }))).status).toBe(400);
    expect((await a.request("/api/intel/theses", post({ text: "ok", extra: 1 }))).status).toBe(400);
    expect((await a.request("/api/intel/theses", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await a.request("/api/intel/theses/not-an-id/check", { method: "POST" })).status).toBe(400);
    expect((await a.request("/api/intel/theses/1;drop", { method: "DELETE" })).status).toBe(400);
  });

  test("model failures map to 503 / 502 and store nothing", async () => {
    const none = await app({ provider: null });
    const r1 = await none.app.request("/api/intel/theses", post({ text: "HYPE up" }));
    expect(r1.status).toBe(503);
    expect(await r1.json()).toEqual({ error: "llm not configured" });

    const bad = await app({ provider: new ScriptedProvider("m", () => [{ text: "no structure here" }]) });
    const r2 = await bad.app.request("/api/intel/theses", post({ text: "HYPE up" }));
    expect(r2.status).toBe(502);
    expect(await bad.store.listTheses()).toEqual([]);
  });
});
