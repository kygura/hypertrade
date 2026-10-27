import { describe, expect, test } from "bun:test";
import { assetClass, dexOf, tickerOf } from "./assetClass.js";

describe("assetClass", () => {
  test("main-dex perps are crypto", () => {
    expect(assetClass("BTC")).toBe("crypto");
    expect(assetClass("kPEPE")).toBe("crypto");
  });

  test("HIP-3 tickers map to their class, unknown tickers to equity", () => {
    expect(assetClass("xyz:GOLD")).toBe("commodity");
    expect(assetClass("flx:OIL")).toBe("commodity");
    expect(assetClass("xyz:SP500")).toBe("index");
    expect(assetClass("xyz:EUR")).toBe("fx");
    expect(assetClass("para:10Y")).toBe("rates");
    expect(assetClass("hyna:ETH")).toBe("crypto");
    expect(assetClass("xyz:NVDA")).toBe("equity");
    expect(assetClass("vntl:SPACEX")).toBe("equity");
  });

  test("splits dex and ticker", () => {
    expect(dexOf("xyz:NVDA")).toBe("xyz");
    expect(tickerOf("xyz:NVDA")).toBe("NVDA");
    expect(dexOf("BTC")).toBe("");
    expect(tickerOf("BTC")).toBe("BTC");
  });
});
