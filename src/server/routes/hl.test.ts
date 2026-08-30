import { describe, expect, test } from "bun:test";
import { fetchPerpMetaAndCtxs } from "../../shared/hl-client";
import fixture from "../../shared/fixtures/hyperliquid.json";
import { toMarketRows } from "./hl";

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
