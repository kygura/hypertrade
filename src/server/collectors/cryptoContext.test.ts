import { describe, expect, test } from "bun:test";
import coingeckoFixture from "../../shared/fixtures/coingecko-global.json" with { type: "json" };
import fngFixture from "../../shared/fixtures/fng.json" with { type: "json" };
import defillamaFixture from "../../shared/fixtures/defillama-stablecoins.json" with { type: "json" };
import deribitFixture from "../../shared/fixtures/deribit-dvol.json" with { type: "json" };
import { parseCoinGecko, parseDeribit, parseFng, parseStablecoins, collectCryptoContext, type CryptoContextDbDeps } from "./cryptoContext.js";
import type { Observation } from "../db.js";

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

describe("collectCryptoContext orchestration", () => {
  function fakeDeps() {
    const written: Observation[] = [];
    const deps: CryptoContextDbDeps = {
      ensureSeries: async () => {},
      upsertObservations: async (rows) => {
        written.push(...rows);
        return rows.length;
      },
      recordCollectorRun: async () => {},
    };
    return { deps, written };
  }

  function fetchByUrl(handlers: Record<string, () => Promise<Response>>): typeof fetch {
    return (async (url: string) => {
      for (const [needle, handler] of Object.entries(handlers)) {
        if (url.includes(needle)) return handler();
      }
      throw new Error(`unexpected url in test: ${url}`);
    }) as unknown as typeof fetch;
  }

  test("one dead source doesn't kill the others", async () => {
    const { deps, written } = fakeDeps();
    const fetchFn = fetchByUrl({
      "api.coingecko.com": async () => new Response(JSON.stringify(coingeckoFixture)),
      "alternative.me": async () => {
        throw new Error("network down");
      },
      "stablecoins.llama.fi": async () => new Response(JSON.stringify(defillamaFixture)),
      "deribit.com": async () => new Response(JSON.stringify(deribitFixture)),
    });

    const result = await collectCryptoContext(fetchFn, deps);

    expect(result.ok).toBe(true);
    expect(result.error).toContain("fng");
    expect(written.map((o) => o.seriesId)).not.toContain("fng.value");
    expect(written.map((o) => o.seriesId)).toContain("cg.total_mcap_usd");
    expect(written.map((o) => o.seriesId)).toContain("llama.stablecoin_cap_usd");
    expect(written.map((o) => o.seriesId)).toContain("deribit.btc_dvol");
  });

  test("all sources failing returns an error status and writes nothing", async () => {
    const { deps, written } = fakeDeps();
    const fetchFn = fetchByUrl({
      "api.coingecko.com": async () => new Response("", { status: 500 }),
      "alternative.me": async () => new Response("", { status: 500 }),
      "stablecoins.llama.fi": async () => new Response("", { status: 500 }),
      "deribit.com": async () => new Response("", { status: 500 }),
    });

    const result = await collectCryptoContext(fetchFn, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.written).toBe(0);
    expect(written).toHaveLength(0);
  });
});
