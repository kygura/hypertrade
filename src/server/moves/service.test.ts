import { describe, expect, test } from "bun:test";
import type { IntelEvent } from "../../shared/intel.js";
import { MoveDetailSchema, MovesResponseSchema } from "../../shared/moves.js";
import { SectorsDataSchema } from "../../shared/schemas.js";
import type { AssetCtx, Candle } from "../../shared/types.js";
import type { PlatformContext } from "../platform/context.js";
import { memoSeries } from "../platform/replaySource.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { CANDLE_BARS, HOUR_MS } from "./constants.js";
import { FIXTURE_SECTORS, fixtureSet } from "./fixtures/series.js";
import { asOfHour, createMovesService, movesUniverse, UnknownCoinError, type MovesDeps } from "./service.js";
import { candidateOf } from "./triage.js";

const fx = fixtureSet();
const COINS = Object.keys(fx.candles);
const ctx = (name: string, i: number): AssetCtx => ({
  name, szDecimals: 2, markPx: fx.candles[name]!.at(-1)!.c, oraclePx: 1, midPx: 1, dayNtlVlm: 1e9 - i * 1e6, prevDayPx: 1, openInterest: 1e6, funding: 0.00001, premium: 0.0001, dayChange: 0, isDelisted: false,
});
const CTXS = [...COINS.map(ctx), { ...ctx("BTC", 99), name: "xyz:TSLA" }, { ...ctx("BTC", 99), name: "DEAD", isDelisted: true }];

function setup(o: Partial<MovesDeps> & { gate?: Promise<void>; failing?: Set<string> } = {}) {
  let now = fx.asOf + 5 * 60_000;
  const calls: Array<{ coin: string; start: number }> = [];
  const raw = async (coin: string, start: number, end: number): Promise<Candle[]> => {
    calls.push({ coin, start });
    if (o.gate) await o.gate;
    if (o.failing?.has(coin)) throw new Error("HL 500");
    return (fx.candles[coin] ?? []).filter((c) => c.t >= start && c.t <= end);
  };
  const deps: MovesDeps = {
    candles: memoSeries(raw),
    funding: async () => [],
    ctxs: async () => CTXS,
    platform: () => null,
    intel: () => null,
    social: async () => new Map(),
    stages: async () => new Map(),
    sectors: () => SectorsDataSchema.parse(FIXTURE_SECTORS),
    now: () => now,
    serverless: false,
    mine: ["COIN", "NOPE"],
    waitMs: 5,
    ...o,
  };
  return { svc: createMovesService(deps), calls, tick: (ms: number) => void (now += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("movesUniverse", () => {
  test("majors first, then volume, then my markets; HIP-3 and delisted out; the cap drops and names", () => {
    const u = movesUniverse(CTXS, ["COIN", "NOPE"], 4);
    expect(u.coins).toEqual(["BTC", "ETH", "COIN", "P1"]);
    expect(u.dropped).toEqual([{ coin: "NOPE", reason: "not a listed main-dex perp" }, ...["P2", "P3", "P4"].map((coin) => ({ coin, reason: "beyond the 4-coin cap" }))]);
  });

  test("asOf is the last closed hour, turning 2 min after the close", () => {
    expect(asOfHour(fx.asOf + 60_000)).toBe(fx.asOf - HOUR_MS);
    expect(asOfHour(fx.asOf + 3 * 60_000)).toBe(fx.asOf);
  });
});

describe("createMovesService", () => {
  test("pending with progress, then ok; layers say why without a scanner or a database; the planted shock tops the residual", async () => {
    let open!: () => void;
    const s = setup({ gate: new Promise<void>((r) => (open = r)) });
    const first = MovesResponseSchema.parse(await s.svc.universe("24h"));
    expect(first).toMatchObject({ state: "pending", progress: { total: 7 }, rows: [] });
    open();
    await flush();
    const r = MovesResponseSchema.parse(await s.svc.universe("24h"));
    expect(r.state).toBe("ok");
    expect(r.asOf).toBe(new Date(fx.asOf).toISOString());
    expect(r.universe).toEqual({ coins: 7, dropped: [{ coin: "NOPE", reason: "not a listed main-dex perp" }] });
    expect(r.layers).toMatchObject({
      beta: { state: "ok" },
      flow: { state: "unavailable", reason: "needs the always-on scanner (OI snapshots)" },
      attention: { state: "unavailable", reason: "needs a database (news and Elfa are stored)" },
      liq: { state: "unavailable", reason: "needs the always-on scanner and crawler" },
    });
    const top = [...r.rows].sort((a, b) => Math.abs(b.attribution?.residualZ ?? 0) - Math.abs(a.attribution?.residualZ ?? 0))[0]!;
    expect(top.coin).toBe("COIN");
    expect(top.attribution!.residualPct).toBeGreaterThan(4);
    expect(top.sector).toEqual({ id: "alt", label: "Alt basket" });
    expect(top.attention.news24h).toBeNull();
    expect(top.positioning.oiChg24hPct).toBeNull();
    expect(top.setups.map((x) => x.kind)).toEqual(["enter", "fade"]);
    expect(r.factors.map((f) => f.id)).toEqual(["BTC", "ETH", "ETHX", "sector:alt"]);
    expect(r.factors.find((f) => f.id === "sector:alt")!.n).toBe(5); // COIN and its four peers, ex-majors
  });

  test("weight: one candle call per coin per closed hour; the second run in the same hour makes none", async () => {
    const s = setup();
    await s.svc.universe("24h");
    await flush();
    expect((await s.svc.universe("24h")).state).toBe("ok");
    expect(s.calls).toHaveLength(7);
    expect(s.calls[0]!.start).toBe(fx.asOf - (CANDLE_BARS + 1) * HOUR_MS);
    await s.svc.universe("4h");
    await s.svc.universe("72h");
    expect(s.calls).toHaveLength(7);
    s.tick(HOUR_MS);
    await s.svc.universe("24h");
    await flush();
    expect((await s.svc.universe("24h")).asOf).toBe(new Date(fx.asOf + HOUR_MS).toISOString());
    expect(s.calls).toHaveLength(14);
    // Incremental: the next hour's fetch starts at the newest cached bar, not 10 days back.
    expect(s.calls.slice(7).every((c) => c.start === fx.asOf - HOUR_MS)).toBe(true);
  });

  test("the previous hour is served while the next hour's run loads", async () => {
    let open: () => void = () => {};
    let gate: Promise<void> | undefined;
    const g = setup({ candles: async (coin, a, b) => (gate && (await gate), (fx.candles[coin] ?? []).filter((c) => c.t >= a && c.t <= b)) });
    await g.svc.universe("24h");
    await flush();
    gate = new Promise<void>((r) => (open = r));
    g.tick(HOUR_MS);
    const stale = MovesResponseSchema.parse(await g.svc.universe("4h"));
    expect(stale).toMatchObject({ state: "ok", asOf: new Date(fx.asOf).toISOString() });
    open();
  });

  test("a run that loads under half the coins fails (retried), never a table of nothing", async () => {
    const s = setup({ failing: new Set(["COIN", "P1", "P2", "P3", "P4"]) });
    await s.svc.universe("24h");
    await flush();
    const r = MovesResponseSchema.parse(await s.svc.universe("24h"));
    expect(r).toMatchObject({ state: "unavailable", rows: [] });
    expect(r.reason).toContain("moves run failed");
  });

  test("serverless: the table is unavailable and starts nothing; the single-coin detail still runs inline", async () => {
    const s = setup({ serverless: true });
    const r = MovesResponseSchema.parse(await s.svc.universe("24h"));
    expect(r).toMatchObject({ state: "unavailable", reason: "needs the always-on server; or run `bun run moves`" });
    expect(s.calls).toHaveLength(0);
    const d = MoveDetailSchema.parse(await s.svc.coin("coin", "24h"));
    expect(d).toMatchObject({ state: "ok", coin: "COIN", record: null });
    expect(new Set(s.calls.map((c) => c.coin))).toEqual(new Set(["COIN", "BTC", "ETH", "P1", "P2", "P3", "P4"]));
    expect(d.series).toHaveLength(24);
    await expect(s.svc.coin("NOPE", "24h")).rejects.toBeInstanceOf(UnknownCoinError);
  });

  test("with a scanner, crawler and news: flow hours, funding z, OI changes, liquidation clusters, headlines", async () => {
    const store = new MemoryPlatformStore();
    const bars = Array.from({ length: 400 }, (_, i) => fx.asOf - (400 - i) * HOUR_MS);
    await store.insertScanSnapshots(bars.flatMap((t, i) => ["COIN", "BTC", "ETH"].map((coin) => ({
      coin, ts: new Date(t + HOUR_MS - 60_000).toISOString(),
      inputs: { mark: 10, oiUsd: 1e8 * (1 + 0.004 * Math.sin(i * 1.3)) * (t >= fx.shockAt ? 0.8 : 1), funding: 0.00001 + 1e-6 * Math.sin(i), dayNtlVlm: 1e9 },
    }))));
    const mark = fx.candles.COIN!.at(-1)!.c;
    await store.savePoll(`0x${"a".repeat(40)}`, new Date(fx.asOf).toISOString(), [{ coin: "COIN", szi: 1e6, entryPx: mark, positionValue: 2e6, liquidationPx: mark * 0.97, leverage: 10 }]);
    const platform = { store } as unknown as PlatformContext;
    const event = { id: "e1", key: "k", clusterId: null, type: "news", title: "COIN listing", summary: null, entities: [], assets: ["coin"], magnitude: "high", sources: [{ url: "https://x.example/a" }], origin: "rss", firstSeen: new Date(fx.shockAt + 10 * 60_000).toISOString(), scheduledAt: null, catalyst: null, tag: "observed" } as unknown as IntelEvent;
    const s = setup({ platform: () => platform, intel: () => ({ listEvents: async () => [event] }) });
    const d = MoveDetailSchema.parse(await s.svc.coin("COIN", "24h"));
    expect(d.layers.flow).toEqual({ state: "ok", reason: null });
    expect(d.attribution!.flowHours).toBe(1);
    expect(d.attribution!.residualFlowPct!).toBeGreaterThan(4);
    expect(d.attribution!.newsHours).toBe(2); // the shocked hour is flow (precedence); the next two are news
    expect(d.positioning.fundingN).toBe(336);
    expect(d.positioning.fundingZ).not.toBeNull();
    expect(d.positioning.oiChg24hPct).not.toBeNull();
    expect(d.liq.state.state).toBe("ok");
    expect(d.liq.nearestLong).not.toBeNull();
    expect(d.liq.longSigmas!).toBeGreaterThan(0);
    expect(d.attention).toMatchObject({ state: { state: "ok" }, news24h: 1 });
    expect(d.headlines).toEqual([{ title: "COIN listing", firstSeen: event.firstSeen, url: "https://x.example/a", assets: ["COIN"] }]);
  });

  test("a database whose news feed was never ingested: news is unknown, never `no news in window`", async () => {
    const now = fx.asOf + 5 * 60_000;
    const ev = (origin: string, ageMs: number, assets = ["ZZZ"]) =>
      ({ id: `e-${origin}-${ageMs}`, key: `k-${origin}-${ageMs}`, clusterId: null, type: "news", title: "x", summary: null, entities: [], assets, magnitude: "low", sources: [], origin, firstSeen: new Date(now - ageMs).toISOString(), scheduledAt: null, catalyst: null, tag: "observed" }) as unknown as IntelEvent;
    const feeds: Array<[string, IntelEvent[]]> = [
      ["empty table", []],
      ["silent feed (newest event 30 h old)", [ev("rss", 30 * HOUR_MS)]],
      ["flow and manual events only", [ev("flow", HOUR_MS), ev("manual", HOUR_MS)]],
    ];
    for (const [what, events] of feeds) {
      const d = MoveDetailSchema.parse(await setup({ intel: () => ({ listEvents: async () => events }) }).svc.coin("COIN", "24h"));
      const reason = "news feed not ingested (no news event in the last 24 h)";
      expect({ what, layer: d.layers.attention, state: d.attention.state }).toEqual({ what, layer: { state: "unavailable", reason }, state: { state: "unavailable", reason } });
      expect({ what, newsHours: d.attribution!.newsHours, residualNewsPct: d.attribution!.residualNewsPct, news24h: d.attention.news24h }).toEqual({ what, newsHours: null, residualNewsPct: null, news24h: null });
      // The ENTER/FADE attention checks are unevaluable (null), not "not met".
      const check = (kind: string, key: string) => d.setups.find((s) => s.kind === kind)!.checks.find((c) => c.key === key)!.met;
      expect({ what, enter: check("enter", "attention_rising"), fade: check("fade", "attention_saturated") }).toEqual({ what, enter: null, fade: null });
      expect(candidateOf({ ...d, attribution: { ...d.attribution!, residualZ: 4 } })!.reason).toEndWith("· 24h · news unknown");
    }
    // A feed that is ingesting (any feed event in the last 24 h) makes "no news" a known fact for a coin it never named.
    const live = MoveDetailSchema.parse(await setup({ intel: () => ({ listEvents: async () => [ev("rss", 2 * HOUR_MS)] }) }).svc.coin("COIN", "24h"));
    expect(live.layers.attention).toEqual({ state: "ok", reason: null });
    expect([live.attribution!.newsHours, live.attribution!.residualNewsPct, live.attention.news24h]).toEqual([0, 0, 0]);
    expect(candidateOf({ ...live, attribution: { ...live.attribution!, residualZ: 4 } })!.reason).toEndWith("· 24h · no news in window");
  });
});
