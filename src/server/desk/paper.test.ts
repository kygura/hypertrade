import { describe, expect, test } from "bun:test";
import { tick } from "./watch.js";
import { WATCH_KEY, type WatchState } from "./watch.js";
import { ctx, makeService } from "./testkit.js";

const MIN = 60_000;

describe("paper book stops", () => {
  test("a stop fills with slippage like any market exit; a target fills at its price", async () => {
    const { service, store } = makeService({ env: { DESK_REVIEW_HOURS: "0", DESK_MAX_CYCLES_PER_DAY: "0" } });
    const broker = service.broker;
    await broker.open({ coin: "ETH", side: "long", stop: 3800, target: 4500, riskPct: 0.5 }, { markPx: 4000, size: 1, notionalUsd: 4000, riskUsd: 200, stopDistPct: 5, rr: 2.5, feeUsd: 0, grossLeverageAfter: 0.4 }, "p1", new Date("2026-10-05T12:00:00Z"));
    const [hit] = await broker.settle!(new Map([["ETH", { low: 3700, high: 4010 }]]), new Date("2026-10-05T12:15:00Z"));
    expect(hit!.kind).toBe("stop");
    expect(hit!.result.fills[0]!.px).toBeLessThan(3800);
    expect((await store.paperPositions()).length).toBe(0);
  });

  test("a stop settled on the first tick of a UTC day counts against that day's loss", async () => {
    const clock = { now: new Date("2026-10-05T23:50:00Z") };
    const { service, store, data } = makeService({ now: () => clock.now, ctxs: [ctx("ETH", 4000)], env: { DESK_WATCHLIST: "ETH", DESK_REVIEW_HOURS: "0", DESK_MAX_CYCLES_PER_DAY: "0" } });
    const broker = service.broker;
    await broker.open({ coin: "ETH", side: "long", stop: 3800, target: 4500, riskPct: 0.5 }, { markPx: 4000, size: 1, notionalUsd: 4000, riskUsd: 200, stopDistPct: 5, rr: 2.5, feeUsd: 0, grossLeverageAfter: 0.4 }, "p1", clock.now);
    await service.account(); // anchors 2026-10-05
    await store.setState(WATCH_KEY, { lastTick: clock.now.toISOString() } satisfies WatchState);
    // 00:03 UTC: a wick through the stop. The next tick (00:05) is the first look of the new day.
    const t = Date.parse("2026-10-06T00:00:00Z");
    data.candleMap.set("ETH", [{ t, T: t + 5 * MIN - 1, o: 3990, h: 3995, l: 3750, c: 3985, v: 1 }]);
    data.setMark("ETH", 3990);
    clock.now = new Date("2026-10-06T00:05:00Z");
    const r = await tick(service);
    expect(r.settled.map((s) => s.kind)).toEqual(["stop"]);
    const acc = await service.account();
    expect(acc.dayPnlUsd).toBeLessThan(-180);
  });
});
