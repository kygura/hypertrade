import { describe, expect, test } from "bun:test";
import { EmitProvider } from "./fixtures/emit-provider.js";
import { mapperDeps, position } from "./fixtures/mapper-deps.js";
import { FEEDBACK_SETTING, runIntelIngest, type IntelIngestDeps } from "./runIngest.js";

const now = new Date("2026-10-13T12:00:00Z");

const feed = `<rss version="2.0"><channel><item><title>Attackers drain jitoSOL vault on Solana</title>
<link>https://news.example.net/drain</link><pubDate>Tue, 13 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;

/** Answers cluster extraction (a "Headlines:" prompt) and mapper explanations (JSON with a position). */
const provider = () =>
  new EmitProvider((prompt) => {
    if (prompt.startsWith("Headlines:")) {
      return { type: "exploit", entities: ["Jito", "jitoSOL"], assets: [], magnitude: "high", summary: "A jitoSOL vault was drained.", scheduledAt: null, catalyst: null };
    }
    const p = JSON.parse(prompt) as { position: { label: string } };
    return { line: { tag: "hypothesis", text: `${p.position.label}. jitoSOL is SOL collateral; the drain could force liquidations.` } };
  });

function setup() {
  const base = mapperDeps({ provider: provider(), positions: [position("SOL", "long", 10_000)], clock: { now } });
  const runs: string[] = [];
  const deps: IntelIngestDeps = {
    ...base,
    fetch: (async (u: unknown) => (String(u) === "https://news.example.net/rss" ? new Response(feed) : new Response("", { status: 404 }))) as unknown as typeof fetch,
    env: { INTEL_RSS_FEEDS: "https://news.example.net/rss" },
    targets: async () => ["SOL"],
    record: async (collector) => void runs.push(collector),
  };
  return { deps, store: base.store, notifier: base.notifier, runs };
}

describe("runIntelIngest", () => {
  test("sources → mapper → catalysts → weekly feedback report", async () => {
    const { deps, store, notifier, runs } = setup();
    const r = await runIntelIngest(deps, { budgetMs: 30_000 });
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.ingest?.newClusters).toHaveLength(1);
    expect(r.mapped).toEqual(r.ingest!.newClusters);
    expect(r).toMatchObject({ alerts: 1, pushed: 1, catalystAlerts: 0, unmapped: [] });
    expect(store.alerts[0]).toMatchObject({ kind: "mapper", asset: "SOL", edgeType: "collateral", route: "push" });
    expect(notifier.sent).toHaveLength(1);
    expect(runs).toContain("intel:rss");
    expect(r.feedbackReportId).not.toBeNull();
    expect(await store.getSetting<string>(FEEDBACK_SETTING)).toBe(now.toISOString());

    // Next run: nothing new to map, and the weekly report is not due yet.
    const again = await runIntelIngest(deps, { budgetMs: 30_000 });
    expect(again).toMatchObject({ mapped: [], alerts: 0, feedbackReportId: null, errors: [] });
    expect(store.reports).toHaveLength(1);
  });

  test("picks up extracted clusters a previous run left unmapped", async () => {
    const { deps, store } = setup();
    await store.upsertCluster({
      id: "left-over",
      label: "Jito restaking bug",
      entities: ["Jito"],
      extraction: { type: "exploit", entities: ["jitoSOL"], assets: [], magnitude: "med", summary: "Bug.", scheduledAt: null, catalyst: null },
      firstSeen: "2026-10-13T08:00:00.000Z",
      lastSeen: "2026-10-13T08:00:00.000Z",
      mappedAt: null,
    });
    const r = await runIntelIngest(deps, { budgetMs: 30_000 });
    expect(r.mapped).toContain("left-over");
    expect((await store.getCluster("left-over"))!.mappedAt).toBe(now.toISOString());
  });

  test("budget cut: no stage starts without budget; a failing stage is reported and later stages still run", async () => {
    const { deps, store } = setup();
    const cut = await runIntelIngest(deps, { budgetMs: 0 });
    expect(cut.skipped).toEqual(["ingest", "mapper", "catalysts", "feedback"]);
    expect(cut.ingest).toBeNull();
    expect(store.events.size).toBe(0);

    const ctl = new AbortController();
    ctl.abort();
    expect((await runIntelIngest(deps, { budgetMs: 30_000, signal: ctl.signal })).skipped).toHaveLength(4);

    deps.exposure = async () => Promise.reject(new Error("positions down"));
    const failing = await runIntelIngest(deps, { budgetMs: 30_000 });
    expect(failing.errors).toEqual([{ stage: "mapper", error: "positions down" }]);
    expect(failing.feedbackReportId).not.toBeNull();
  });
});
