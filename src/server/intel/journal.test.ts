import { describe, expect, test } from "bun:test";
import type { Trade } from "../../shared/intel.js";
import type { PaperFill } from "../desk/store.js";
import type { Conversation, LLMProvider, StepResult } from "../llm/provider.js";
import fills from "./fixtures/hl-userfills.json";
import {
  deskLegs,
  enrich,
  excursions,
  hlLegs,
  journalStopFor,
  loadJournal,
  pickFindings,
  putNote,
  rMultiple,
  roundTrips,
  sessionFor,
  snapshotEntryState,
  tagStats,
  tagTrades,
  validateNarration,
  weeklyReport,
  type JournalDeps,
} from "./journal.js";
import type { LlmTier } from "./llm.js";
import { MemoryIntelStore } from "./store.js";

const NOW = new Date("2025-10-13T12:00:00Z");

/** Scripted provider: each step answers with reply(prompt) as an `emit` call. */
class EmitProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = false;
  readonly model = "fake-model";
  prompts: string[] = [];
  constructor(private readonly reply: (prompt: string) => unknown) {}
  start(_system: string, _history: unknown[], question: string): Conversation {
    this.prompts.push(question);
    const self = this;
    return {
      async step(): Promise<StepResult> {
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: self.reply(question) }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
      addToolResults() {},
    };
  }
}

function deps(over: Partial<JournalDeps> & { provider?: EmitProvider | null; store?: MemoryIntelStore } = {}): JournalDeps & { store: MemoryIntelStore } {
  const store = over.store ?? new MemoryIntelStore(() => NOW);
  const provider = over.provider === undefined ? null : over.provider;
  return {
    store,
    llm: { makeProvider: (_t: LlmTier) => provider, cache: store, now: () => NOW, dailyCap: 200 },
    now: () => NOW,
    ...over,
  } as JournalDeps & { store: MemoryIntelStore };
}

const fill = (id: number, ts: string, coin: string, side: "buy" | "sell", size: number, px: number, reason: string, pnl = 0, proposalId: string | null = null): PaperFill => ({
  id,
  ts,
  coin,
  side,
  size,
  px,
  fee: 0,
  pnl,
  reason,
  proposalId,
});

const DESK_FILLS: PaperFill[] = [
  fill(1, "2025-10-10T14:00:00Z", "ETH", "buy", 2, 3000, "entry", 0, "p1"),
  fill(2, "2025-10-10T16:00:00Z", "ETH", "sell", 1, 3100, "target", 100, "p1"),
  fill(3, "2025-10-10T18:00:00Z", "ETH", "sell", 1, 2900, "stop", -100, "p1"),
  fill(4, "2025-10-11T22:00:00Z", "SOL", "sell", 10, 150, "entry", 0, "p2"),
];

describe("round trips", () => {
  test("HL fills: scale-in, partial closes, flip, spot and junk skipped", () => {
    const { legs, skipped } = hlLegs(fills);
    expect(skipped).toBe(2); // spot "Buy" + unparsable row
    const trips = roundTrips(legs);
    expect(trips.map((t) => t.id)).toEqual(["hl:BTC:1001", "hl:ETH:2001", "hl:ETH:2002"]);

    const [btc, ethShort, ethLong] = trips;
    expect(btc).toMatchObject({ side: "long", size: 0.2, closedAt: "2025-10-05T07:00:00.000Z", openedAt: "2025-10-05T02:00:00.000Z" });
    expect(btc!.entryPx).toBeCloseTo(61000, 6);
    expect(btc!.exitPx).toBeCloseTo(63500, 6);
    expect(btc!.feesUsd).toBeCloseTo(11.205, 6);
    expect(btc!.pnlUsd).toBeCloseTo(488.795, 6);

    // Flip: 1 of the 3 closes the short (fee share 1/3), 2 open the long.
    expect(ethShort).toMatchObject({ side: "short", size: 1, entryPx: 3000, exitPx: 2900, closedAt: "2025-10-09T09:00:00.000Z" });
    expect(ethShort!.pnlUsd).toBeCloseTo(100 - 1.35 - 1.305, 6);
    expect(ethLong).toMatchObject({ side: "long", size: 2, entryPx: 2900, exitPx: 2950, closedAt: null });
    expect(ethLong!.pnlUsd).toBeCloseTo(50 - 2.61 - 1.3275, 6);
  });

  test("a flip without startPosition is skipped rather than guessed", () => {
    const { legs, skipped } = hlLegs([{ coin: "BTC", px: "1", sz: "2", time: 1, dir: "Long > Short", tid: 9 }]);
    expect(legs).toEqual([]);
    expect(skipped).toBe(1);
  });

  test("desk paper fills: entry opens, exits close, open trade stays open", () => {
    const trips = roundTrips(deskLegs(DESK_FILLS));
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ id: "desk:ETH:1", side: "long", size: 2, entryPx: 3000, exitPx: 3000, pnlUsd: 0, closedAt: "2025-10-10T18:00:00.000Z", ref: "p1" });
    expect(trips[1]).toMatchObject({ id: "desk:SOL:4", side: "short", closedAt: null });
  });
});

describe("per-trade computations", () => {
  test("session buckets by hour in INTEL_TZ", () => {
    const at = (iso: string) => new Date(iso);
    expect(sessionFor(at("2025-10-05T00:00:00Z"))).toBe("asia");
    expect(sessionFor(at("2025-10-05T07:59:00Z"))).toBe("asia");
    expect(sessionFor(at("2025-10-05T08:00:00Z"))).toBe("eu");
    expect(sessionFor(at("2025-10-05T13:00:00Z"))).toBe("us");
    expect(sessionFor(at("2025-10-05T21:00:00Z"))).toBe("off");
    // 02:00Z is 22:00 the day before in New York (EDT) and 11:00 in Tokyo.
    expect(sessionFor(at("2025-10-05T02:00:00Z"), "America/New_York")).toBe("off");
    expect(sessionFor(at("2025-10-05T02:00:00Z"), "Asia/Tokyo")).toBe("eu");
    expect(sessionFor(at("2025-10-05T02:00:00Z"), "Not/AZone")).toBe("asia");
  });

  test("R only when a stop is known and on the losing side, and only once closed", () => {
    const t = { side: "long" as const, entryPx: 100, size: 2, pnlUsd: 20, closedAt: "2025-10-05T00:00:00Z" };
    expect(rMultiple(t, 95)).toBeCloseTo(2, 9);
    expect(rMultiple(t, null)).toBeNull();
    expect(rMultiple(t, 105)).toBeNull();
    expect(rMultiple({ ...t, closedAt: null }, 95)).toBeNull();
    expect(rMultiple({ ...t, side: "short", pnlUsd: -10 }, 110)).toBeCloseTo(-0.5, 9);
  });

  test("MAE/MFE from 1h candles inside the trade window", () => {
    const t = { side: "long" as const, entryPx: 100, openedAt: "2025-10-05T02:30:00Z", closedAt: "2025-10-05T05:00:00Z" };
    const candles = [
      { ts: "2025-10-05T01:00:00Z", h: 200, l: 10 }, // before the entry hour: ignored
      { ts: "2025-10-05T02:00:00Z", h: 101, l: 98 },
      { ts: "2025-10-05T03:00:00Z", h: 105, l: 99 },
      { ts: "2025-10-05T06:00:00Z", h: 300, l: 1 }, // after the close: ignored
    ];
    expect(excursions(t, candles, NOW)).toEqual({ maePct: 2, mfePct: 5 });
    const short = excursions({ ...t, side: "short" }, candles, NOW)!;
    expect(short.maePct).toBeCloseTo(5, 9);
    expect(short.mfePct).toBeCloseTo(2, 9);
    expect(excursions(t, [], NOW)).toBeNull();
  });

  test("enrich expresses excursions in R with a stop, percent without", () => {
    const trip = roundTrips(deskLegs(DESK_FILLS))[0]!;
    const candles = [{ ts: "2025-10-10T15:00:00Z", h: 3150, l: 2950 }];
    const state = { fundingZ: 1.2, oiZ: null, change24hPct: -3 };
    const withStop = enrich(trip, { stopPx: 2900, candles, entryState: state, note: null }, NOW);
    expect(withStop).toMatchObject({ maeUnit: "r", stopPx: 2900, r: 0, session: "us", holdMs: 4 * 3_600_000, entryState: state });
    expect(withStop.mae).toBeCloseTo(0.5, 9);
    expect(withStop.mfe).toBeCloseTo(1.5, 9);
    const noStop = enrich(trip, { stopPx: null, candles, entryState: state, note: null }, NOW);
    expect(noStop).toMatchObject({ maeUnit: "pct", stopPx: null, r: null });
    expect(noStop.mfe).toBeCloseTo(5, 9);
  });
});

function mkTrade(over: Partial<Trade> = {}): Trade {
  return {
    id: "desk:BTC:1",
    venue: "desk",
    asset: "BTC",
    side: "long",
    openedAt: "2025-10-10T00:00:00.000Z",
    closedAt: "2025-10-10T02:00:00.000Z",
    size: 1,
    entryPx: 100,
    exitPx: 101,
    pnlUsd: 0,
    feesUsd: 0,
    holdMs: 7_200_000,
    session: "asia",
    stopPx: null,
    r: null,
    mae: null,
    mfe: null,
    maeUnit: "pct",
    entryState: { fundingZ: null, oiZ: null, change24hPct: null },
    tag: null,
    note: null,
    noteSummary: null,
    ...over,
  };
}

describe("tagStats", () => {
  test("win rate, R over R-known only, hold, MAE/MFE in percent, expectancy ranking", () => {
    const trades = [
      mkTrade({ id: "desk:BTC:1", tag: "breakout", pnlUsd: 100, r: 2, stopPx: 95, maeUnit: "r", mae: 0.2, mfe: 2.4, holdMs: 1000 }),
      mkTrade({ id: "desk:BTC:2", tag: "breakout", pnlUsd: -50, r: null, mae: 3, mfe: 1, holdMs: 3000 }),
      mkTrade({ id: "desk:BTC:3", tag: "breakout", pnlUsd: 10, r: 0.5, stopPx: 98, maeUnit: "r", mae: 1, mfe: 0.5, holdMs: null }),
      mkTrade({ id: "desk:ETH:4", tag: "range", pnlUsd: -10 }),
      mkTrade({ id: "desk:ETH:5", pnlUsd: 5 }),
      mkTrade({ id: "desk:ETH:6", tag: "range", pnlUsd: 999, closedAt: null }), // open: excluded
    ];
    const stats = tagStats(trades);
    expect(stats.map((s) => s.tag)).toEqual(["breakout", "untagged", "range"]);
    const b = stats[0]!;
    expect(b.trades).toBe(3);
    expect(b.winRate).toBeCloseTo(2 / 3, 9);
    expect(b.avgR).toBeCloseTo(1.25, 9);
    expect(b.expectancyR).toBeCloseTo(1.25, 9);
    expect(b.expectancyUsd).toBeCloseTo(20, 9);
    expect(b.avgHoldMs).toBe(2000);
    // MAE pct: 0.2R×5% = 1, 3, 1R×2% = 2 → mean 2. MFE: 12, 1, 1 → 14/3.
    expect(b.avgMaePct).toBeCloseTo(2, 9);
    expect(b.avgMfePct).toBeCloseTo(14 / 3, 9);
    expect(stats[2]).toMatchObject({ tag: "range", trades: 1, winRate: 0, avgR: null, avgMaePct: null, expectancyUsd: -10 });
  });

  test("pickFindings: leaks need n ≥ 3 and negative expectancy, worst first; edges best first", () => {
    const t = (id: number, tag: string, pnl: number) => mkTrade({ id: `desk:BTC:${id}`, tag, pnlUsd: pnl });
    const trades = [
      ...[1, 2, 3].map((i) => t(i, "news", -30)),
      ...[4, 5, 6].map((i) => t(i, "scalp", -10)),
      ...[7, 8].map((i) => t(i, "squeeze", -500)), // n = 2: not a finding
      ...[9, 10, 11].map((i) => t(i, "pullback", 40)),
    ];
    const { leaks, edges } = pickFindings(trades);
    expect(leaks.map((f) => f.tag)).toEqual(["news", "scalp"]);
    expect(leaks[0]).toMatchObject({ trades: 3, expectancyUsd: -30, tradeIds: ["desk:BTC:1", "desk:BTC:2", "desk:BTC:3"], line: null });
    expect(edges.map((f) => f.tag)).toEqual(["pullback"]);
  });
});

describe("loadJournal", () => {
  test("joins both sources, notes, stops, candles and entry state; reports failing sources", async () => {
    const d = deps({
      hlFills: async () => fills,
      deskFills: async () => DESK_FILLS,
      stopFor: journalStopFor({ getProposal: async (id) => (id === "p1" ? ({ kind: "open", proposal: { stop: 2900 } } as never) : null) }),
      candles: async () => {
        throw new Error("db down");
      },
      entryState: async () => ({ fundingZ: 0.5, oiZ: -1, change24hPct: 2 }),
    });
    await d.store.putTradeNote({ tradeId: "desk:ETH:1", note: "faded the pump", tag: "mean_reversion", summary: null });
    const { trades, sources } = await loadJournal(d, 30);
    expect(trades.map((t) => t.id)).toEqual(["desk:SOL:4", "desk:ETH:1", "hl:ETH:2002", "hl:ETH:2001", "hl:BTC:1001"]); // newest entry first
    const eth = trades.find((t) => t.id === "desk:ETH:1")!;
    expect(eth).toMatchObject({ stopPx: 2900, r: 0, tag: "mean_reversion", note: "faded the pump", mae: null, entryState: { fundingZ: 0.5 } });
    expect(trades.find((t) => t.id === "hl:BTC:1001")).toMatchObject({ stopPx: null, r: null, maeUnit: "pct" });
    expect(sources).toContainEqual({ source: "hl", ok: true, error: "2 fills skipped (spot or unparsed)" });
    expect(sources).toContainEqual({ source: "desk", ok: true });
    expect(sources).toContainEqual({ source: "candles", ok: false, error: "db down" });
  });

  test("window drops trades closed before it; missing sources are reported, not fatal", async () => {
    const d = deps({ hlFills: async () => fills });
    const { trades, sources } = await loadJournal(d, 5); // since 2025-10-08T12:00Z
    expect(trades.map((t) => t.id).sort()).toEqual(["hl:ETH:2001", "hl:ETH:2002"]);
    expect(sources).toContainEqual({ source: "desk", ok: false, error: "desk not configured" });
  });

  test("snapshotEntryState: level z over 7 days, 24h change from snapshots", async () => {
    const store = new MemoryIntelStore(() => NOW);
    const at = new Date("2025-10-10T00:00:00Z");
    const rows = Array.from({ length: 30 }, (_, i) => {
      const ts = new Date(at.getTime() - (29 - i) * 3_600_000).toISOString();
      return { asset: "ETH", ts, price: i === 5 ? 100 : 110, vol24h: null, funding: i === 29 ? 0.001 : 0.0001 * (i % 2), oiUsd: 1e6, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null };
    });
    await store.insertSnapshots(rows);
    const s = await snapshotEntryState(store)("ETH", at);
    expect(s.fundingZ).toBeGreaterThan(3);
    expect(s.oiZ).toBeNull(); // σ = 0
    expect(s.change24hPct).toBeCloseTo(10, 9);
  });
});

describe("tagging", () => {
  test("tags untagged trades once (cached), keeps the note, drops an invalid summary", async () => {
    const provider = new EmitProvider(() => ({ setup: "breakout", noteSummary: { tag: "hypothesis", text: "Chased a breakout." } }));
    const d = deps({ provider });
    await putNote(d.store, "desk:BTC:1", "chased it");
    const trades = [mkTrade({ id: "desk:BTC:1", note: "chased it" }), mkTrade({ id: "desk:BTC:2" }), mkTrade({ id: "desk:BTC:3", tag: "range" })];
    expect(await tagTrades(d, trades)).toEqual({ tagged: 2, failed: 0 });
    const [n1, n2] = await d.store.tradeNotes(["desk:BTC:1", "desk:BTC:2"]);
    expect(n1).toMatchObject({ tag: "breakout", note: "chased it", summary: { tag: "hypothesis", text: "Chased a breakout." } });
    expect(n2).toMatchObject({ tag: "breakout", note: null, summary: null });
    expect(provider.prompts).toHaveLength(2);

    const bad = new EmitProvider(() => ({ setup: "range", noteSummary: { tag: "observed", text: "no source" } }));
    const d2 = deps({ provider: bad });
    await putNote(d2.store, "desk:BTC:9", "note");
    await tagTrades(d2, [mkTrade({ id: "desk:BTC:9", note: "note" })]);
    expect((await d2.store.tradeNotes(["desk:BTC:9"]))[0]).toMatchObject({ tag: "range", summary: null });
  });

  test("a setup outside the vocabulary fails closed and is counted", async () => {
    const d = deps({ provider: new EmitProvider(() => ({ setup: "vibes", noteSummary: null })) });
    const res = await tagTrades(d, [mkTrade()]);
    expect(res.tagged).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.error).toContain("invalid output");
  });

  test("putNote keeps the tag and clears the stale summary", async () => {
    const store = new MemoryIntelStore(() => NOW);
    await store.putTradeNote({ tradeId: "hl:BTC:1", note: "old", tag: "news", summary: { tag: "hypothesis", text: "x" } });
    expect(await putNote(store, "hl:BTC:1", "  new  ")).toMatchObject({ note: "new", tag: "news", summary: null });
    expect(await putNote(store, "hl:BTC:1", "")).toMatchObject({ note: null, tag: "news" });
  });
});

describe("weekly report", () => {
  const losing = [1, 2, 3, 4, 5, 6].map((i) => fill(i, `2025-10-1${i < 4 ? 0 : 1}T0${i}:00:00Z`, "BTC", i % 2 ? "buy" : "sell", 1, 100, i % 2 ? "entry" : "stop", i % 2 ? 0 : -10));
  const winning = [7, 8, 9, 10, 11, 12].map((i) => fill(i, `2025-10-12T${String(i).padStart(2, "0")}:00:00Z`, "ETH", i % 2 ? "buy" : "sell", 1, 100, i % 2 ? "entry" : "target", i % 2 ? 0 : 30));

  test("narration keeps only lines citing the finding's own ids", () => {
    const findings = [
      { tag: "news", tradeIds: ["desk:BTC:1", "desk:BTC:3"], trades: 3, expectancyUsd: -10, expectancyR: null, line: null },
      { tag: "pullback", tradeIds: ["desk:ETH:7"], trades: 3, expectancyUsd: 30, expectancyR: null, line: null },
    ];
    const h = (text: string) => ({ tag: "hypothesis", text });
    const { lines, byTag, dropped } = validateNarration(
      [
        { tag: "news", tradeIds: ["desk:BTC:1"], claim: h("News trades bled (desk:BTC:1, desk:BTC:3).") },
        { tag: "news", tradeIds: ["desk:BTC:99"], claim: h("Unknown id.") },
        { tag: "news", tradeIds: ["desk:ETH:7"], claim: h("Another finding's id.") },
        { tag: "news", tradeIds: ["desk:BTC:1"], claim: h("Mentions desk:BTC:42 in text.") },
        { tag: "news", tradeIds: [], claim: h("Cites nothing.") },
        { tag: "made_up", tradeIds: ["desk:BTC:1"], claim: h("Unknown tag.") },
        { tag: "pullback", tradeIds: ["desk:ETH:7"], claim: { tag: "observed", text: "No ts." } },
      ],
      findings,
    );
    expect(lines).toEqual([h("News trades bled (desk:BTC:1, desk:BTC:3).")] as never);
    expect(byTag.get("news")).toHaveLength(1);
    expect(dropped).toBe(6);
  });

  test("code picks findings, LLM narrates, unknown ids are dropped, report stored with trace", async () => {
    const provider = new EmitProvider(() => ({
      lines: [
        { tag: "news", tradeIds: ["desk:BTC:1", "desk:BTC:5"], claim: { tag: "observed", text: "News setups lost $10 per trade over 3 trades.", source: { label: "journal", url: "/journal" }, ts: NOW.toISOString() } },
        { tag: "news", tradeIds: ["desk:BTC:77"], claim: { tag: "hypothesis", text: "Invented." } },
        { tag: "pullback", tradeIds: ["desk:ETH:7"], claim: { tag: "hypothesis", text: "Pullbacks may suit this operator." } },
      ],
    }));
    const d = deps({ provider, deskFills: async () => [...losing, ...winning] });
    for (const id of [1, 3, 5]) await d.store.putTradeNote({ tradeId: `desk:BTC:${id}`, note: null, tag: "news", summary: null });
    for (const id of [7, 9, 11]) await d.store.putTradeNote({ tradeId: `desk:ETH:${id}`, note: null, tag: "pullback", summary: null });

    const report = await weeklyReport(d, 7);
    expect(report.kind).toBe("journal_weekly");
    expect(report.leaks).toHaveLength(1);
    expect(report.leaks[0]).toMatchObject({ tag: "news", trades: 3, expectancyUsd: -10, tradeIds: ["desk:BTC:5", "desk:BTC:3", "desk:BTC:1"] });
    expect(report.leaks[0]!.line?.text).toContain("News setups lost");
    expect(report.edges[0]).toMatchObject({ tag: "pullback", expectancyUsd: 30 });
    expect(report.lines).toHaveLength(2);
    expect(report.trace).toMatchObject({ tier: "strong", dropped: 1 });
    expect(provider.prompts[0]).toContain("desk:BTC:1");
    expect(await d.store.latestReport("journal_weekly")).toMatchObject({ id: report.id });
  });

  test("without a provider the code findings are still stored, with no lines", async () => {
    const d = deps({ deskFills: async () => losing });
    for (const id of [1, 3, 5]) await d.store.putTradeNote({ tradeId: `desk:BTC:${id}`, note: null, tag: "news", summary: null });
    const report = await weeklyReport(d, 7);
    expect(report.leaks.map((f) => f.tag)).toEqual(["news"]);
    expect(report.lines).toEqual([]);
    expect(report.trace).toMatchObject({ error: "llm not configured" });
  });
});
