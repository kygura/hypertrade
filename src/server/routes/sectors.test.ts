import { describe, expect, test } from "bun:test";
import { SectorsDataSchema } from "../../shared/schemas";
import latest from "../../../data/sectors/latest.json";
import dated from "../../../data/sectors/2026-08-30.json";
import { enrichSector } from "./sectors";
import type { AssetCtx } from "../../shared/types";

function ctx(name: string, openInterest: number, markPx: number, funding: number): AssetCtx {
  return {
    name,
    szDecimals: 2,
    markPx,
    oraclePx: markPx,
    midPx: markPx,
    dayNtlVlm: 0,
    prevDayPx: markPx,
    openInterest,
    funding,
    premium: 0,
    dayChange: 0,
    isDelisted: false,
  };
}

describe("seed data", () => {
  test("latest.json parses against SectorsDataSchema", () => {
    expect(() => SectorsDataSchema.parse(latest)).not.toThrow();
  });

  test("dated copy matches latest.json", () => {
    expect(dated).toEqual(latest);
  });
});

describe("enrichSector", () => {
  const ctxs = [ctx("BTC", 100, 60_000, 0.0001), ctx("ETH", 200, 3_000, 0.0002)];

  test("sums OI in USD and averages funding across matched tokens", () => {
    const result = enrichSector(["BTC", "ETH"], ctxs);
    expect(result.oi_usd_total).toBe(100 * 60_000 + 200 * 3_000);
    expect(result.avg_funding).toBeCloseTo(0.00015, 10);
    expect(result.names_matched).toBe(2);
  });

  test("skips unmatched tokens silently", () => {
    const result = enrichSector(["BTC", "NOTLISTED"], ctxs);
    expect(result.names_matched).toBe(1);
    expect(result.oi_usd_total).toBe(100 * 60_000);
  });

  test("returns zeros when nothing matches", () => {
    expect(enrichSector(["NOPE"], ctxs)).toEqual({ oi_usd_total: 0, avg_funding: 0, names_matched: 0, tokenRows: [] });
  });

  test("returns a per-matched-token row for the sector drill-in table", () => {
    const result = enrichSector(["BTC", "ETH", "NOTLISTED"], ctxs);
    expect(result.tokenRows).toEqual([
      { coin: "BTC", markPx: 60_000, dayChangePct: 0, openInterestUsd: 100 * 60_000, funding: 0.0001 },
      { coin: "ETH", markPx: 3_000, dayChangePct: 0, openInterestUsd: 200 * 3_000, funding: 0.0002 },
    ]);
  });
});
