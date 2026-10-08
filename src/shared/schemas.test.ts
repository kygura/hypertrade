import { describe, expect, test } from "bun:test";
import {
  BranchConfigSchema, MarketStateDataSchema, SectorsDataSchema,
  HlMetaAndAssetCtxsResponseSchema,
} from "./schemas.js";
import fixture from "./fixtures/hyperliquid.json" with { type: "json" };

describe("BranchConfigSchema", () => {
  const valid = {
    startDate: "2024-01-01",
    initialCapitalUsd: 10000,
    allocations: [{ coin: "ETH", weightPct: 60 }, { coin: "USDC", weightPct: 40 }],
    rebalance: "monthly",
  };

  test("parses a minimal valid config", () => {
    expect(BranchConfigSchema.parse(valid)).toMatchObject(valid);
  });

  test("parses with optional description and scenario", () => {
    const withScenario = {
      ...valid,
      description: "60/40 rebalance monthly",
      scenario: {
        horizonDays: 180,
        assumptions: [{ coin: "ETH", annualReturnPct: 40, annualVolPct: 70 }],
        paths: 200,
      },
    };
    expect(BranchConfigSchema.parse(withScenario)).toMatchObject(withScenario);
  });

  test("rejects an invalid rebalance value", () => {
    expect(() => BranchConfigSchema.parse({ ...valid, rebalance: "daily" })).toThrow();
  });

  test("rejects a missing required field", () => {
    const { startDate: _startDate, ...missing } = valid;
    expect(() => BranchConfigSchema.parse(missing)).toThrow();
  });

  test("rejects an unparseable startDate", () => {
    expect(() => BranchConfigSchema.parse({ ...valid, startDate: "not-a-date" })).toThrow();
  });

  test("rejects a non-integer or non-positive scenario horizonDays/paths", () => {
    const withScenario = (scenario: Record<string, unknown>) => ({
      ...valid,
      scenario: { horizonDays: 180, assumptions: [], paths: 200, ...scenario },
    });
    expect(() => BranchConfigSchema.parse(withScenario({ horizonDays: 0 }))).toThrow();
    expect(() => BranchConfigSchema.parse(withScenario({ horizonDays: 1.5 }))).toThrow();
    expect(() => BranchConfigSchema.parse(withScenario({ paths: 0 }))).toThrow();
    expect(() => BranchConfigSchema.parse(withScenario({ paths: 1.5 }))).toThrow();
  });

  test("accepts perp legs and DCA", () => {
    const cfg = {
      ...valid,
      allocations: [{ coin: "SOL", weightPct: 30, side: "long", leverage: 3 }, { coin: "BTC", weightPct: 20, side: "short" }, { coin: "USDC", weightPct: 50 }],
      dca: [{ coin: "ETH", amountUsd: 250, every: "weekly" }],
    };
    expect(BranchConfigSchema.parse(cfg)).toMatchObject(cfg);
  });

  test("rejects short or levered stablecoins", () => {
    const withAlloc = (a: Record<string, unknown>) => ({ ...valid, allocations: [a] });
    expect(() => BranchConfigSchema.parse(withAlloc({ coin: "USDC", weightPct: 100, side: "short" }))).toThrow();
    expect(() => BranchConfigSchema.parse(withAlloc({ coin: "usdt", weightPct: 100, leverage: 2 }))).toThrow();
    expect(BranchConfigSchema.parse(withAlloc({ coin: "USDC", weightPct: 100, side: "long", leverage: 1 }))).toBeTruthy();
  });

  test("rejects leverage outside 1..50 and bad DCA entries", () => {
    const withAlloc = (a: Record<string, unknown>) => ({ ...valid, allocations: [a] });
    expect(() => BranchConfigSchema.parse(withAlloc({ coin: "ETH", weightPct: 100, leverage: 0 }))).toThrow();
    expect(() => BranchConfigSchema.parse(withAlloc({ coin: "ETH", weightPct: 100, leverage: 51 }))).toThrow();
    const dca = { coin: "ETH", amountUsd: 100, every: "weekly" };
    expect(() => BranchConfigSchema.parse({ ...valid, dca: [{ ...dca, amountUsd: 0 }] })).toThrow();
    expect(() => BranchConfigSchema.parse({ ...valid, dca: [{ ...dca, every: "daily" }] })).toThrow();
    expect(() => BranchConfigSchema.parse({ ...valid, dca: Array(9).fill(dca) })).toThrow();
  });
});

describe("MarketStateDataSchema", () => {
  const valid = {
    generated_at: "2026-08-30T00:00:00Z",
    headline: "Liquidity easing, risk-on",
    tldr: "Net liquidity up w/w.",
    domains: [
      {
        domain: "macro",
        summary: "Net liquidity rose.",
        signals: [{ label: "net_liquidity", value: "$6.1T", direction: "up" }],
      },
    ],
    thesis: {
      observe: "Rates fell.",
      infer: "Markets pricing a cut.",
      forecast: "base case: continued easing",
      disclaimer: "Not financial advice.",
    },
    risks: ["geopolitical escalation"],
  };

  test("parses a valid document", () => {
    expect(MarketStateDataSchema.parse(valid)).toMatchObject(valid);
  });

  test("rejects a domain missing summary", () => {
    const bad = { ...valid, domains: [{ domain: "macro", signals: [] }] };
    expect(() => MarketStateDataSchema.parse(bad)).toThrow();
  });
});

describe("SectorsDataSchema", () => {
  const valid = {
    generated_at: "2026-08-30T00:00:00Z",
    sectors: [
      {
        id: "defi",
        label: "DeFi",
        mindshare_score: 0.4,
        momentum: 0.2,
        rationale: "TVL rotating back into lending",
        tokens: ["AAVE", "COMP"],
        sources: ["defillama"],
      },
    ],
    rotations: [{ from: "memes", to: "defi", confidence: 0.6, trigger: "TVL inflow", note: "early" }],
  };

  test("parses a valid document", () => {
    expect(SectorsDataSchema.parse(valid)).toMatchObject(valid);
  });

  test("rejects mindshare_score out of [0,1]", () => {
    const bad = { ...valid, sectors: [{ ...valid.sectors[0]!, mindshare_score: 1.5 }] };
    expect(() => SectorsDataSchema.parse(bad)).toThrow();
  });

  test("rejects momentum out of [-1,1]", () => {
    const bad = { ...valid, sectors: [{ ...valid.sectors[0]!, momentum: 2 }] };
    expect(() => SectorsDataSchema.parse(bad)).toThrow();
  });
});

describe("HlMetaAndAssetCtxsResponseSchema", () => {
  test("parses the recorded Hyperliquid fixture", () => {
    const [meta, ctxs] = HlMetaAndAssetCtxsResponseSchema.parse(fixture);
    expect(meta.universe.map((u) => u.name)).toEqual(["BTC", "ETH", "ATOM", "MATIC", "DYDX"]);
    expect(ctxs.length).toBe(5);
    expect(ctxs[0]!.markPx).toBe("63846.0");
  });

  test("rejects a malformed payload", () => {
    expect(() => HlMetaAndAssetCtxsResponseSchema.parse({})).toThrow();
  });
});
