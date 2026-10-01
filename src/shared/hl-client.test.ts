import { describe, expect, test } from "bun:test";
import { fetchPerpMetaAndCtxs, fetchCandles, fetchFundingPage, fetchPredictedFundings, weightWaitMs } from "./hl-client.js";
import fixture from "./fixtures/hyperliquid.json" with { type: "json" };

function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: ok ? status : 500 })) as unknown as typeof fetch;
}

describe("fetchPerpMetaAndCtxs", () => {
  test("parses the recorded fixture into numeric AssetCtx entries", async () => {
    const { meta, ctxs } = await fetchPerpMetaAndCtxs(mockFetch(fixture));
    expect(meta.universe.length).toBe(5);
    expect(ctxs.map((c) => c.name)).toEqual(["BTC", "ETH", "ATOM", "MATIC", "DYDX"]);

    const btc = ctxs[0]!;
    expect(btc.markPx).toBeCloseTo(63846.0);
    expect(btc.openInterest).toBeCloseTo(37299.6947999999);
    expect(btc.dayChange).toBeCloseTo((63846.0 - 64221.0) / 64221.0);

    // MATIC: delisted, null premium/midPx in the fixture.
    const matic = ctxs[3]!;
    expect(matic.isDelisted).toBe(true);
    expect(matic.premium).toBe(0);
    expect(matic.midPx).toBeCloseTo(0.37621); // falls back to markPx when midPx is null
  });

  test("throws on a malformed payload instead of returning garbage", async () => {
    await expect(fetchPerpMetaAndCtxs(mockFetch({ nope: true }))).rejects.toThrow();
  });

  test("throws on a non-ok HTTP response", async () => {
    await expect(fetchPerpMetaAndCtxs(mockFetch(fixture, false))).rejects.toThrow();
  });
});

describe("fetchCandles", () => {
  test("parses candle snapshot rows into numeric OHLCV", async () => {
    const raw = [{ t: 3_600_000, T: 7_199_999, o: "100", h: "110", l: "90", c: "105", v: "12.5" }];
    const candles = await fetchCandles("BTC", "1h", 0, 10_000_000, mockFetch(raw));
    expect(candles).toEqual([{ t: 3_600_000, T: 7_199_999, o: 100, h: 110, l: 90, c: 105, v: 12.5 }]);
  });
});

describe("weightWaitMs", () => {
  test("0 while the trailing minute is under budget", () => {
    expect(weightWaitMs([{ t: 0, weight: 500 }], 1000, 1000)).toBe(0);
  });
  test("waits until the oldest entry ages out once over budget", () => {
    expect(weightWaitMs([{ t: 0, weight: 600 }, { t: 10_000, weight: 400 }], 20_000, 1000)).toBe(40_000);
  });
  test("ignores entries older than the window", () => {
    expect(weightWaitMs([{ t: 0, weight: 5000 }], 61_000, 1000)).toBe(0);
  });
});

describe("fetchFundingPage", () => {
  test("parses rows, drops malformed ones, sorts ascending", async () => {
    const raw = [
      { coin: "BTC", fundingRate: "0.0000125", premium: "-0.0001", time: 7_200_000 },
      { coin: "BTC", fundingRate: "", premium: "0", time: 5_400_000 },
      { coin: "BTC", fundingRate: "0.00002", premium: "0.0002", time: 3_600_000 },
    ];
    expect(await fetchFundingPage("BTC", 0, 10_000_000, mockFetch(raw))).toEqual([
      { t: 3_600_000, rate: 0.00002, premium: 0.0002 },
      { t: 7_200_000, rate: 0.0000125, premium: -0.0001 },
    ]);
  });
});

describe("fetchPredictedFundings", () => {
  test("maps venues per coin, skipping null venues", async () => {
    const raw = [
      [
        "BTC",
        [
          ["BinPerp", { fundingRate: "0.0001", nextFundingTime: 1733961600000, fundingIntervalHours: 8 }],
          ["HlPerp", { fundingRate: "0.0000125", nextFundingTime: 1733958000000, fundingIntervalHours: 1 }],
          ["BybitPerp", null],
        ],
      ],
    ];
    const m = await fetchPredictedFundings(mockFetch(raw));
    expect(m.get("BTC")).toEqual([
      { venue: "BinPerp", rate: 0.0001, intervalHours: 8, nextFundingTime: 1733961600000 },
      { venue: "HlPerp", rate: 0.0000125, intervalHours: 1, nextFundingTime: 1733958000000 },
    ]);
  });
});
