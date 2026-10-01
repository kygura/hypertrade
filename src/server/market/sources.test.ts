import { describe, expect, test } from "bun:test";
import { binance, bitstamp, externalBase, parseBinanceKlines, parseBitstampOhlc } from "./sources.js";

const respond = (status: number, body: unknown, seen?: string[]): typeof fetch =>
  (async (url: string | URL | Request) => {
    seen?.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe("externalBase", () => {
  test("maps HL names to the base token external venues quote", () => {
    expect(externalBase("BTC")).toEqual({ base: "BTC", scale: 1 });
    expect(externalBase("kPEPE")).toEqual({ base: "PEPE", scale: 1000 });
    expect(externalBase("xyz:TSLA")).toBeNull();
    expect(externalBase("@107")).toBeNull();
  });
});

describe("parsers", () => {
  test("Binance klines: base volume, scaled for k-coins, junk rows dropped", () => {
    const raw = [
      [1000, "0.00001", "0.00002", "0.000005", "0.000015", "5000000", 1999, "75", 10],
      [2000, "x", "1", "1", "1", "1"],
    ];
    const bars = parseBinanceKlines(raw, 1000);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.c).toBeCloseTo(0.015);
    expect(bars[0]!.v).toBeCloseTo(5000);
  });

  test("Bitstamp ohlc: seconds to ms, empty fields rejected", () => {
    const raw = {
      data: {
        pair: "BTC/USD",
        ohlc: [
          { timestamp: "1319846400", open: "3.69", high: "4.40", low: "3.69", close: "3.95", volume: "88.4" },
          { timestamp: "1319760000", open: "3.07", high: "4.36", low: "3.07", close: "", volume: "118.3" },
        ],
      },
    };
    expect(parseBitstampOhlc(raw, 1)).toEqual([{ t: 1319846400000, o: 3.69, h: 4.4, l: 3.69, c: 3.95, v: 88.4 }]);
  });
});

describe("venues", () => {
  test("Binance pages backward via endTime on the keyless mirror", async () => {
    const seen: string[] = [];
    const res = await binance.fetchBefore("BTC", "1d", 1_700_000_000_000, 1000, respond(200, [], seen));
    expect(res).toEqual({ kind: "ok", bars: [] });
    expect(seen[0]).toBe("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&endTime=1700000000000&limit=1000");
  });

  test("Binance invalid symbol is 'unsupported'; other errors throw", async () => {
    expect(await binance.fetchBefore("NOPE", "1d", 1, 10, respond(400, { code: -1121, msg: "Invalid symbol." }))).toEqual({ kind: "unsupported" });
    await expect(binance.fetchBefore("BTC", "1d", 1, 10, respond(429, {}))).rejects.toThrow("Binance HTTP 429");
  });

  test("Binance leaves 1w/1M to daily resampling", () => {
    expect(binance.supports("1d")).toBe(true);
    expect(binance.supports("1w")).toBe(false);
    expect(binance.supports("1M")).toBe(false);
  });

  test("Bitstamp uses seconds and lowercase usd pairs; 404 is 'unsupported'", async () => {
    const seen: string[] = [];
    await bitstamp.fetchBefore("ETH", "4h", 1_700_000_000_999, 1000, respond(200, { data: { ohlc: [] } }, seen));
    expect(seen[0]).toBe("https://www.bitstamp.net/api/v2/ohlc/ethusd/?step=14400&end=1700000000&limit=1000");
    expect(await bitstamp.fetchBefore("NOPE", "1d", 1, 10, respond(404, {}))).toEqual({ kind: "unsupported" });
    expect(bitstamp.supports("1w")).toBe(false);
  });
});
