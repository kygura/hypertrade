import { describe, expect, test } from "bun:test";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client";
import fixture from "../../shared/fixtures/hyperliquid.json";
import { buildHyperliquidObservations } from "./hyperliquid";

function mockFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("buildHyperliquidObservations", () => {
  test("aggregates total OI and OI-weighted funding skew, excluding delisted/zero-OI assets", async () => {
    const { ctxs } = await fetchPerpMetaAndCtxs(mockFetch(fixture));
    const ts = new Date("2026-01-01T00:00:00Z");
    const { seriesDefs, observations, totalOiUsd, fundingSkew, topCoins } = buildHyperliquidObservations(ctxs, ts);

    // BTC, ETH, ATOM, DYDX are live; MATIC is delisted with zero OI.
    const btcNotional = 37299.6947999999 * 63846.0;
    const ethNotional = 802595.3684000007 * 1800.4;
    const atomNotional = 1264700.28 * 1.5593;
    const dydxNotional = 27362480.1999999955 * 0.13198;
    const expectedTotal = btcNotional + ethNotional + atomNotional + dydxNotional;
    expect(totalOiUsd).toBeCloseTo(expectedTotal, 2);

    const expectedFundingSum =
      0.0000125 * btcNotional + 0.0000125 * ethNotional + -0.0000110133 * atomNotional + 0.0000125 * dydxNotional;
    expect(fundingSkew).toBeCloseTo(expectedFundingSum / expectedTotal, 10);

    expect(topCoins).toContain("BTC");
    expect(topCoins).not.toContain("MATIC");

    expect(seriesDefs.map((s) => s.id)).toContain("hl.total_oi_usd");
    expect(seriesDefs.map((s) => s.id)).toContain("hl.oi.BTC");
    expect(seriesDefs.map((s) => s.id)).toContain("hl.funding.BTC");
    expect(seriesDefs.map((s) => s.id)).toContain("hl.premium.BTC");
    expect(seriesDefs.map((s) => s.id)).not.toContain("hl.oi.MATIC");

    const totalObs = observations.find((o) => o.seriesId === "hl.total_oi_usd")!;
    expect(totalObs.value).toBeCloseTo(expectedTotal, 2);
    expect(totalObs.ts).toBe(ts);

    const btcPremium = observations.find((o) => o.seriesId === "hl.premium.BTC")!;
    expect(btcPremium.value).toBeCloseTo(0.0000626547);
  });

  test("caps per-coin series at the top 20 by notional OI", async () => {
    const { ctxs } = await fetchPerpMetaAndCtxs(mockFetch(fixture));
    const { topCoins } = buildHyperliquidObservations(ctxs, new Date());
    expect(topCoins.length).toBeLessThanOrEqual(20);
  });
});
