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

test("simulateLoaded: bootstrap projection resamples the branch's own history, skips with a note when it is short", async () => {
  const { simulateLoaded } = await import("./run.js");
  const day = 86400000;
  const t0 = Date.parse("2024-01-01");
  const btc = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: t0 + i * day, c: 100 * 1.002 ** i }));
  const config = {
    startDate: "2024-01-01",
    initialCapitalUsd: 1000,
    allocations: [{ coin: "BTC", weightPct: 100, leverage: 2 }],
    rebalance: "none" as const,
    scenario: { horizonDays: 10, assumptions: [], paths: 20, method: "bootstrap" as const },
  };
  const long = simulateLoaded(config, { BTC: btc(120) }, t0 + 120 * day);
  expect(long.montecarlo!.summary!.method).toBe("bootstrap");
  expect(long.montecarlo!.median[0]!.value).toBeCloseTo(long.stats.finalValue);
  expect(long.montecarlo!.median.at(-1)!.value).toBeGreaterThan(long.stats.finalValue);
  const short = simulateLoaded(config, { BTC: btc(20) }, t0 + 20 * day);
  expect(short.montecarlo).toBeUndefined();
  expect(short.notes![0]).toContain("projection skipped");
});
