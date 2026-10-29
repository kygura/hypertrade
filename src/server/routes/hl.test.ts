import { afterEach, describe, expect, test } from "bun:test";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import fixture from "../../shared/fixtures/hyperliquid.json" with { type: "json" };
import { hlRoutes, toMarketRows } from "./hl.js";

function mockFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("toMarketRows", () => {
  test("maps fields, excludes delisted assets, sorts by OI desc", async () => {
    const { ctxs } = await fetchPerpMetaAndCtxs(mockFetch(fixture));
    const rows = toMarketRows(ctxs);

    expect(rows.map((r) => r.coin)).not.toContain("MATIC"); // delisted in fixture

    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].openInterestUsd).toBeGreaterThanOrEqual(rows[i].openInterestUsd);
    }

    const btc = rows.find((r) => r.coin === "BTC")!;
    expect(btc.openInterestUsd).toBeCloseTo(37299.6947999999 * 63846.0, 2);
    expect(btc.markPx).toBe(63846.0);
    expect(btc.oraclePx).toBe(63842.0);
    expect(btc.funding).toBeCloseTo(0.0000125, 10);
  });
});

describe("GET /markets", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("wraps the snapshot with fetchedAt (upstream fetch time, not response time)", async () => {
    globalThis.fetch = mockFetch(fixture);
    const res = await hlRoutes.request("/markets");
    const body = (await res.json()) as { fetchedAt: string; markets: unknown[] };
    expect(typeof body.fetchedAt).toBe("string");
    expect(new Date(body.fetchedAt).toString()).not.toBe("Invalid Date");
    expect(Array.isArray(body.markets)).toBe(true);
    expect(body.markets.length).toBeGreaterThan(0);
  });
});

describe("GET /markets?scope=all", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const ctx = { funding: "0.00001", openInterest: "1000", prevDayPx: "100", dayNtlVlm: "5000000", premium: "0", oraclePx: "110", markPx: "110", midPx: "110", impactPxs: ["109.9", "110.1"], dayBaseVlm: "45000" };
  const xyz = [{ universe: [{ szDecimals: 3, name: "xyz:NVDA", maxLeverage: 20 }, { szDecimals: 4, name: "xyz:GOLD", maxLeverage: 25 }] }, [ctx, ctx]];

  test("adds HIP-3 dexes with dex and asset class, and names a dex that failed", async () => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string; dex?: string };
      if (body.type === "perpDexs") return new Response(JSON.stringify([null, { name: "xyz", fullName: "XYZ" }, { name: "bad", fullName: "Bad" }]));
      if (body.dex === "xyz") return new Response(JSON.stringify(xyz));
      if (body.dex === "bad") return new Response("{}", { status: 400 });
      return new Response(JSON.stringify(fixture));
    }) as unknown as typeof fetch;
    const res = await hlRoutes.request("/markets?scope=all");
    const body = (await res.json()) as { markets: { coin: string; dex: string; assetClass: string; maxLeverage: number | null }[]; failedDexes: string[] };
    const nvda = body.markets.find((m) => m.coin === "xyz:NVDA")!;
    expect(nvda).toMatchObject({ dex: "xyz", assetClass: "equity", maxLeverage: 20 });
    expect(body.markets.find((m) => m.coin === "xyz:GOLD")!.assetClass).toBe("commodity");
    expect(body.markets.find((m) => m.coin === "BTC")).toMatchObject({ dex: "", assetClass: "crypto" });
    expect(body.failedDexes).toEqual(["bad"]);
  });
});
