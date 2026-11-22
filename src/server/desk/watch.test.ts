import { describe, expect, test } from "bun:test";
import { changeOver, evaluateTriggers } from "./triggers.js";
import { tick, WATCH_KEY, type WatchState } from "./watch.js";
import { MemoryIntelStore } from "../intel/store.js";
import { watchedAssets } from "../intel/positions.js";
import { MemoryLlmCache } from "../routine/llm.js";
import { ctx, makeService, ScriptedProvider } from "./testkit.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-05T12:00:00Z");
const flatAccount = { venue: "paper", equityUsd: 10_000, dayPnlUsd: 0, positions: [], available: true };

describe("changeOver", () => {
  test("measures from the last mark at or before the horizon", () => {
    const h: Array<[number, number]> = [
      [NOW - 2 * HOUR, 100],
      [NOW - HOUR, 102],
      [NOW, 105],
    ];
    expect(changeOver(h, NOW, HOUR)).toBeCloseTo((105 / 102 - 1) * 100, 6);
    expect(changeOver(h, NOW, 4 * HOUR)).toBeNull(); // history too short
  });
});

describe("evaluateTriggers", () => {
  test("fast moves, funding extremes, OI surges, positions near stop", () => {
    const marks = { BTC: [[NOW - HOUR, 100_000], [NOW, 103_000]] as Array<[number, number]>, ETH: [[NOW - HOUR, 4000], [NOW, 4010]] as Array<[number, number]> };
    const ctxs = [ctx("BTC", 103_000), ctx("ETH", 4010, { funding: 0.0001 })]; // 87.6% APR
    const pos = { coin: "ETH", side: "long" as const, size: 1, entryPx: 4100, markPx: 4010, stopPx: 3990, tpPx: 4500, unrealizedPnl: -90, notionalUsd: 4010 };
    const t = evaluateTriggers({ now: NOW, coins: ["BTC", "ETH"], ctxs, marks, oiChange4h: { BTC: 12, ETH: null }, account: { ...flatAccount, positions: [pos] } });
    expect(t.map((x) => x.key).sort()).toEqual(["funding:ETH:1", "move1h:BTC:1", "nearstop:ETH", "oi:BTC:1"]);
  });

  test("an unprotected position is critical", () => {
    const pos = { coin: "SOL", side: "short" as const, size: 1, entryPx: 200, markPx: 201, stopPx: null, tpPx: null, unrealizedPnl: -1, notionalUsd: 201 };
    const t = evaluateTriggers({ now: NOW, coins: [], ctxs: [], marks: {}, oiChange4h: {}, account: { ...flatAccount, positions: [pos] } });
    expect(t[0]).toMatchObject({ key: "nostop:SOL", level: "critical" });
  });
});

describe("tick", () => {
  test("alerts on a trigger once per cooldown and wakes the team within the caps", async () => {
    const clock = { now: new Date(NOW) };
    const { service, store, data, notifier } = makeService({ now: () => clock.now, env: { DESK_WATCHLIST: "BTC", DESK_MAX_CYCLES_PER_DAY: "1", DESK_REVIEW_HOURS: "0" } });
    await store.setState(WATCH_KEY, { marks: { BTC: [[NOW - HOUR, 95_000]] }, lastTick: new Date(NOW - 15 * 60_000).toISOString() } satisfies WatchState);
    data.setMark("BTC", 100_000);
    const provider = new ScriptedProvider("claude-opus-5-5", () => [{ text: "**Log:** BTC squeeze, no action." }]);

    const first = await tick(service, { makeProvider: () => provider });
    expect(first.triggers.map((x) => x.key)).toEqual(["move1h:BTC:1"]);
    expect(first.cycle).toMatchObject({ stop: "end" });
    expect(notifier.sent.some((a) => a.title.startsWith("BTC +5.3%"))).toBe(true);

    clock.now = new Date(NOW + 30 * 60_000);
    const second = await tick(service, { makeProvider: () => provider });
    expect(second.triggers).toEqual([]);
    expect(second.suppressed).toEqual(["move1h:BTC:1"]);
    expect(second.cycle).toBeNull();

    // A new trigger after the cooldown hits the daily cycle cap instead of running.
    clock.now = new Date(NOW + 4 * HOUR);
    data.setMark("BTC", 105_000);
    await store.setState(WATCH_KEY, { ...(await store.getState<WatchState>(WATCH_KEY)), marks: { BTC: [[NOW + 3 * HOUR, 100_000]] }, lastCycleAt: new Date(NOW - 5 * HOUR).toISOString() });
    const third = await tick(service, { makeProvider: () => provider });
    expect(third.cycle).toEqual({ skipped: "daily cycle cap reached (1)" });
  });

  test("follows the UI watchlist each tick; a newly added coin needs a baseline tick before it can alert", async () => {
    const clock = { now: new Date(NOW) };
    const intel = new MemoryIntelStore();
    const env = { DESK_WATCHLIST: "BTC", DESK_REVIEW_HOURS: "0" };
    const crowded = ctx("ETH", 4000, { funding: 0.0001 }); // 87.6% APR: a funding trigger whenever ETH is evaluated
    const { service, store } = makeService({ now: () => clock.now, env, ctxs: [ctx("BTC", 100_000), crowded], watchlist: () => watchedAssets(intel, env) });
    const marked = async () => Object.keys((await store.getState<WatchState>(WATCH_KEY))?.marks ?? {}).sort();
    const step = async () => {
      clock.now = new Date(clock.now.getTime() + 15 * 60_000);
      return tick(service, { runCycle: false });
    };

    // Empty table: DESK_WATCHLIST.
    expect((await step()).triggers).toEqual([]);
    expect(await marked()).toEqual(["BTC"]);

    // Added on the WATCH page: watched on the next tick, but its first observation has no baseline.
    await intel.putWatchlist([{ asset: "ETH", tags: [] }]);
    expect((await step()).triggers).toEqual([]);
    expect(await marked()).toEqual(["ETH"]);
    expect((await step()).triggers.map((x) => x.key)).toEqual(["funding:ETH:1"]);

    // Removed: no longer watched or evaluated.
    await intel.putWatchlist([{ asset: "BTC", tags: [] }]);
    clock.now = new Date(clock.now.getTime() + 4 * HOUR); // past the funding cooldown
    expect((await step()).triggers).toEqual([]);
    expect(await marked()).toEqual(["BTC"]);
  });

  test("a scheduled-review override fires a cycle at the overridden interval, not the env default", async () => {
    const clock = { now: new Date(NOW) };
    const { service, store } = makeService({ now: () => clock.now, env: { DESK_REVIEW_HOURS: "0", DESK_WATCHLIST: "BTC" } });
    await service.setReviewEveryHours(4, "operator");
    await store.setState(WATCH_KEY, { lastCycleAt: new Date(NOW - 5 * HOUR).toISOString() } satisfies WatchState);
    const provider = new ScriptedProvider("claude-opus-5-5", () => [{ text: "**Log:** scheduled check, no action." }]);

    const due = await tick(service, { makeProvider: () => provider });
    expect(due.cycle).toMatchObject({ reason: "scheduled review (every 4h)" });

    // Right after running, the next tick isn't due yet (lastCycleAt just moved).
    const notYet = await tick(service, { makeProvider: () => provider });
    expect(notYet.cycle).toBeNull();
  });

  test("settles paper stops against the bars since the last tick", async () => {
    const { service, store, data } = makeService({ env: { DESK_REVIEW_HOURS: "0" } });
    await service.submitOpen(
      {
        coin: "ETH",
        side: "long",
        setup: "test setup",
        thesis: "A long for the stop test, with enough words in it.",
        horizon: "swing",
        confidence: "medium",
        stop: 3800,
        target: 4500,
        riskPct: 0.5,
        invalidation: "stop",
        evidence: [
          { source: "a", point: "one" },
          { source: "b", point: "two" },
        ],
      },
      null,
    );
    // A 5m wick to 3790 between ticks, then a recovery to 3950.
    data.candleMap.set("ETH", [{ t: NOW - 10 * 60_000, T: NOW - 5 * 60_000, o: 3950, h: 3960, l: 3790, c: 3940, v: 10 }]);
    data.setMark("ETH", 3950);
    const res = await tick(service, { runCycle: false });
    expect(res.settled).toEqual([{ coin: "ETH", kind: "stop", pnl: expect.any(Number) }]);
    expect(res.settled[0]!.pnl).toBeLessThan(-40);
    expect(await store.paperPositions()).toHaveLength(0);
  });

  /** A BTC +5.3% 1h move waiting to fire on the next tick. */
  async function primed(opts: Parameters<typeof makeService>[0] = {}) {
    const kit = makeService({ now: () => new Date(NOW), ...opts, env: { DESK_WATCHLIST: "BTC", DESK_REVIEW_HOURS: "0", ...opts.env } });
    await kit.store.setState(WATCH_KEY, { marks: { BTC: [[NOW - HOUR, 95_000]] }, lastTick: new Date(NOW - 15 * 60_000).toISOString() } satisfies WatchState);
    kit.data.setMark("BTC", 100_000);
    const provider = new ScriptedProvider("claude-opus-5-5", () => [{ text: "**Log:** BTC squeeze, no action." }]);
    const moves = () => kit.notifier.sent.filter((a) => a.title.startsWith("BTC +5.3%")).length;
    return { ...kit, provider, moves };
  }

  test("two ticks at once on one store: one holds the lease, so one alert and one cycle", async () => {
    const { service, store, provider, moves } = await primed();
    const [a, b] = await Promise.all([tick(service, { makeProvider: () => provider }), tick(service, { makeProvider: () => provider })]);
    expect([a.skipped, b.skipped].filter(Boolean)).toEqual(["another tick is running"]);
    expect([...a.triggers, ...b.triggers].map((x) => x.key)).toEqual(["move1h:BTC:1"]);
    expect(moves()).toBe(1);
    expect(await store.countRunsSince("cycle", new Date(0))).toBe(1);
    // The lease is released: the next tick runs (and finds the trigger cooling down).
    expect(await tick(service, { makeProvider: () => provider })).toMatchObject({ suppressed: ["move1h:BTC:1"], cycle: null });
  });

  test("a held lease expires, so a tick that died does not block the next ones for good", async () => {
    const clock = { now: new Date(NOW) };
    const { service, store } = makeService({ now: () => clock.now, env: { DESK_WATCHLIST: "BTC", DESK_REVIEW_HOURS: "0" } });
    expect(await store.acquireLease("tick", "dead", 3 * 60_000)).toBe(true);
    expect((await tick(service, { runCycle: false })).skipped).toBe("another tick is running");
    clock.now = new Date(NOW + 3 * 60_000);
    expect((await tick(service, { runCycle: false })).skipped).toBeUndefined();
    // Releasing someone else's lease does nothing.
    expect(await store.acquireLease("tick", "a", 60_000)).toBe(true);
    await store.releaseLease("tick", "b");
    expect(await store.acquireLease("tick", "b", 60_000)).toBe(false);
    await store.releaseLease("tick", "a");
    expect(await store.acquireLease("tick", "b", 60_000)).toBe(true);
  });

  test("a throw right after an alert's push does not repeat the alert on the next tick", async () => {
    const { service, store, moves } = await primed();
    const insertAlert = store.insertAlert.bind(store);
    store.insertAlert = async () => {
      throw new Error("alert table down");
    };
    await expect(tick(service, { runCycle: false })).rejects.toThrow("alert table down");
    expect(moves()).toBe(1);
    store.insertAlert = insertAlert;
    const again = await tick(service, { runCycle: false });
    expect(again.skipped).toBeUndefined();
    expect(again.suppressed).toEqual(["move1h:BTC:1"]);
    expect(moves()).toBe(1);
  });

  test("a venue upkeep note and the day-loss alert are claimed before they are sent", async () => {
    const { service, store, notifier } = makeService({ now: () => new Date(NOW), env: { DESK_WATCHLIST: "BTC", DESK_REVIEW_HOURS: "0" } });
    service.broker.housekeep = async () => [{ level: "warn", key: "perp-radar", text: "perp-radar is on the account" }];
    const account = service.broker.account.bind(service.broker);
    service.broker.account = async (m, n) => ({ ...(await account(m, n)), dayPnlUsd: -5_000 });
    const insertAlert = store.insertAlert.bind(store);
    let fail = 2;
    store.insertAlert = async (a) => {
      if (fail-- > 0) throw new Error("alert table down");
      return insertAlert(a);
    };
    await expect(tick(service, { runCycle: false })).rejects.toThrow("alert table down"); // after the upkeep push
    await expect(tick(service, { runCycle: false })).rejects.toThrow("alert table down"); // after the day-loss push
    await tick(service, { runCycle: false });
    await tick(service, { runCycle: false });
    expect(notifier.sent.map((a) => a.title)).toEqual(["paper account check", "Daily loss limit hit"]);
  });

  test("day loss: nothing under the limit; at the limit one critical alert per UTC day, claimed in the store before it is sent", async () => {
    const clock = { now: new Date(NOW) };
    const { service, store, notifier } = makeService({ now: () => clock.now, env: { DESK_WATCHLIST: "BTC", DESK_REVIEW_HOURS: "0", DESK_DAILY_LOSS_PCT: "2" } });
    // A store that hands out copies, as Postgres does: a flag set on the tick's own state object is not stored by that.
    const getState = store.getState.bind(store);
    store.getState = async <T>(key: string) => structuredClone(await getState<T>(key));
    const account = service.broker.account.bind(service.broker);
    let pnl = -199;
    service.broker.account = async (m, n) => ({ ...(await account(m, n)), equityUsd: 10_000, dayPnlUsd: pnl });
    const dayLoss = () => notifier.sent.filter((a) => a.title === "Daily loss limit hit");
    await tick(service, { runCycle: false });
    expect(dayLoss()).toEqual([]); // 1.99 % of equity
    pnl = -200;
    // The alert's own write fails after the push went out: the claim is already stored, so the next tick does not push again.
    const insertAlert = store.insertAlert.bind(store);
    store.insertAlert = async () => {
      throw new Error("alert table down");
    };
    await expect(tick(service, { runCycle: false })).rejects.toThrow("alert table down");
    store.insertAlert = insertAlert;
    expect((await getState<WatchState>(WATCH_KEY))?.dayLossAlerted).toBe("2026-10-05");
    await tick(service, { runCycle: false });
    await tick(service, { runCycle: false });
    expect(dayLoss()).toHaveLength(1);
    expect(dayLoss()[0]).toMatchObject({ level: "critical", body: expect.stringContaining("Day PnL $-200.00 (2.00%)") });
    // A new UTC day at the limit alerts again.
    clock.now = new Date(NOW + 24 * HOUR);
    await tick(service, { runCycle: false });
    expect(dayLoss()).toHaveLength(2);
  });

  test("a trigger that would wake the team at the spent LLM cap raises one alert per UTC day; a scheduled review or another refusal raises none", async () => {
    const clock = { now: new Date(NOW) };
    const cache = new MemoryLlmCache();
    const { service, store, data, provider, notifier } = await primed({ now: () => clock.now, llm: { cache, now: () => clock.now, dailyCap: 1, dailyUsd: 2 } });
    const skips = () => notifier.sent.filter((a) => a.title === "Desk cycles skipped: LLM cap spent");
    const broken = { cache: { ...cache, callsSince: async () => Promise.reject(new Error("db down")) } as unknown as MemoryLlmCache, now: () => clock.now, dailyCap: 5, dailyUsd: 2 };
    // The counter cannot be read: the cycle is refused, but that is not "the cap is spent".
    expect((await tick(service, { makeProvider: () => provider, llm: broken })).cycle).toEqual({ skipped: "LLM cap check failed: db down" });
    expect(skips()).toEqual([]);
    await cache.cachePut("other", "v", {}, { input_tokens: 1, output_tokens: 1 }, "m");
    // A second move, past the trigger cooldown: it would wake the team, and the cap is spent.
    const again = async (at: number, mark: number, from: number) => {
      clock.now = new Date(at);
      data.setMark("BTC", mark);
      await store.setState(WATCH_KEY, { ...(await store.getState<WatchState>(WATCH_KEY)), marks: { BTC: [[at - HOUR, from]] } });
      return tick(service, { makeProvider: () => provider });
    };
    const first = await again(NOW + 4 * HOUR, 106_000, 100_000);
    expect(first.triggers.some((x) => x.wake)).toBe(true);
    expect(first.cycle).toEqual({ skipped: "LLM cap reached" });
    expect(skips()).toHaveLength(1);
    expect(skips()[0]).toMatchObject({ level: "warn", body: expect.stringContaining("LLM cap reached") });
    expect(provider.systems).toEqual([]);
    // The same day, another trigger: skipped again, not alerted again.
    expect((await again(NOW + 8 * HOUR, 113_000, 106_000)).cycle).toEqual({ skipped: "LLM cap reached" });
    expect(skips()).toHaveLength(1);
    expect((await store.getState<WatchState>(WATCH_KEY))?.capSkipAlerted).toBe("2026-10-05");
  });

  test("a scheduled review skipped at the LLM cap, with no trigger, raises no alert", async () => {
    const cache = new MemoryLlmCache();
    const { service, notifier } = makeService({ now: () => new Date(NOW), env: { DESK_WATCHLIST: "BTC", DESK_REVIEW_HOURS: "4" }, llm: { cache, now: () => new Date(NOW), dailyCap: 1, dailyUsd: 2 } });
    await cache.cachePut("other", "v", {}, { input_tokens: 1, output_tokens: 1 }, "m");
    const provider = new ScriptedProvider("claude-opus-5-5", () => [{ text: "ok" }]);
    expect((await tick(service, { makeProvider: () => provider })).cycle).toEqual({ skipped: "LLM cap reached" });
    expect(notifier.sent).toEqual([]);
  });

  test("at the daily LLM cap a tick runs no cycle, calls no provider and keeps the review slot; a cycle that runs is billed", async () => {
    const cache = new MemoryLlmCache();
    const { service, store, provider } = await primed({ llm: { cache, now: () => new Date(NOW), dailyCap: 1, dailyUsd: 2 }, env: { DESK_REVIEW_HOURS: "4" } });
    await cache.cachePut("other", "v", {}, { input_tokens: 1, output_tokens: 1 }, "m");
    const capped = await tick(service, { makeProvider: () => provider });
    expect(capped.cycle).toEqual({ skipped: "LLM cap reached" });
    expect(provider.systems).toEqual([]);
    expect(await store.listRuns(5)).toEqual([]);
    expect((await store.getState<WatchState>(WATCH_KEY))?.lastCycleAt).toBeUndefined();
    // An unreadable counter fails closed too.
    const broken = { cache: { ...cache, callsSince: async () => Promise.reject(new Error("db down")) } as unknown as MemoryLlmCache, now: () => new Date(NOW), dailyCap: 5, dailyUsd: 2 };
    expect((await tick(service, { makeProvider: () => provider, llm: broken })).cycle).toEqual({ skipped: "LLM cap check failed: db down" });
    expect(provider.systems).toEqual([]);
    // Under the cap the scheduled review runs and its tokens land on the counter.
    const roomy = { cache, now: () => new Date(NOW), dailyCap: 5, dailyUsd: 2 };
    const ran = await tick(service, { makeProvider: () => provider, llm: roomy });
    expect(ran.cycle).toMatchObject({ stop: "end" });
    expect(cache.usage).toHaveLength(2);
    expect(cache.usage[1]).toMatchObject({ model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 100, searches: 0 });
  });
});
