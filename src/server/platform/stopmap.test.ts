import { describe, expect, test } from "bun:test";
import { bucketIndex, type Position } from "../../shared/platform.js";
import { bucketStops, parseStopOrders } from "./stopmap.js";
import { createStopmapLoop, walletsToPoll } from "./stopmapLoop.js";

const order = (over: Record<string, unknown>) => ({
  coin: "BTC", isPositionTpsl: false, isTrigger: true, limitPx: "0", oid: 1, orderType: "Stop Market", origSz: "1", reduceOnly: true, side: "A", sz: "1.0",
  timestamp: 1, triggerCondition: "Price below 59000", triggerPx: "59000.0", ...over,
});

describe("parseStopOrders", () => {
  test("keeps reduce-only stops and position stop-losses; drops take profits, limits, stop entries and bad rows", () => {
    const r = parseStopOrders([
      order({}), // long stop
      order({ side: "B", triggerPx: "64000" }), // short stop
      order({ orderType: "Stop Limit", reduceOnly: false, isPositionTpsl: true, sz: "0.0" }), // whole-position stop-loss
      order({ orderType: "Take Profit Market" }),
      order({ isTrigger: false, orderType: "Limit", triggerPx: "0.0" }),
      order({ reduceOnly: false }), // a stop entry opens a position, it clears none
      { coin: "BTC", side: "X" },
    ])!;
    expect(r.stops).toEqual([
      { coin: "BTC", closes: "long", triggerPx: 59000, sz: 1 },
      { coin: "BTC", closes: "short", triggerPx: 64000, sz: 1 },
      { coin: "BTC", closes: "long", triggerPx: 59000, sz: 0 },
    ]);
    expect(r.bad).toBe(1);
    expect(parseStopOrders({ error: "x" })).toBeNull();
  });
});

describe("bucketStops", () => {
  test("sz × trigger on the liqmap grid; whole-position stops sized from the position; wrong side of mark and out of range dropped", () => {
    const cells = bucketStops(
      [
        { coin: "BTC", closes: "long", triggerPx: 59000, sz: 1 },
        { coin: "BTC", closes: "long", triggerPx: 59000, sz: 0, positionSz: 2 },
        { coin: "BTC", closes: "long", triggerPx: 61000, sz: 1 }, // above mark: about to fire or stale
        { coin: "BTC", closes: "short", triggerPx: 64000, sz: 0.5 },
        { coin: "BTC", closes: "short", triggerPx: 99000, sz: 1 }, // beyond the range
        { coin: "BTC", closes: "long", triggerPx: 58000, sz: 0, positionSz: null }, // no size known
      ],
      { mark: 60000, bucketBps: 25, rangePct: 0.3 },
    );
    expect(cells).toEqual([
      { idx: bucketIndex(59000, 25), longUsd: 177_000, shortUsd: 0 },
      { idx: bucketIndex(64000, 25), longUsd: 0, shortUsd: 32_000 },
    ]);
  });
});

const pos = (address: string, coin: string, szi: number, positionValue: number): Position =>
  ({ address, coin, szi, entryPx: 1, positionValue, liquidationPx: null, leverage: null, updatedAt: "2026-11-20T00:00:00.000Z" });
const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const C = `0x${"c".repeat(40)}`;

test("walletsToPoll: wallets in the top coins, by their notional there, capped", () => {
  const ps = [pos(A, "BTC", 1, 100), pos(B, "BTC", 1, 500), pos(B, "DOGE", 1, 10_000), pos(C, "DOGE", 1, 9_999), pos(A, "ETH", 1, 600)];
  expect(walletsToPoll(ps, new Set(["BTC", "ETH"]), 10)).toEqual([A, B]);
  expect(walletsToPoll(ps, new Set(["BTC", "ETH"]), 1)).toEqual([A]);
});

test("stopmap loop: one row per top coin a polled wallet holds, each poll booked against the loop's share; a failed poll is skipped", async () => {
  const meta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }] };
  const ctx = (px: string, oi: string) => ({ funding: "0", openInterest: oi, prevDayPx: px, dayNtlVlm: "1", premium: "0", oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px], dayBaseVlm: "1" });
  const booked: number[] = [];
  const inserted: unknown[] = [];
  const loop = createStopmapLoop({
    store: { listPositions: async () => [pos(A, "BTC", 2, 120_000), pos(B, "ETH", -1, 3_000), pos(C, "BTC", 1, 60_000)], insertStopmapSnapshots: async (r) => (inserted.push(...r), r.length) },
    info: (async (body: { type: string; user?: string }) => {
      if (body.type === "metaAndAssetCtxs") return [meta, [ctx("60000", "1000"), ctx("3000", "1000")]];
      if (body.user === C) throw new Error("HL 500");
      return body.user === A ? [order({ sz: "0.0", isPositionTpsl: true })] : [];
    }) as never,
    share: async (w) => void booked.push(w),
    now: () => Date.UTC(2026, 10, 20),
  });
  const rows = await loop.tick();
  expect(booked).toEqual([20, 20, 20]);
  expect(rows.map((r) => [r.coin, r.wallets, r.buckets])).toEqual([
    ["BTC", 1, [{ idx: bucketIndex(59000, 25), longUsd: 118_000, shortUsd: 0 }]],
    ["ETH", 1, []], // polled, no stops: 0 seen, not unknown
  ]);
  expect(inserted).toEqual(rows);
});
