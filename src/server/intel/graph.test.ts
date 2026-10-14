import { describe, expect, test } from "bun:test";
import { EDGE_TYPE_WEIGHT, type Edge, type EdgeType } from "../../shared/intel.js";
import { EmitProvider, llmDeps } from "./fixtures/emit-provider.js";
import { SEED_EDGES } from "./graph-seed.js";
import { ensureSeedEdges, GRAPH_NO_WEB_SEARCH, refreshGraph, walk } from "./graph.js";
import { MemoryIntelStore } from "./store.js";

let n = 0;
const edge = (src: string, dst: string, type: EdgeType): Edge => ({ id: `e${++n}`, src, dst, type, weight: EDGE_TYPE_WEIGHT[type], source: null, lastVerified: null, origin: "seed" });

describe("walk", () => {
  const edges = [edge("jitoSOL", "Jito", "direct"), edge("jitoSOL", "SOL", "collateral"), edge("BTC", "DXY", "macro_beta")];

  test("a Jito exploit reaches a SOL holder through jitoSOL, against stored edge direction", () => {
    const paths = walk(edges, ["Jito"], ["SOL", "BTC"]);
    expect(paths).toEqual([
      {
        from: "Jito",
        to: "SOL",
        hops: 2,
        weight: 1 * 0.8 * 0.5,
        edges: [
          { from: "Jito", to: "jitoSOL", type: "direct" },
          { from: "jitoSOL", to: "SOL", type: "collateral" },
        ],
      },
    ]);
  });

  test("names match case-insensitively; from/to keep the caller's spelling", () => {
    const [p] = walk(edges, ["jito"], ["sol"]);
    expect(p).toMatchObject({ from: "jito", to: "sol", hops: 2 });
  });

  test("hop decay: one hop is type weight, two hops halve the product", () => {
    const g = [edge("A", "B", "settles_on"), edge("B", "C", "settles_on")];
    expect(walk(g, ["A"], ["B"])[0]!.weight).toBeCloseTo(0.6);
    expect(walk(g, ["A"], ["C"])[0]!.weight).toBeCloseTo(0.6 * 0.6 * 0.5);
    expect(walk(g, ["A"], ["C"], 1)).toEqual([]);
  });

  test("best path per target: a strong one-hop beats a weak one, and a strong two-hop beats a weak one-hop", () => {
    const g = [edge("Jito", "SOL", "macro_beta"), edge("Jito", "jitoSOL", "direct"), edge("jitoSOL", "SOL", "collateral")];
    const [p] = walk(g, ["Jito"], ["SOL"]);
    expect(p!.hops).toBe(2); // 0.4 > 0.3
    const g2 = [...g, edge("Jito", "SOL", "settles_on")];
    expect(walk(g2, ["Jito"], ["SOL"])[0]).toMatchObject({ hops: 1, weight: 0.6, edges: [{ type: "settles_on" }] });
  });

  test("best across several start entities; a start that is itself a target is not a path", () => {
    const g = [edge("USDC", "Circle", "direct"), edge("Hyperliquid", "USDC", "depends_on_stable"), edge("HYPE", "Hyperliquid", "direct")];
    const paths = walk(g, ["Circle", "USDC", "HYPE"], ["HYPE"]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ from: "USDC", to: "HYPE", hops: 2, weight: 0.6 * 1 * 0.5 });
  });

  test("seed graph: Jito reaches SOL, USDC reaches HYPE, DXY reaches BTC", () => {
    const seed = SEED_EDGES.map((e, i) => ({ ...e, id: String(i), weight: EDGE_TYPE_WEIGHT[e.type], lastVerified: null, origin: "seed" as const }));
    const paths = walk(seed, ["Jito", "USDC", "DXY"], ["SOL", "HYPE", "BTC"]);
    expect(paths.map((p) => p.to).sort()).toEqual(["BTC", "HYPE", "SOL"]);
    expect(paths.find((p) => p.to === "SOL")!.weight).toBeCloseTo(0.6);
    for (const e of SEED_EDGES) expect(e.source).toStartWith("https://");
    expect(new Set(SEED_EDGES.map((e) => `${e.src}|${e.dst}|${e.type}`)).size).toBe(SEED_EDGES.length);
  });
});

describe("ensureSeedEdges", () => {
  test("idempotent, and never replaces a user edge", async () => {
    const store = new MemoryIntelStore();
    await store.upsertEdges([{ src: "jitoSOL", dst: "SOL", type: "collateral", weight: 0.2, source: "https://example.com/mine", lastVerified: null, origin: "user" }]);
    await ensureSeedEdges(store);
    await ensureSeedEdges(store);
    const all = await store.listEdges();
    expect(all).toHaveLength(SEED_EDGES.length);
    expect(all.find((e) => e.src === "jitoSOL" && e.dst === "SOL")).toMatchObject({ origin: "user", weight: 0.2 });
  });
});

describe("refreshGraph", () => {
  const now = () => new Date("2026-10-13T12:00:00Z");

  test("stores sourced edges as llm, drops sourceless/http/unrelated ones, caches per asset per day", async () => {
    const store = new MemoryIntelStore();
    const provider = new EmitProvider((prompt) => ({
      edges: prompt.includes("Asset: SOL")
        ? [
            { src: "SOL", dst: "Pyth", type: "depends_on_stable", source: "https://docs.pyth.network/" },
            { src: "SOL", dst: "Wormhole", type: "bridge", source: null },
            { src: "SOL", dst: "Helius", type: "primary_venue", source: "http://helius.dev" },
            { src: "SOL", dst: "SOL", type: "direct", source: "https://solana.com" },
            { src: "ETH", dst: "Lido", type: "direct", source: "https://lido.fi" },
            { src: "Raydium", dst: "sol", type: "primary_venue", source: "https://docs.raydium.io/" },
          ]
        : [],
    }));
    const deps = { store, llm: llmDeps(provider, store, now), targets: async () => ["SOL", "BTC", "SOL"], now };
    const s = await refreshGraph(deps, { budgetMs: 10_000 });
    expect(s).toMatchObject({ assets: ["SOL", "BTC"], done: ["SOL", "BTC"], skipped: [], failed: [], stored: 2, dropped: 4 });
    const llm = (await store.listEdges()).filter((e) => e.origin === "llm");
    expect(llm.map((e) => `${e.src}>${e.dst}`).sort()).toEqual(["Raydium>sol", "SOL>Pyth"]);
    expect(llm[0]!.lastVerified).toBe("2026-10-13T12:00:00.000Z");
    expect(provider.opts.every((o) => o.webSearch === true)).toBe(true);

    await refreshGraph(deps, { budgetMs: 10_000 });
    expect(provider.prompts).toHaveLength(2); // second run: cache hits
  });

  test("stops at the budget and reports what it did not reach", async () => {
    const store = new MemoryIntelStore();
    const provider = new EmitProvider(() => ({ edges: [] }));
    const s = await refreshGraph({ store, llm: llmDeps(provider, store, now), targets: async () => ["SOL", "BTC"], now }, { budgetMs: 0 });
    expect(s).toMatchObject({ done: [], skipped: ["SOL", "BTC"] });
    expect(s.seeded).toBe(SEED_EDGES.length);
    expect(provider.prompts).toHaveLength(0);
  });

  test("a provider without web search skips the refresh with a warning (seeds still land)", async () => {
    const store = new MemoryIntelStore();
    const provider = Object.assign(new EmitProvider(() => ({ edges: [] })), { webSearch: false });
    const s = await refreshGraph({ store, llm: llmDeps(provider, store, now), targets: async () => ["SOL"], now }, { budgetMs: 10_000 });
    expect(s).toMatchObject({ done: [], skipped: ["SOL"], warning: GRAPH_NO_WEB_SEARCH, seeded: SEED_EDGES.length });
    expect(provider.prompts).toHaveLength(0);
  });

  test("an unconfigured provider fails per asset without throwing", async () => {
    const store = new MemoryIntelStore();
    const s = await refreshGraph({ store, llm: llmDeps(null, store, now), targets: async () => ["SOL"], now }, { budgetMs: 10_000 });
    expect(s.failed).toEqual([{ asset: "SOL", error: "llm not configured" }]);
  });

  describe("diff-review", () => {
    const day2 = () => new Date("2026-10-14T12:00:00Z");
    const llmEdges = async (store: MemoryIntelStore) => (await store.listEdges()).filter((e) => e.origin === "llm").map((e) => `${e.src}>${e.dst}`).sort();
    const first = new EmitProvider(() => ({
      edges: [
        { src: "SOL", dst: "Pyth", type: "depends_on_stable", source: "https://docs.pyth.network/" },
        { src: "SOL", dst: "Helius", type: "primary_venue", source: "https://helius.dev" },
      ],
    }));

    async function seeded() {
      const store = new MemoryIntelStore();
      const run = await refreshGraph({ store, llm: llmDeps(first, store, now), targets: async () => ["SOL"], now }, { budgetMs: 10_000 });
      expect(await llmEdges(store)).toEqual(["SOL>Helius", "SOL>Pyth"]);
      expect(run.diffs.SOL).toEqual({ added: ["SOL -depends_on_stable-> Pyth", "SOL -primary_venue-> Helius"], removed: [], changed: [], refused: 0 });
      return store;
    }

    test("a failed or empty rebuild never removes edges", async () => {
      const store = await seeded();
      const failed = await refreshGraph({ store, llm: llmDeps(null, store, day2), targets: async () => ["SOL"], now: day2 }, { budgetMs: 10_000 });
      expect(failed.failed).toHaveLength(1);
      expect(failed.diffs).toEqual({});
      const empty = new EmitProvider(() => ({ edges: [] }));
      const s = await refreshGraph({ store, llm: llmDeps(empty, store, day2), targets: async () => ["SOL"], now: day2 }, { budgetMs: 10_000 });
      expect(s.diffs.SOL).toEqual({ added: [], removed: [], changed: [], refused: 0 });
      expect(await llmEdges(store)).toEqual(["SOL>Helius", "SOL>Pyth"]);
    });

    const llmEdge = (src: string, dst: string, type: EdgeType = "narrative") => ({ src, dst, type, weight: 0.3, source: "https://old.example.com", lastVerified: null, origin: "llm" as const });
    const pair = (reply: (asset: string) => unknown) => new EmitProvider((prompt) => reply(prompt.includes("Asset: BTC") ? "BTC" : "ETH"));

    test("an edge another target's rebuild kept survives; a stale edge of two succeeded targets goes at the end", async () => {
      const store = new MemoryIntelStore();
      await store.upsertEdges([llmEdge("BTC", "ETH"), llmEdge("ETH", "Old")]);
      const provider = pair((a) =>
        a === "BTC"
          ? { edges: [{ src: "BTC", dst: "ETH", type: "narrative", source: "https://a.example.com" }] }
          : { edges: [{ src: "ETH", dst: "Bar", type: "narrative", source: "https://b.example.com" }] },
      );
      const s = await refreshGraph({ store, llm: llmDeps(provider, store, now), targets: async () => ["BTC", "ETH"], now }, { budgetMs: 10_000 });
      expect(await llmEdges(store)).toEqual(["BTC>ETH", "ETH>Bar"]);
      expect(s.diffs.ETH!.removed).toEqual(["ETH -narrative-> Old"]);
    });

    test("an edge touching a target whose rebuild failed survives", async () => {
      const store = new MemoryIntelStore();
      await store.upsertEdges([llmEdge("BTC", "ETH")]);
      const provider = pair((a) => (a === "BTC" ? { edges: [{ src: "BTC", dst: "Foo", type: "narrative", source: "https://a.example.com" }] } : { bad: 1 }));
      const s = await refreshGraph({ store, llm: llmDeps(provider, store, now), targets: async () => ["BTC", "ETH"], now }, { budgetMs: 10_000 });
      expect(s.failed.map((f) => f.asset)).toEqual(["ETH"]);
      expect(await llmEdges(store)).toEqual(["BTC>ETH", "BTC>Foo"]);
    });

    test("a known edge re-proposed with a refused (http) source survives", async () => {
      const store = new MemoryIntelStore();
      await store.upsertEdges([llmEdge("SOL", "Pyth", "depends_on_stable")]);
      const provider = new EmitProvider(() => ({
        edges: [
          { src: "SOL", dst: "Pyth", type: "depends_on_stable", source: "http://pyth.network" },
          { src: "SOL", dst: "Jito", type: "collateral", source: "https://jito.network" },
        ],
      }));
      const s = await refreshGraph({ store, llm: llmDeps(provider, store, now), targets: async () => ["SOL"], now }, { budgetMs: 10_000 });
      expect(await llmEdges(store)).toEqual(["SOL>Jito", "SOL>Pyth"]);
      expect(s.diffs.SOL!.removed).toEqual([]);
    });

    test("the graph:diff run is recorded as failed when the run throws, after the upserts", async () => {
      const store = new MemoryIntelStore();
      store.deleteLlmEdges = async () => Promise.reject(new Error("db down"));
      await store.upsertEdges([llmEdge("SOL", "Old")]);
      const provider = new EmitProvider(() => ({ edges: [{ src: "SOL", dst: "Jito", type: "collateral", source: "https://jito.network" }] }));
      const runs: Array<[string, boolean, string | null | undefined]> = [];
      const recordRun = async (c: string, _t: Date, ok: boolean, err?: string | null) => void runs.push([c, ok, err]);
      await expect(refreshGraph({ store, llm: llmDeps(provider, store, now), targets: async () => ["SOL"], now, recordRun }, { budgetMs: 10_000 })).rejects.toThrow("db down");
      expect(runs).toHaveLength(1);
      expect(runs[0]!.slice(0, 2)).toEqual(["graph:diff", false]);
      expect(await llmEdges(store)).toEqual(["SOL>Jito", "SOL>Old"]); // upsert landed, delete did not
    });

    test("a successful rebuild removes llm edges it no longer proposes, never seed or user ones; the diff is recorded", async () => {
      const store = await seeded();
      await store.upsertEdges([{ src: "SOL", dst: "Manual", type: "narrative", weight: 0.3, source: "https://example.com/m", lastVerified: null, origin: "user" }]);
      const second = new EmitProvider(() => ({
        edges: [
          { src: "SOL", dst: "Pyth", type: "depends_on_stable", source: "https://pyth.network/new" },
          { src: "SOL", dst: "Jito", type: "collateral", source: "https://jito.network" },
          { src: "SOL", dst: "Bad", type: "bridge", source: null },
        ],
      }));
      const runs: Array<[string, boolean, string | null | undefined]> = [];
      const recordRun = async (c: string, _t: Date, ok: boolean, err?: string | null) => void runs.push([c, ok, err]);
      const s = await refreshGraph({ store, llm: llmDeps(second, store, day2), targets: async () => ["SOL"], now: day2, recordRun }, { budgetMs: 10_000 });
      expect(s.diffs.SOL).toEqual({ added: ["SOL -collateral-> Jito"], removed: ["SOL -primary_venue-> Helius"], changed: ["SOL -depends_on_stable-> Pyth"], refused: 1 });
      expect(await llmEdges(store)).toEqual(["SOL>Jito", "SOL>Pyth"]);
      const all = await store.listEdges();
      expect(all.some((e) => e.origin === "user" && e.dst === "Manual")).toBe(true);
      expect(all.filter((e) => e.origin === "seed").length).toBeGreaterThan(0);
      expect(runs).toEqual([["graph:diff", true, JSON.stringify(s.diffs)]]);
    });
  });
});
