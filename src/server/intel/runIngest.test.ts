import { describe, expect, test } from "bun:test";
import { EmitProvider } from "./fixtures/emit-provider.js";
import { mapperDeps, position } from "./fixtures/mapper-deps.js";
import type { MemoryIntelStore } from "./store.js";
import type { PaperFill } from "../desk/store.js";
import { FEEDBACK_SETTING, JOURNAL_SETTING, runIntelIngest, type IntelIngestDeps } from "./runIngest.js";

const now = new Date("2026-10-13T12:00:00Z");

const feed = `<rss version="2.0"><channel><item><title>Attackers drain jitoSOL vault on Solana</title>
<link>https://news.example.net/drain</link><pubDate>Tue, 13 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;

const extraction = { type: "exploit", entities: ["Jito", "jitoSOL"], assets: [], magnitude: "high", summary: "A jitoSOL vault was drained.", scheduledAt: null, catalyst: null };

/** Answers cluster extraction (a "Headlines:" prompt) and mapper explanations (JSON with a position). */
const provider = () =>
  new EmitProvider((prompt) => {
    if (prompt.startsWith("Headlines:")) return extraction;
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
  test("sources → catalysts → mapper → weekly feedback report", async () => {
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

  test("catalysts run before the mapper, so a mapper that eats the budget cannot starve a T−24 h / T−1 h alert", async () => {
    const ctl = new AbortController();
    const base = mapperDeps({
      provider: new EmitProvider((prompt) => {
        if (prompt.startsWith("Headlines:")) return extraction;
        ctl.abort(); // the mapper's first explanation uses up the run
        return { line: { tag: "hypothesis", text: "Long SOL. Slow." } };
      }),
      positions: [position("SOL", "long", 10_000)],
      clock: { now },
    });
    const deps: IntelIngestDeps = { ...setup().deps, ...base };
    await base.store.upsertEvents([
      { key: "unlock", type: "unlock", title: "SOL unlock", summary: null, entities: ["SOL"], assets: ["SOL"], magnitude: "med", sources: [{ label: "calendar" }], origin: "manual", firstSeen: "2026-10-13T08:00:00Z", scheduledAt: "2026-10-13T15:00:00Z", catalyst: null, tag: "observed" },
    ]);
    const r = await runIntelIngest(deps, { budgetMs: 30_000, signal: ctl.signal });
    expect(r.catalystAlerts).toBe(1);
    expect(r.skipped).toEqual(["feedback", "journal"]);
  });

  test("budget cut: no stage starts without budget; a failing stage is reported and later stages still run", async () => {
    const { deps, store } = setup();
    const cut = await runIntelIngest(deps, { budgetMs: 0 });
    expect(cut.skipped).toEqual(["ingest", "catalysts", "mapper", "feedback", "journal"]);
    expect(cut.ingest).toBeNull();
    expect(store.events.size).toBe(0);

    const ctl = new AbortController();
    ctl.abort();
    expect((await runIntelIngest(deps, { budgetMs: 30_000, signal: ctl.signal })).skipped).toHaveLength(5);

    deps.exposure = async () => Promise.reject(new Error("positions down"));
    const failing = await runIntelIngest(deps, { budgetMs: 30_000 });
    expect(failing.errors).toEqual([{ stage: "mapper", error: "positions down" }]);
    expect(failing.feedbackReportId).not.toBeNull();
  });

  test("journal: weekly report only when a trade closed in the last 7 d; stamped either way; a failure never fails the ingest", async () => {
    const fill = (id: number, ts: string, side: "buy" | "sell", pnl: number): PaperFill => ({ id, ts, coin: "ETH", side, size: 1, px: 3000, fee: 0, pnl, reason: side === "buy" ? "entry" : "target", proposalId: null });
    let fills: PaperFill[] = [fill(1, "2026-09-01T10:00:00Z", "buy", 0), fill(2, "2026-09-02T10:00:00Z", "sell", 50)]; // closed weeks ago
    const { deps, store } = setup();
    deps.journal = () => ({ store, llm: deps.llm, now: deps.now, deskFills: async () => fills });

    const quiet = await runIntelIngest(deps, { budgetMs: 30_000 });
    expect(quiet).toMatchObject({ journalReportId: null, errors: [] });
    expect(await store.getSetting<string>(JOURNAL_SETTING)).toBe(now.toISOString());

    await store.setSetting(JOURNAL_SETTING, null);
    fills = [fill(3, "2026-10-12T10:00:00Z", "buy", 0), fill(4, "2026-10-12T14:00:00Z", "sell", 40)];
    const due = await runIntelIngest(deps, { budgetMs: 30_000 });
    expect(due.journalReportId).not.toBeNull();
    expect((await store.latestReport("journal_weekly"))?.id).toBe(due.journalReportId!);
    // Not due again inside the week.
    expect((await runIntelIngest(deps, { budgetMs: 30_000 })).journalReportId).toBeNull();

    await store.setSetting(JOURNAL_SETTING, null);
    deps.journal = () => ({ store: { ...store, insertReport: async () => Promise.reject(new Error("reports down")) } as unknown as MemoryIntelStore, llm: deps.llm, now: deps.now, deskFills: async () => fills });
    const failing = await runIntelIngest(deps, { budgetMs: 30_000 });
    expect(failing.errors).toEqual([{ stage: "journal", error: "reports down" }]);
    expect(failing.skipped).toEqual([]);
  });
});
