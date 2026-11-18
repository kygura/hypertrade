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

test("simulateLoaded: the projection starts from the last filled move, not the last move by date", async () => {
  const { simulateLoaded } = await import("./run.js");
  const day = 86400000;
  const t0 = Date.parse("2024-01-01");
  const btc = Array.from({ length: 30 }, (_, i) => ({ ts: t0 + i * day, c: 100 * 1.01 ** i }));
  const scenario = { horizonDays: 30, assumptions: [{ coin: "BTC", annualReturnPct: 200, annualVolPct: 0 }], paths: 5, method: "gbm" as const };
  const base = { startDate: "2024-01-01", endDate: "2024-01-30", initialCapitalUsd: 1000, allocations: [{ coin: "USDC", weightPct: 100 }], rebalance: "none" as const, scenario };
  // A move dated after the replay never fills: the branch ends in USDC and the projection stays flat.
  const unfilled = simulateLoaded({ ...base, schedule: [{ date: "2030-01-01", allocations: [{ coin: "BTC", weightPct: 100 }] }] }, { BTC: btc }, t0 + 30 * day);
  expect(unfilled.moves ?? []).toEqual([]);
  expect(unfilled.stats.finalValue).toBeCloseTo(1000);
  expect(unfilled.montecarlo!.median.at(-1)!.value).toBeCloseTo(1000);
  // An `until` move into BTC fills on its window's low (day 3), after the USDC move dated day 2:
  // the branch ends in BTC, so the projection grows.
  const late = simulateLoaded(
    {
      ...base,
      schedule: [
        { date: "2024-01-03", allocations: [{ coin: "USDC", weightPct: 100 }] },
        { date: "2024-01-02", until: "2024-01-04", at: "high" as const, allocations: [{ coin: "BTC", weightPct: 100 }] },
      ],
    },
    { BTC: btc },
    t0 + 30 * day,
  );
  expect(late.moves!.at(-1)!.step).toBe(1);
  expect(late.montecarlo!.median.at(-1)!.value).toBeGreaterThan(late.stats.finalValue * 1.05);
});
