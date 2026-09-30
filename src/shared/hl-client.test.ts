import { describe, expect, test } from "bun:test";
import { fetchPerpMetaAndCtxs, fetchCandles } from "./hl-client.js";
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
