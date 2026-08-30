import { describe, expect, test } from "bun:test";
import coingeckoFixture from "../../shared/fixtures/coingecko-global.json";
import fngFixture from "../../shared/fixtures/fng.json";
import defillamaFixture from "../../shared/fixtures/defillama-stablecoins.json";
import deribitFixture from "../../shared/fixtures/deribit-dvol.json";
import { parseCoinGecko, parseDeribit, parseFng, parseStablecoins } from "./cryptoContext";

describe("parseCoinGecko", () => {
  test("extracts total mcap and BTC dominance", () => {
    const points = parseCoinGecko(coingeckoFixture);
    expect(points).toEqual([
      { seriesId: "cg.total_mcap_usd", value: 2300000000000, units: "USD", description: expect.any(String) },
      { seriesId: "cg.btc_dominance", value: 54.2, units: "%", description: expect.any(String) },
    ]);
  });
});

describe("parseFng", () => {
  test("extracts the latest fear/greed value", () => {
    expect(parseFng(fngFixture)).toEqual([
      { seriesId: "fng.value", value: 42, units: "index", description: expect.any(String) },
    ]);
  });

  test("throws on a non-numeric value", () => {
    expect(() => parseFng({ data: [{ value: "n/a" }] })).toThrow();
  });
});

describe("parseStablecoins", () => {
  test("sums only peggedUSD circulating supply", () => {
    const points = parseStablecoins(defillamaFixture);
    expect(points[0]!.value).toBe(150000000000);
  });
});

describe("parseDeribit", () => {
  test("extracts the latest DVOL close", () => {
    const points = parseDeribit(deribitFixture);
    expect(points[0]!.value).toBe(61.2);
  });

  test("throws when the data array is empty of a close", () => {
    expect(() => parseDeribit({ result: { data: [] } })).toThrow();
  });
});
