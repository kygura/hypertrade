import { describe, expect, test } from "bun:test";
import { needsBackfill, daysParam, COINGECKO_IDS, backfillCoin } from "./backfill";

const DAY = 86400000;

describe("needsBackfill", () => {
  const today = new Date("2024-06-01T00:00:00Z");
  const startDate = new Date("2024-01-01T00:00:00Z");

  test("no coverage at all -> needed", () => {
    expect(needsBackfill(null, startDate, today)).toBe(true);
  });

  test("coverage starts after startDate -> needed (missing early history)", () => {
    const coverage = { min: new Date("2024-02-01"), max: today };
    expect(needsBackfill(coverage, startDate, today)).toBe(true);
  });

  test("coverage is stale (more than a day behind today) -> needed", () => {
    const coverage = { min: startDate, max: new Date(today.getTime() - 3 * DAY) };
    expect(needsBackfill(coverage, startDate, today)).toBe(true);
  });

  test("full, fresh coverage -> not needed", () => {
    const coverage = { min: startDate, max: new Date(today.getTime() - 1000) };
    expect(needsBackfill(coverage, startDate, today)).toBe(false);
  });
});

describe("daysParam", () => {
  test("range within a year uses the 365 bucket", () => {
    const today = new Date("2024-06-01");
    expect(daysParam(new Date("2024-01-01"), today)).toBe(365);
  });

  test("range beyond a year uses max", () => {
    const today = new Date("2024-06-01");
    expect(daysParam(new Date("2020-01-01"), today)).toBe("max");
  });
});

describe("COINGECKO_IDS", () => {
  test("ports the hyperion DefaultIDs map", () => {
    expect(Object.keys(COINGECKO_IDS)).toHaveLength(30);
    expect(COINGECKO_IDS.BTC).toBe("bitcoin");
    expect(COINGECKO_IDS.ETH).toBe("ethereum");
    expect(COINGECKO_IDS.HYPE).toBe("hyperliquid");
  });
});

describe("backfillCoin", () => {
  test("stablecoins are skipped without touching the network or DB", async () => {
    await expect(backfillCoin("USDC", new Date("2024-01-01"))).resolves.toBeUndefined();
    await expect(backfillCoin("USDT", new Date("2024-01-01"))).resolves.toBeUndefined();
  });
});
