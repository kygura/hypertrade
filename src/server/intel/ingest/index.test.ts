import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EmitProvider, llmDeps } from "../fixtures/emit-provider.js";
import { MemoryIntelStore } from "../store.js";
import { runIngestSources, type IngestDeps } from "./index.js";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");
const now = new Date("2026-10-13T12:00:00Z");

const solanaFeed = `<rss version="2.0"><channel><item><title>Attackers drain jitoSOL vault on Solana</title>
<link>https://other.example.net/drain</link><pubDate>Tue, 13 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;

function extraction(prompt: string) {
  const base = { summary: "What the headlines say.", scheduledAt: null, catalyst: null, magnitude: "med" };
  if (/jito/i.test(prompt)) return { ...base, type: "exploit", entities: ["Jito", "jitoSOL"], assets: ["SOL"], magnitude: "high" };
  if (/USDe/.test(prompt)) return { ...base, type: "depeg", entities: ["USDe", "Ethena"], assets: ["ENA"] };
  if (/Hyperliquid upgrade/.test(prompt)) return { ...base, type: "upgrade", entities: ["Hyperliquid"], assets: ["HYPE"] };
  if (/SEC/.test(prompt)) return { ...base, type: "regulatory", entities: ["SEC", "CFTC"], assets: [] };
  if (/Aave/.test(prompt)) return { ...base, type: "governance", entities: ["Aave"], assets: ["AAVE"] };
  return { ...base, type: "other", entities: [], assets: [] };
}

function setup() {
  const store = new MemoryIntelStore(() => now);
  const provider = new EmitProvider(extraction);
  const runs: Array<[string, boolean, string | null | undefined]> = [];
  const feeds: Record<string, string> = {
    "https://news.example.com/rss": fixture("rss2.xml"),
    "https://blog.example.org/atom": fixture("atom.xml"),
    "https://other.example.net/rss": solanaFeed,
  };
  const deps: IngestDeps = {
    store,
    llm: llmDeps(provider, store, () => now),
    env: { INTEL_RSS_FEEDS: Object.keys(feeds).join(","), INTEL_SNAPSHOT_SPACES: "AAVE=aave.eth" },
    now: () => now,
    targets: async () => ["SOL"],
    fetch: (async (u: unknown) => {
      const url = String(u);
      if (url.startsWith("https://hub.snapshot.org")) return new Response(fixture("snapshot-proposals.json"));
      return feeds[url] ? new Response(feeds[url]) : new Response("", { status: 404 });
    }) as unknown as typeof fetch,
    record: async (collector, _t, ok, error) => void runs.push([collector, ok, error]),
  };
  return { store, provider, runs, deps };
}

describe("runIngestSources", () => {
  test("collects, records runs, clusters, extracts once per cluster and merges on entity overlap", async () => {
    const { store, provider, runs, deps } = setup();
    const r = await runIngestSources(deps, { budgetMs: 30_000 });

    expect(r.sources).toEqual([
      { source: "rss", ok: true },
      { source: "governance", ok: true },
      { source: "websearch", ok: true, error: "skipped:disabled" },
      { source: "x", ok: true, error: "skipped:no-key" },
      { source: "telegram", ok: true, error: "skipped:no-channels" },
      { source: "calendar", ok: true },
    ]);
    expect(runs.map((x) => x[0]).sort()).toEqual(["intel:calendar", "intel:governance", "intel:rss", "intel:telegram", "intel:websearch", "intel:x"]);

    // 5 rss/atom headlines + 1 proposal → 6 clusters; the Solana drain merges into the Jito exploit.
    expect(provider.prompts).toHaveLength(6);
    expect(r).toMatchObject({ extracted: 6, extractFailed: 0, pending: 0 });
    expect(r.newClusters).toHaveLength(5);

    const jitoEvent = [...store.events.values()].find((e) => e.title.startsWith("Jito restaking"))!;
    const drainEvent = [...store.events.values()].find((e) => e.title.startsWith("Attackers drain"))!;
    expect(drainEvent.clusterId).toBe(jitoEvent.clusterId);
    expect(r.newClusters).toContain(jitoEvent.clusterId!);
    expect(jitoEvent).toMatchObject({ type: "exploit", entities: ["Jito", "jitoSOL"], assets: ["SOL"], magnitude: "high", tag: "observed" });
    const loser = [...store.clusters.values()].find((c) => c.label?.startsWith("merged into"))!;
    expect(loser.label).toBe(`merged into ${jitoEvent.clusterId}`);
    expect(loser.mappedAt).toBe(now.toISOString());
    expect((await store.getCluster(jitoEvent.clusterId!))!.extraction!.type).toBe("exploit");

    // Governance keeps its structured fields; calendar events are stored but never clustered.
    const gov = [...store.events.values()].find((e) => e.origin === "governance")!;
    expect(gov).toMatchObject({ type: "governance", assets: ["AAVE"], scheduledAt: new Date(1792150000 * 1000).toISOString() });
    expect(gov.clusterId).not.toBeNull();
    const cal = [...store.events.values()].filter((e) => e.origin === "calendar");
    expect(cal.length).toBeGreaterThan(0);
    expect(cal.every((e) => e.clusterId === null)).toBe(true);
  });

  test("a re-run adds nothing new, keeps extracted fields and spends no LLM calls", async () => {
    const { store, provider, deps } = setup();
    await runIngestSources(deps, { budgetMs: 30_000 });
    const again = await runIngestSources(deps, { budgetMs: 30_000 });
    expect(again.newClusters).toEqual([]);
    expect(provider.prompts).toHaveLength(6);
    expect([...store.events.values()].find((e) => e.title.startsWith("Jito restaking"))!.type).toBe("exploit");
  });

  test("out of budget: clusters are stored unextracted and the next run extracts them", async () => {
    const { provider, deps } = setup();
    const first = await runIngestSources(deps, { budgetMs: 0 });
    expect(first).toMatchObject({ newClusters: [], extracted: 0, pending: 6 });
    expect(provider.prompts).toHaveLength(0);
    const second = await runIngestSources(deps, { budgetMs: 30_000 });
    expect(second).toMatchObject({ extracted: 6, pending: 0 });
    expect(second.newClusters).toHaveLength(5);
  });

  test("a failing source is reported and recorded; the run continues", async () => {
    const { deps, runs } = setup();
    const r = await runIngestSources({ ...deps, env: { ...deps.env, INTEL_RSS_FEEDS: "https://missing.example.com/rss" } }, { budgetMs: 30_000 });
    expect(r.sources[0]).toEqual({ source: "rss", ok: false, error: "missing.example.com: HTTP 404" });
    expect(runs.find((x) => x[0] === "intel:rss")).toEqual(["intel:rss", false, "missing.example.com: HTTP 404"]);
    expect(r.newClusters).toHaveLength(1); // the governance proposal
  });
});
