import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensureSeedEdges } from "../../intel/graph.js";
import { MemoryIntelStore } from "../../intel/store.js";
import { createGraphRoutes } from "./graph.js";

async function app(targets: string[] = ["SOL", "BTC"]) {
  const store = new MemoryIntelStore();
  await ensureSeedEdges(store);
  const now = () => new Date("2026-10-13T12:00:00Z");
  return { store, app: new Hono().route("/intel", createGraphRoutes({ store, targets: async () => targets, now })) };
}

const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/intel/graph routes", () => {
  test("GET /graph returns edges touching the asset and best paths to held/watched assets", async () => {
    const { app: a } = await app(["SOL", "BTC", "HYPE"]);
    const res = await a.request("/intel/graph?asset=Jito");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset).toBe("Jito");
    expect(body.edges.map((e: { src: string; dst: string }) => `${e.src}>${e.dst}`).sort()).toEqual(["Jito>SOL", "jitoSOL>Jito"]);
    expect(body.paths).toEqual([{ from: "Jito", to: "SOL", hops: 1, weight: 0.6, edges: [{ from: "Jito", to: "SOL", type: "settles_on" }] }]);
  });

  test("GET /graph validates the asset", async () => {
    const { app: a } = await app();
    for (const q of ["", "?asset=", "?asset=%3Cscript%3E"]) {
      const res = await a.request(`/intel/graph${q}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid asset", field: "asset" });
    }
  });

  test("POST /graph/edges stores a user edge; https source required; user edges then show up in paths", async () => {
    const { app: a, store } = await app(["PURR"]);
    const noSource = await a.request("/intel/graph/edges", send("POST", { src: "PURR", dst: "Hyperliquid", type: "primary_venue" }));
    expect(noSource.status).toBe(400);
    expect(await noSource.json()).toEqual({ error: "an https source URL is required", field: "source" });
    const http = await a.request("/intel/graph/edges", send("POST", { src: "PURR", dst: "Hyperliquid", type: "primary_venue", source: "http://example.com" }));
    expect(http.status).toBe(400);
    expect((await http.json()).field).toBe("source");
    const loop = await a.request("/intel/graph/edges", send("POST", { src: "PURR", dst: "PURR", type: "direct", source: "https://example.com" }));
    expect(loop.status).toBe(400);
    const extra = await a.request("/intel/graph/edges", send("POST", { src: "PURR", dst: "Hyperliquid", type: "direct", source: "https://example.com", origin: "seed" }));
    expect(extra.status).toBe(400);

    const ok = await a.request("/intel/graph/edges", send("POST", { src: "PURR", dst: "Hyperliquid", type: "primary_venue", source: "https://hyperliquid.xyz/purr" }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).edge).toMatchObject({ src: "PURR", dst: "Hyperliquid", type: "primary_venue", weight: 0.4, origin: "user", lastVerified: "2026-10-13T12:00:00.000Z" });
    expect((await store.listEdges()).filter((e) => e.origin === "user")).toHaveLength(1);
    const paths = (await (await a.request("/intel/graph?asset=USDC")).json()).paths;
    expect(paths).toEqual([
      {
        from: "USDC",
        to: "PURR",
        hops: 2,
        weight: 0.6 * 0.4 * 0.5,
        edges: [
          { from: "USDC", to: "Hyperliquid", type: "depends_on_stable" },
          { from: "Hyperliquid", to: "PURR", type: "primary_venue" },
        ],
      },
    ]);
  });

  test("DELETE /graph/edges removes user edges only", async () => {
    const { app: a } = await app();
    await a.request("/intel/graph/edges", send("POST", { src: "PURR", dst: "Hyperliquid", type: "direct", source: "https://hyperliquid.xyz" }));
    const seed = await a.request("/intel/graph/edges", send("DELETE", { src: "jitoSOL", dst: "SOL", type: "collateral" }));
    expect(seed.status).toBe(400);
    expect((await seed.json()).error).toContain("seed edges cannot be deleted");
    expect((await a.request("/intel/graph/edges", send("DELETE", { src: "PURR", dst: "Hyperliquid", type: "direct" }))).status).toBe(200);
    expect((await a.request("/intel/graph/edges", send("DELETE", { src: "PURR", dst: "Hyperliquid", type: "direct" }))).status).toBe(404);
    expect((await a.request("/intel/graph/edges", send("DELETE", { src: "PURR", type: "direct" }))).status).toBe(400);
  });
});
