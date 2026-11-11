import { describe, expect, test } from "bun:test";
import { fetchPerpMetaAndCtxs, fetchCandles, fetchFundingPage, fetchPredictedFundings, weightWaitMs, shareWaitMs, createHlShare, responseWeight, hlRestUrl, hlWsUrl, envBaseUrl, HL_REST, HL_WS } from "./hl-client.js";
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

describe("a job's share of the guard", () => {
  test("waits on its own calls only: 16 calls of 24 fill a 400 share, the 17th waits for the oldest to age out", () => {
    const own = Array.from({ length: 16 }, (_, i) => ({ t: i * 1000, weight: 24 }));
    expect(shareWaitMs(own.slice(0, 15), 20_000, 400, 24)).toBe(0);
    expect(shareWaitMs(own, 20_000, 400, 24)).toBe(40_000);
  });
  test("books each call and does not wait while under its budget, whatever other callers use", async () => {
    let now = 0;
    const share = createHlShare(400, () => now);
    for (let i = 0; i < 16; i++) await share(24);
    now = 61_000;
    await share(24);
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

describe("responseWeight", () => {
  test("l2Book, allMids and clearinghouseState weigh 2; other info calls 20; candles by rows", () => {
    for (const t of ["l2Book", "allMids", "clearinghouseState"]) expect(responseWeight(t, {})).toBe(2);
    expect(responseWeight("metaAndAssetCtxs", [])).toBe(20);
    expect(responseWeight("candleSnapshot", new Array(120))).toBe(22);
  });
});

describe("configurable endpoints", () => {
  test("default to the public Hyperliquid API", () => {
    expect(hlRestUrl({})).toBe(HL_REST);
    expect(hlWsUrl({})).toBe(HL_WS);
  });
  test("HL_API_URL is a base: /info and /ws hang off it, trailing slashes dropped", () => {
    const env = { HL_API_URL: "https://api.hyperliquid-testnet.xyz/" };
    expect(hlRestUrl(env)).toBe("https://api.hyperliquid-testnet.xyz/info");
    expect(hlWsUrl(env)).toBe("wss://api.hyperliquid-testnet.xyz/ws");
    expect(hlWsUrl({ ...env, HL_WS_URL: "wss://ws.example.com/hl" })).toBe("wss://ws.example.com/hl");
  });
  test("a blank or malformed value falls back to the default", () => {
    expect(hlRestUrl({ HL_API_URL: "  " })).toBe(HL_REST);
    expect(hlRestUrl({ HL_API_URL: "not a url" })).toBe(HL_REST);
    expect(envBaseUrl("X", { X: "file:///etc/passwd" })).toBeNull();
  });
  test("requests go to the configured endpoint", async () => {
    const prev = process.env.HL_API_URL;
    process.env.HL_API_URL = "https://hl.example.com";
    const urls: string[] = [];
    const fetchFn = (async (u: string) => {
      urls.push(String(u));
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await fetchPerpMetaAndCtxs(fetchFn);
    } finally {
      if (prev === undefined) delete process.env.HL_API_URL;
      else process.env.HL_API_URL = prev;
    }
    expect(urls).toEqual(["https://hl.example.com/info"]);
  });
});
