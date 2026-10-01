import { describe, expect, test } from "bun:test";
import type { SyncDeps } from "../market/candleSync.js";
import { backfillBranch, backfillCoin } from "./backfill.js";

describe("backfillCoin", () => {
  test("stablecoins are skipped without touching the network or DB", async () => {
    await expect(backfillCoin("USDC", new Date("2024-01-01"))).resolves.toBeUndefined();
    await expect(backfillCoin("USDT", new Date("2024-01-01"))).resolves.toBeUndefined();
  });
});

describe("backfillBranch", () => {
  test("syncs daily history for every non-stable allocation, in order", async () => {
    const synced: string[] = [];
    const deps = {
      now: () => Date.UTC(2024, 5, 1),
      getState: async (coin: string, series: string) => {
        synced.push(`${coin}:${series}`);
        return { coin, series, hlFloor: null, ext: {}, syncedAt: Date.UTC(2024, 5, 1), accessedAt: null, error: null };
      },
      // Coverage already reaches the start date: ensureHistory stops after the (throttled) head sync.
      bounds: async () => ({ min: Date.UTC(2023, 0, 1), max: Date.UTC(2024, 4, 31) }),
    } as unknown as SyncDeps;
    await backfillBranch(
      {
        startDate: "2024-01-01",
        initialCapitalUsd: 1000,
        rebalance: "none",
        allocations: [
          { coin: "ETH", weightPct: 50 },
          { coin: "USDC", weightPct: 20 },
          { coin: "SOL", weightPct: 30 },
        ],
      },
      deps,
    );
    expect(synced).toEqual(["ETH:1d", "SOL:1d"]);
  });
});
