import { describe, expect, test } from "bun:test";
import { runIntent, type IntentDeps } from "./intent.js";
import type { DailyClose } from "./engine.js";

const DAY = 86400000;
const t0 = Date.parse("2024-01-01");
const series = (start: number, n: number, f: (i: number) => number = (i) => 100 + i): DailyClose[] =>
  Array.from({ length: n }, (_, i) => ({ ts: start + i * DAY, c: f(i), l: f(i), h: f(i) }));

const data: Record<string, DailyClose[]> = {
  BTC: series(t0, 120),
  ETH: series(t0, 120),
  SOL: series(t0 + 30 * DAY, 90), // listed 30 days after start
};
const deps = (over: Partial<IntentDeps> = {}): IntentDeps => ({
  backfill: async () => {},
  loadCandles: async (c) => {
    const out: Record<string, DailyClose[]> = { BTC: data.BTC! };
    for (const a of [...c.allocations, ...(c.dca ?? [])]) if (data[a.coin]) out[a.coin] = data[a.coin]!;
    return out;
  },
  now: () => t0,
  ...over,
});

const cfg = (o: Record<string, unknown> = {}) => ({
  startDate: "2024-01-01",
  initialCapitalUsd: 1000,
  allocations: [{ coin: "BTC", weightPct: 100 }],
  rebalance: "none",
  ...o,
});
const intent = (...configs: Record<string, unknown>[]) => ({
  title: "t",
  assumptions: [],
  branches: configs.map((config, i) => ({ name: `b${i}`, config })),
});
const run = async (i: unknown, d = deps()) => {
  const r = await runIntent(i, d);
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("runIntent", () => {
  test("uppercases coins", async () => {
    const r = await run(intent(cfg({ allocations: [{ coin: "btc", weightPct: 100 }] })));
    expect(r.branches[0]!.config.allocations[0]!.coin).toBe("BTC");
    expect(r.branches[0]!.result).toBeDefined();
  });

  test("normalizes weights and warns", async () => {
    const r = await run(intent(cfg({ allocations: [{ coin: "BTC", weightPct: 30 }, { coin: "ETH", weightPct: 30 }] })));
    const b = r.branches[0]!;
    expect(b.config.allocations.map((a) => a.weightPct)).toEqual([50, 50]);
    expect(b.warnings.some((w) => w.includes("normalized"))).toBe(true);
  });

  test("clamps leverage to maxLeverage", async () => {
    const r = await run(intent(cfg({ allocations: [{ coin: "BTC", weightPct: 100, leverage: 20 }] })), deps({ maxLeverage: () => 5 }));
    expect(r.branches[0]!.config.allocations[0]!.leverage).toBe(5);
    expect(r.branches[0]!.warnings.some((w) => w.includes("clamped"))).toBe(true);
  });

  test("dca forces rebalance none", async () => {
    const r = await run(
      intent(cfg({ rebalance: "monthly", allocations: [{ coin: "USDC", weightPct: 100 }], dca: [{ coin: "ETH", amountUsd: 50, every: "weekly" }] })),
    );
    expect(r.branches[0]!.config.rebalance).toBe("none");
    expect(r.branches[0]!.warnings.some((w) => w.includes("DCA"))).toBe(true);
    expect(r.branches[0]!.error).toBeUndefined();
  });

  test("listing clamp moves startDate", async () => {
    const r = await run(intent(cfg({ allocations: [{ coin: "BTC", weightPct: 50 }, { coin: "SOL", weightPct: 50 }] })));
    const b = r.branches[0]!;
    expect(b.config.startDate).toBe(new Date(t0 + 30 * DAY).toISOString().slice(0, 10));
    expect(b.warnings.some((w) => w.includes("moved"))).toBe(true);
  });

  const scenario = { horizonDays: 30, paths: 20, assumptions: [{ coin: "BTC", annualReturnPct: 10, annualVolPct: 50 }] };

  test("scenario kept for long-only", async () => {
    const r = await run(intent(cfg({ scenario })));
    expect(r.branches[0]!.result!.montecarlo).toBeDefined();
  });

  test("scenario dropped for perp branch, caveat added", async () => {
    const r = await run(intent(cfg({ scenario, allocations: [{ coin: "BTC", weightPct: 100, side: "short" }] })));
    const b = r.branches[0]!;
    expect(b.result!.montecarlo).toBeUndefined();
    expect(b.config.scenario).toBeUndefined();
    expect(b.warnings.some((w) => w.includes("projection skipped"))).toBe(true);
    expect(b.warnings.some((w) => w.includes("no funding"))).toBe(true);
  });

  test("one bad branch does not sink the others", async () => {
    const r = await run(intent(cfg({ allocations: [{ coin: "NOPE", weightPct: 100 }] }), cfg()));
    expect(r.branches[0]!.error).toContain("NOPE");
    expect(r.branches[0]!.result).toBeUndefined();
    expect(r.branches[1]!.result).toBeDefined();
  });

  test("rejects invalid intents", async () => {
    const ok = intent(cfg());
    for (const bad of [
      { ...ok, extra: 1 },
      intent(cfg(), cfg(), cfg(), cfg(), cfg()),
      intent(cfg({ allocations: [{ coin: "BTC", weightPct: 100, leverage: 80 }] })),
      intent(cfg({ extra: 1 })),
    ]) {
      expect("error" in (await runIntent(bad, deps()))).toBe(true);
    }
  });
});
