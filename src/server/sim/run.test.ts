import { expect, test } from "bun:test";
import { runBranchConfig } from "./run.js";

test("runBranchConfig: backfill -> candles -> simulate, no montecarlo without scenario", async () => {
  const day = 86400000;
  const t0 = Date.parse("2024-01-01");
  let backfilled = false;
  const r = await runBranchConfig(
    { startDate: "2024-01-01", initialCapitalUsd: 1000, allocations: [{ coin: "BTC", weightPct: 100 }], rebalance: "none" },
    {
      backfill: async () => void (backfilled = true),
      loadCandles: async () => ({ BTC: [0, 1, 2].map((i) => ({ ts: t0 + i * day, c: 100 + i * 10 })) }),
      now: () => t0,
    },
  );
  expect(backfilled).toBe(true);
  expect(r.stats.finalValue).toBeCloseTo(1200);
  expect(r.montecarlo).toBeUndefined();
});
