import { describe, expect, test } from "bun:test";
import { changeOver, evaluateTriggers, tick, WATCH_KEY, type WatchState } from "./watch.js";
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
});
