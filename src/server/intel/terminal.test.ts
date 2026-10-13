import { describe, expect, test } from "bun:test";
import type { ExposurePosition } from "../../shared/intel.js";
import type { AssetCtx } from "../../shared/types.js";
import type { Notifier } from "../desk/notify.js";
import type { Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import { formatIntel, sendIntel } from "./notify.js";
import { MemoryIntelStore, type NewAlert } from "./store.js";
import { buildBrief, FALLBACK_BASELINE_MS, itemLine, loadThresholds, runIntelBrief, type TerminalDeps } from "./terminal.js";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 13, 12);
const iso = (t: number) => new Date(t).toISOString();

/** Scripted provider: one reply per step; counts steps. */
class FakeProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = false;
  readonly model = "fake-strong";
  steps = 0;
  constructor(private readonly replies: Array<{ text?: string; emit?: unknown }>) {}
  start(): Conversation {
    const self = this;
    return {
      async step(_tools, hooks): Promise<StepResult> {
        self.steps++;
        const r = self.replies.shift() ?? { text: "" };
        if (r.text) hooks.onText(r.text);
        const toolCalls = r.emit === undefined ? [] : [{ id: "t1", name: "emit", input: r.emit }];
        return { stop: toolCalls.length ? "tool_use" : "end", toolCalls, usage: { input_tokens: 10, output_tokens: 5 } };
      },
      addToolResults() {},
    };
  }
}

function ctx(name: string, markPx: number): AssetCtx {
  return { name, szDecimals: 2, markPx, oraclePx: markPx, midPx: markPx, dayNtlVlm: 1e6, prevDayPx: markPx, openInterest: 10, funding: 1e-5, premium: 0, dayChange: 0, isDelisted: false };
}

/** 48 hourly SOL snapshots to NOW−1h, price log steps ±1%; nothing else recorded. Returns the price at NOW−4h. */
async function seed(store: MemoryIntelStore): Promise<number> {
  let p = 100;
  const rows = Array.from({ length: 48 }, (_, i) => {
    const r = { asset: "SOL", ts: iso(NOW - (48 - i) * H), price: p, vol24h: null, funding: null, oiUsd: null, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null };
    p *= Math.exp(i % 2 === 0 ? 0.01 : -0.01);
    return r;
  });
  await store.insertSnapshots(rows);
  return rows.find((r) => r.ts === iso(NOW - 4 * H))!.price;
}

const position: ExposurePosition = { id: "p1", source: "manual", asset: "SOL", side: "long", size: 10, entryPx: 90, markPx: 100, stopPx: null, leverage: 1, venue: "manual", notionalUsd: 1000, unrealizedPnl: 100 };

function harness(o: { price: (base: number) => number; replies?: Array<{ text?: string; emit?: unknown }> }) {
  const clock = { t: NOW };
  const store = new MemoryIntelStore(() => new Date(clock.t));
  const provider = new FakeProvider(o.replies ?? []);
  let base = 100;
  const deps: TerminalDeps = {
    store,
    exposure: async () => ({ positions: [position], sources: [], totalNotionalUsd: 1000 }),
    watched: async () => ["SOL", "BTC"],
    ctxs: async () => [ctx("SOL", o.price(base)), ctx("BTC", 60_000)],
    candles1h: async () => [],
    observations: async () => [],
    funding: async () => [],
    ingestHealth: async () => [{ source: "rss", ok: true, lastRunAt: iso(NOW - 600_000) }],
    llm: { makeProvider: () => provider, cache: store, now: () => new Date(NOW), dailyCap: 200 },
    thresholds: { minZ: 2, topK: 5, pushMateriality: 0.35 },
    now: () => new Date(NOW),
  };
  return {
    store,
    provider,
    deps,
    clock,
    async init() {
      base = await seed(store);
      return base;
    },
  };
}

const alert = (asset: string, route: "push" | "batch"): NewAlert => ({
  kind: "mapper",
  ref: `cluster-${asset}-${route}`,
  window: null,
  asset,
  title: `${asset} exploit headline`,
  eventType: "exploit",
  line: { tag: "hypothesis", text: `Long ${asset}: exposure via collateral.` },
  path: [],
  edgeType: "direct",
  hops: 1,
  pathWeight: 1,
  sources: [{ label: "rss", url: "https://news.example.com/a" }],
  materiality: 0.2,
  pricedIn: null,
  route,
});

const good = {
  lines: [
    { tag: "observed", text: "SOL mark up 10.5% since your last look.", source: { label: "snapshot", url: "/markets/SOL" }, ts: iso(NOW) },
    { tag: "observed", text: "No timestamp, so this line is dropped.", source: { label: "snapshot" } },
    { tag: "hypothesis", text: "Long SOL: the move is large for its recent volatility." },
  ],
};

describe("buildBrief", () => {
  test("silent path: nothing cleared, no LLM call, review still logged for ui", async () => {
    const h = harness({ price: (b) => b });
    await h.init();
    h.clock.t = NOW - 4 * H;
    await h.store.logReview({ via: "ui" });
    h.clock.t = NOW;
    const brief = await buildBrief(h.deps, { surface: "ui" });
    expect(brief).toMatchObject({ surface: "ui", since: iso(NOW - 4 * H), silent: true, items: [], lines: [], threshold: { minZ: 2, pushMateriality: 0.35 } });
    expect(brief.diffedCount).toBe(1); // SOL price had a z (0); BTC has no snapshots
    expect(brief.trace).toBeUndefined();
    expect(brief.ingest).toEqual([{ source: "rss", ok: true, lastRunAt: iso(NOW - 600_000) }]);
    expect(h.provider.steps).toBe(0);
    expect(h.store.reviews.map((r) => [r.via, r.briefId])).toEqual([
      ["ui", null],
      ["ui", brief.id],
    ]);
  });

  test("baseline is the latest snapshot at or before the review, the first after only when none precedes it", async () => {
    const h = harness({ price: (b) => b * Math.exp(0.1), replies: [{ emit: good }, { emit: good }] });
    await h.init();
    h.clock.t = NOW - 4.4 * H; // nearer to the NOW−4h snapshot, but that one is after the review
    await h.store.logReview({ via: "ui" });
    h.clock.t = NOW;
    expect((await buildBrief(h.deps, { surface: "ui" })).items[0]).toMatchObject({ asset: "SOL", metric: "price", baselineTs: iso(NOW - 5 * H) });

    const early = harness({ price: (b) => b * Math.exp(0.2), replies: [{ emit: good }] });
    await early.init();
    early.clock.t = NOW - 60 * H; // before every snapshot
    await early.store.logReview({ via: "ui" });
    early.clock.t = NOW;
    expect((await buildBrief(early.deps, { surface: "ui" })).items[0]).toMatchObject({ asset: "SOL", baselineTs: iso(NOW - 48 * H) });
  });

  test("ranked items, merged alerts and catalysts, validated narration", async () => {
    const h = harness({ price: (b) => b * Math.exp(0.1), replies: [{ emit: good }] });
    await h.init();
    h.clock.t = NOW - 5 * H;
    await h.store.insertAlert(alert("SOL", "batch")); // before the baseline: left out
    h.clock.t = NOW - 4 * H;
    await h.store.logReview({ via: "deeplink" });
    h.clock.t = NOW - H;
    await h.store.insertAlert({ ...alert("SOL", "batch"), ref: "later" });
    await h.store.insertAlert(alert("SOL", "push"));
    await h.store.insertAlert(alert("DOGE", "batch"));
    const ev = (key: string, assets: string[], at: number) => ({
      key, type: "unlock" as const, title: `${key} unlock`, summary: null, entities: assets, assets, magnitude: "med" as const,
      sources: [{ label: "calendar" }], origin: "manual" as const, firstSeen: iso(NOW - H), scheduledAt: iso(at), catalyst: null, tag: "observed" as const,
    });
    await h.store.upsertEvents([ev("soon", ["SOL", "ARB"], NOW + 3 * H), ev("later", ["SOL"], NOW + 30 * H), ev("other", ["DOGE"], NOW + 2 * H)]);
    h.clock.t = NOW;

    const brief = await buildBrief(h.deps, { surface: "ui", via: "deeplink" });
    expect(brief.silent).toBe(false);
    expect(brief.items).toHaveLength(1);
    expect(brief.items[0]).toMatchObject({ asset: "SOL", metric: "price", held: true, exposureWeight: 1, stopProximity: 1, baselineTs: iso(NOW - 4 * H) });
    expect(brief.items[0]!.z).toBeGreaterThan(4);
    expect(brief.alerts.map((a) => [a.asset, a.ref])).toEqual([["SOL", "later"]]);
    expect(brief.catalysts.map((c) => [c.title, c.exposed])).toEqual([["soon unlock", ["SOL"]]]);
    expect(brief.lines.map((l) => l.tag)).toEqual(["observed", "hypothesis"]);
    expect(brief.trace).toMatchObject({ tier: "strong", model: "fake-strong", dropped: 1, promptVersion: "terminal-brief-v1" });
    expect(h.provider.steps).toBe(1);
    expect(h.store.reviews.at(-1)).toMatchObject({ via: "deeplink", briefId: brief.id });
    expect(await h.store.latestBrief()).toEqual(brief);
  });

  test("LLM failure: brief stored with lines [] and trace.error, table intact", async () => {
    const h = harness({ price: (b) => b * Math.exp(0.1), replies: [{ text: "no json" }, { text: "still none" }] });
    await h.init();
    const brief = await buildBrief(h.deps, { surface: "ui" });
    expect(brief.items).toHaveLength(1);
    expect(brief.lines).toEqual([]);
    expect(brief.trace?.error).toContain("invalid output after retry");
    expect(h.store.briefs).toHaveLength(1);
  });

  test("brief hook: runs with the brief when items cleared; skipped when silent; a failing hook never fails the brief", async () => {
    const seen: string[][] = [];
    const h = harness({ price: (b) => b * Math.exp(0.1), replies: [{ text: "no json" }, { text: "still none" }] });
    await h.init();
    h.deps.onBrief = async (b) => void seen.push(b.items.map((i) => i.asset));
    await buildBrief(h.deps, { surface: "cron" });
    expect(seen).toEqual([["SOL"]]);
    h.deps.onBrief = async () => Promise.reject(new Error("thesis store down"));
    const brief = await buildBrief(h.deps, { surface: "ui" });
    expect(brief.items).toHaveLength(1);
    expect(h.store.reviews.at(-1)).toMatchObject({ briefId: brief.id });

    const quiet = harness({ price: (b) => b });
    await quiet.init();
    quiet.deps.onBrief = async () => void seen.push(["called"]);
    await buildBrief(quiet.deps, { surface: "ui" });
    expect(seen).toEqual([["SOL"]]);
  });

  test("a batched alert alone breaks the silence", async () => {
    const h = harness({ price: (b) => b, replies: [{ emit: { lines: [{ tag: "hypothesis", text: "Long SOL: an exploit headline maps to it." }] } }] });
    await h.init();
    h.clock.t = NOW - H;
    await h.store.insertAlert(alert("SOL", "batch"));
    h.clock.t = NOW;
    const brief = await buildBrief(h.deps, { surface: "ui" });
    expect(brief).toMatchObject({ silent: false, items: [] });
    expect(brief.alerts).toHaveLength(1);
    expect(h.provider.steps).toBe(1);
  });

  test("cron: baseline is the previous cron brief (6 h fallback); never logs a review", async () => {
    const h = harness({ price: (b) => b });
    await h.init();
    await h.store.logReview({ via: "ui" });
    const first = await buildBrief(h.deps, { surface: "cron" });
    expect(first.since).toBe(iso(NOW - FALLBACK_BASELINE_MS));
    h.clock.t = NOW - 2 * H;
    await h.store.insertBrief({ ...first, surface: "cron" });
    h.clock.t = NOW;
    const second = await buildBrief(h.deps, { surface: "cron" });
    expect(second.since).toBe(iso(NOW - 2 * H));
    expect(h.store.reviews).toHaveLength(1);
  });

  test("ui without any review falls back to 6 h", async () => {
    const h = harness({ price: (b) => b });
    await h.init();
    expect((await buildBrief(h.deps, { surface: "ui" })).since).toBe(iso(NOW - FALLBACK_BASELINE_MS));
  });
});

describe("runIntelBrief", () => {
  const notifier = () => {
    const sent: Array<{ title: string; body: string }> = [];
    const n: Notifier = { channels: ["telegram"], send: async (a) => (sent.push({ title: a.title, body: a.body }), ["telegram"]) };
    return { n, sent };
  };

  test("sends 'N things changed' with the top lines and a review link; nothing when silent", async () => {
    const h = harness({ price: (b) => b * Math.exp(0.1), replies: [{ emit: good }] });
    await h.init();
    const { n, sent } = notifier();
    const res = await runIntelBrief({ ...h.deps, notifier: n, appUrl: "https://app.example.com/" }, { budgetMs: 10_000 });
    expect(res).toMatchObject({ ok: true, silent: false, items: 1, alerts: 0, sent: ["telegram"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe("1 thing changed that touches your positions");
    expect(sent[0]!.body).toContain("SOL mark up 10.5% since your last look. (snapshot)");
    expect(sent[0]!.body).toContain("[hypothesis] Long SOL");
    expect(sent[0]!.body.endsWith("https://app.example.com/?review=1")).toBe(true);
    expect(h.store.reviews).toHaveLength(0);

    const quiet = harness({ price: (b) => b });
    await quiet.init();
    const q = notifier();
    expect(await runIntelBrief({ ...quiet.deps, notifier: q.n }, { budgetMs: 10_000 })).toMatchObject({ ok: true, silent: true, sent: [] });
    expect(q.sent).toEqual([]);
  });

  test("narration failed: code-written lines go out instead", async () => {
    const h = harness({ price: (b) => b * Math.exp(0.1), replies: [] });
    await h.init();
    const { n, sent } = notifier();
    const res = await runIntelBrief({ ...h.deps, notifier: n }, { budgetMs: 10_000 });
    expect(res.narrationError).toContain("invalid output");
    expect(sent[0]!.body).toMatch(/^• held SOL price \+10\.\d\d% \(z \+\d+\.\d\d\)$/);
  });

  test("a brief that cannot be built is an error result", async () => {
    const h = harness({ price: (b) => b });
    const res = await runIntelBrief({ ...h.deps, ctxs: async () => Promise.reject(new Error("HL 502")), notifier: notifier().n }, { budgetMs: 10_000 });
    expect(res).toEqual({ ok: false, error: "HL 502" });
  });
});

describe("helpers", () => {
  test("loadThresholds: defaults, env overrides, clamped", () => {
    expect(loadThresholds({})).toEqual({ minZ: 2, topK: 5, pushMateriality: 0.35 });
    expect(loadThresholds({ INTEL_MIN_Z: "2.5", INTEL_TOP_K: "99", INTEL_PUSH_MATERIALITY: "x" })).toEqual({ minZ: 2.5, topK: 20, pushMateriality: 0.35 });
  });
  test("itemLine and formatIntel", () => {
    expect(itemLine({ asset: "ETH", metric: "funding", held: false, delta: -0.5, deltaUnit: "bps", z: -2.25 } as never)).toBe("watched ETH funding -0.50 bps (z -2.25)");
    expect(formatIntel({ lines: ["a", { tag: "hypothesis", text: "b" }, { tag: "observed", text: "c", source: { label: "rss" }, ts: iso(NOW) }], link: "https://x.example.com" })).toBe(
      "• a\n• [hypothesis] b\n• c (rss)\n\nhttps://x.example.com",
    );
  });
  test("sendIntel skips an unconfigured notifier", async () => {
    let called = false;
    expect(await sendIntel({ channels: [], send: async () => ((called = true), []) }, { title: "t", lines: [] })).toEqual([]);
    expect(called).toBe(false);
  });
});
