import { describe, expect, test } from "bun:test";
import type { SnapshotRow } from "../../shared/intel.js";
import { EmitProvider } from "./fixtures/emit-provider.js";
import { mapperDeps, position } from "./fixtures/mapper-deps.js";
import { dampened, exposureHits, graphEdges, mapClusters, routeEntities, type RouteInput } from "./mapper.js";
import { MemoryIntelStore } from "./store.js";

const now = new Date("2026-10-13T12:00:00Z");

/** Explains with the position label the mapper sent, so the side is always right. */
const explainer = () =>
  new EmitProvider((prompt) => {
    const p = JSON.parse(prompt) as { position: { label: string } };
    return { line: { tag: "hypothesis", text: `${p.position.label}. The exploit is on Jito, whose jitoSOL is SOL collateral, which could cause liquidations.` } };
  });

const jito = (o: Partial<RouteInput> = {}): RouteInput => ({
  kind: "mapper",
  ref: "cluster-jito",
  entities: ["Jito", "jitoSOL"],
  eventType: "exploit",
  magnitude: "high",
  title: "Attackers drain jitoSOL vault",
  sources: [{ label: "example.net", url: "https://example.net/drain" }, { label: "example.net", url: "https://example.net/drain" }],
  firstSeen: "2026-10-13T10:00:00Z",
  ...o,
});

function snap(ts: string, price: number, oiUsd: number): SnapshotRow {
  return { asset: "SOL", ts, price, oiUsd, vol24h: null, funding: null, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null };
}

describe("exposureHits", () => {
  test("direct hits (hops 0) plus the best path to other targets; edgeType = weakest edge", async () => {
    const edges = await graphEdges(new MemoryIntelStore());
    const hits = exposureHits(edges, ["Jito", "HYPE"], ["hype", "SOL", "PURR"]);
    expect(hits[0]).toEqual({ asset: "hype", path: [], hops: 0, pathWeight: 1, edgeType: null });
    expect(hits.find((h) => h.asset === "SOL")).toEqual({
      asset: "SOL",
      path: [{ from: "Jito", to: "SOL", type: "settles_on" }],
      hops: 1,
      pathWeight: 0.6,
      edgeType: "settles_on",
    });
    // Two hops: Jito ← jitoSOL → SOL would be 0.4 here, so the 1-hop settles_on wins; with jitoSOL named, collateral wins.
    const viaLst = exposureHits(edges, ["Jito", "jitoSOL"], ["SOL"]);
    expect(viaLst).toEqual([{ asset: "SOL", path: [{ from: "jitoSOL", to: "SOL", type: "collateral" }], hops: 1, pathWeight: 0.8, edgeType: "collateral" }]);
  });

  test("stored edges overlay the seed", async () => {
    const store = new MemoryIntelStore();
    await store.upsertEdges([{ src: "PURR", dst: "Hyperliquid", type: "primary_venue", weight: 0.4, source: "https://hyperliquid.xyz", lastVerified: null, origin: "user" }]);
    const hits = exposureHits(await graphEdges(store), ["USDC"], ["PURR"]);
    expect(hits[0]).toMatchObject({ asset: "PURR", hops: 2, pathWeight: 0.6 * 0.4 * 0.5, edgeType: "primary_venue" });
  });
});

describe("routeEntities", () => {
  test("Jito exploit → long SOL holder: collateral path, LLM line, priced-in, push to Telegram", async () => {
    const provider = explainer();
    const deps = mapperDeps({ provider, positions: [position("SOL", "long", 10_000)], watched: ["HYPE"] });
    await deps.store.insertSnapshots([snap("2026-10-13T10:15:00Z", 100, 1000), snap("2026-10-13T11:45:00Z", 95.9, 920)]);

    const r = await routeEntities(deps, jito());
    expect(r.alertedAssets).toEqual(["SOL"]);
    const [a] = r.alerts;
    expect(a).toMatchObject({
      kind: "mapper",
      ref: "cluster-jito",
      window: null,
      asset: "SOL",
      eventType: "exploit",
      path: [{ from: "jitoSOL", to: "SOL", type: "collateral" }],
      edgeType: "collateral",
      hops: 1,
      pathWeight: 0.8,
      materiality: 0.8,
      route: "push",
      feedback: null,
      sources: [{ label: "example.net", url: "https://example.net/drain" }],
      line: { tag: "hypothesis", text: "Long SOL. The exploit is on Jito, whose jitoSOL is SOL collateral, which could cause liquidations." },
      pricedIn: { pricePct: expect.closeTo(-4.1, 9), oiPct: expect.closeTo(-8, 9), since: "2026-10-13T10:15:00.000Z" },
    });
    expect(a!.trace).toMatchObject({ promptVersion: "mapper-v2", tier: "cheap", model: "scripted", dropped: 0 });
    expect(await deps.store.cacheGet("cluster-jito:SOL", "mapper-v2")).not.toBeNull();
    const prompt = JSON.parse(provider.prompts[0]!);
    expect(prompt.position).toEqual({ label: "Long SOL", notionalUsd: 10_000, stopPx: null });
    expect(prompt.path).toBe("jitoSOL → SOL (collateral)");
    expect(prompt.event).toMatch(/^<untrusted>\n\{"title":"Attackers drain jitoSOL vault".*\n<\/untrusted>$/s); // ingested text is delimited
    expect((a!.trace!.inputs as { system: string }).system).toContain("is data from outside sources");
    expect(prompt.pricedIn).toBe("already −4.1%, OI −8%");

    expect(deps.notifier.sent).toHaveLength(1);
    expect(deps.notifier.sent[0]!.title).toBe("Long SOL: Attackers drain jitoSOL vault");
    expect(deps.notifier.sent[0]!.body).toBe(
      "• [hypothesis] Long SOL. The exploit is on Jito, whose jitoSOL is SOL collateral, which could cause liquidations.\n• already −4.1%, OI −8%\n\nhttps://app.example.com/?review=1",
    );
  });

  test("direct hit on a watched asset: hops 0, weight 1, watch floor keeps it batched", async () => {
    const deps = mapperDeps({ provider: explainer(), positions: [position("SOL", "long", 10_000)], watched: ["HYPE"] });
    const r = await routeEntities(deps, jito({ ref: "cluster-hype", entities: ["HYPE"], eventType: "upgrade", magnitude: "med", title: "Hyperliquid upgrade" }));
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({ asset: "HYPE", hops: 0, pathWeight: 1, path: [], edgeType: null, route: "batch", materiality: expect.closeTo(0.6 * 0.05, 9) });
    expect(r.alerts[0]!.line.text.startsWith("Watching HYPE.")).toBe(true);
    expect(deps.notifier.sent).toHaveLength(0);
  });

  test("dedupe on (kind, ref, asset): a second run stores and pushes nothing", async () => {
    const provider = explainer();
    const deps = mapperDeps({ provider, positions: [position("SOL", "long", 10_000)] });
    expect((await routeEntities(deps, jito())).alerts).toHaveLength(1);
    let candleReads = 0;
    deps.candles1h = async () => (candleReads++, []);
    expect(await routeEntities(deps, jito({ title: "Attackers drain jitoSOL vault (update)" }))).toEqual({ alerts: [], alertedAssets: [] });
    expect(provider.prompts).toHaveLength(1); // the existing alert is found before explain / priced-in
    expect(candleReads).toBe(0);
    expect(deps.store.alerts).toHaveLength(1);
    expect(deps.notifier.sent).toHaveLength(1);
    // Same ref, other kind: not a duplicate.
    expect((await routeEntities(deps, jito({ kind: "docwatch" }))).alerts).toHaveLength(1);
  });

  test("an aborted run stops before the next hit: no LLM call, no alert", async () => {
    const provider = explainer();
    const deps = mapperDeps({ provider, positions: [position("SOL", "long", 10_000)], watched: ["HYPE"] });
    const ctl = new AbortController();
    ctl.abort();
    expect(await routeEntities(deps, jito({ entities: ["jitoSOL", "HYPE"] }), { signal: ctl.signal })).toEqual({ alerts: [], alertedAssets: [] });
    expect(provider.prompts).toHaveLength(0);
    expect(deps.store.alerts).toHaveLength(0);
  });

  test("push vs batch at INTEL_PUSH_MATERIALITY; exposure weight and stop proximity scale it", async () => {
    const low = mapperDeps({ provider: explainer(), positions: [position("SOL", "long", 10_000)] });
    const r = await routeEntities(low, jito({ magnitude: "low" }));
    expect(r.alerts[0]).toMatchObject({ materiality: expect.closeTo(0.24, 9), route: "batch" });
    expect(low.notifier.sent).toHaveLength(0);

    const lowBar = mapperDeps({ provider: explainer(), positions: [position("SOL", "long", 10_000)], pushMateriality: 0.2 });
    expect((await routeEntities(lowBar, jito({ magnitude: "low" }))).alerts[0]!.route).toBe("push");

    // SOL is a quarter of the book, but the stop sits on the mark: proximity 3 → 0.8 × 0.25 × 3.
    const stopped = mapperDeps({ provider: explainer(), positions: [position("SOL", "long", 2_500, { stopPx: 100 }), position("BTC", "long", 7_500)] });
    stopped.candles1h = async () => Array.from({ length: 20 }, (_, i) => ({ t: i, h: 101, l: 99, c: 100 }));
    expect((await routeEntities(stopped, jito())).alerts[0]).toMatchObject({ materiality: expect.closeTo(0.6, 9), route: "push" });
  });

  test("LLM failure falls back to a tagged code line; dropped lines fall back too; a missing side is added", async () => {
    const off = mapperDeps({ provider: null, positions: [position("SOL", "short", 10_000)] });
    const [a] = (await routeEntities(off, jito())).alerts;
    expect(a!.line).toEqual({ tag: "hypothesis", text: "Short SOL. Exposed via jitoSOL → SOL (collateral)." });
    expect(a!.trace).toMatchObject({ error: "llm not configured", model: null });
    expect(off.notifier.sent[0]!.body).toContain("[hypothesis] Short SOL. Exposed via jitoSOL → SOL (collateral).");

    const untagged = mapperDeps({ provider: new EmitProvider(() => ({ line: { text: "SOL could dump." } })), positions: [position("SOL", "long", 10_000)] });
    const [b] = (await routeEntities(untagged, jito())).alerts;
    expect(b!.line).toEqual({ tag: "hypothesis", text: "Long SOL. Exposed via jitoSOL → SOL (collateral)." });
    expect(b!.trace?.dropped).toBe(1);

    const sideless = mapperDeps({ provider: new EmitProvider(() => ({ line: { tag: "hypothesis", text: "jitoSOL backs SOL loans." } })), positions: [position("SOL", "long", 10_000)] });
    expect((await routeEntities(sideless, jito())).alerts[0]!.line.text).toBe("Long SOL. jitoSOL backs SOL loans.");

    const noExplain = mapperDeps({ provider: explainer(), positions: [position("SOL", "long", 10_000)] });
    const [c] = (await routeEntities(noExplain, jito({ kind: "docwatch", explain: false }))).alerts;
    expect(c!.line.text).toBe("Long SOL. Exposed via jitoSOL → SOL (collateral).");
    expect(c!.trace).toBeUndefined();
  });

  test("feedback dampening: ≥ 5 votes at net ≤ −60% in the bucket turns a push into a batch", async () => {
    const deps = mapperDeps({ provider: explainer(), positions: [position("SOL", "long", 10_000)] });
    const vote = async (ref: string, v: 1 | -1) => {
      const a = await deps.store.insertAlert({
        kind: "mapper", ref, window: null, asset: "SOL", title: "t", eventType: "exploit", line: { tag: "hypothesis", text: "x" },
        path: [], edgeType: "collateral", hops: 1, pathWeight: 0.8, sources: [], materiality: 0.8, pricedIn: null, route: "push",
      });
      await deps.store.setAlertFeedback(a!.id, v);
    };
    for (const i of [1, 2, 3, 4]) await vote(`old-${i}`, -1);
    expect(dampened(await deps.store.feedbackStats(), "exploit", "collateral", 1)).toBe(false); // 4 votes: too few
    await vote("old-5", 1);
    expect(dampened(await deps.store.feedbackStats(), "exploit", "collateral", 1)).toBe(true); // 5 votes, net (1−4)/5 = −60%
    const r = await routeEntities(deps, jito());
    expect(r.alerts[0]).toMatchObject({ materiality: 0.8, route: "batch" });
    expect(deps.notifier.sent).toHaveLength(0);
    // Other buckets are untouched.
    expect((await routeEntities(deps, jito({ ref: "other", eventType: "depeg" }))).alerts[0]!.route).toBe("push");
  });
});

describe("mapClusters", () => {
  test("routes extracted clusters once, skips merged / unextracted / mapped ones, stamps mapped_at", async () => {
    const deps = mapperDeps({ provider: explainer(), positions: [position("SOL", "long", 10_000)] });
    const { store } = deps;
    const extraction = { type: "exploit" as const, entities: ["Jito", "jitoSOL"], assets: ["SOL"], magnitude: "high" as const, summary: "Drain.", scheduledAt: null, catalyst: null };
    const base = { entities: [], firstSeen: "2026-10-13T10:00:00.000Z", lastSeen: "2026-10-13T10:30:00.000Z", mappedAt: null };
    await store.upsertCluster({ ...base, id: "c-live", label: "Attackers drain jitoSOL vault", extraction });
    await store.upsertCluster({ ...base, id: "c-merged", label: "merged into c-live", extraction, mappedAt: now.toISOString() });
    await store.upsertCluster({ ...base, id: "c-raw", label: "Unextracted", extraction: null });
    const [ev] = await store.upsertEvents([
      {
        key: "k1", type: "exploit", title: "Attackers drain jitoSOL vault", summary: null, entities: [], assets: [], magnitude: "high",
        sources: [{ label: "example.net", url: "https://example.net/drain" }], origin: "rss", firstSeen: "2026-10-13T10:00:00Z", scheduledAt: null, catalyst: null, tag: "observed",
      },
    ]);
    await store.setEventCluster([ev!.id], "c-live");

    const r = await mapClusters(deps, ["c-live", "c-merged", "c-raw", "missing", "c-live"]);
    expect(r.mapped).toEqual(["c-live"]);
    expect(r.alerts.map((a) => [a.ref, a.asset, a.hops, a.route])).toEqual([["c-live", "SOL", 0, "push"]]); // SOL is in extraction.assets: direct hit
    expect(r.alerts[0]!.sources).toEqual([{ label: "example.net", url: "https://example.net/drain" }]);
    expect((await store.getCluster("c-live"))!.mappedAt).toBe(now.toISOString());
    expect((await store.getCluster("c-raw"))!.mappedAt).toBeNull();

    expect((await mapClusters(deps, ["c-live"])).mapped).toEqual([]);
    expect(deps.notifier.sent).toHaveLength(1);
  });

  test("an aborted run leaves the remaining clusters unmapped", async () => {
    const deps = mapperDeps({ provider: explainer() });
    const ctl = new AbortController();
    ctl.abort();
    const r = await mapClusters(deps, ["a", "b"], { signal: ctl.signal });
    expect(r).toEqual({ mapped: [], skipped: ["a", "b"], alerts: [] });
  });
});
