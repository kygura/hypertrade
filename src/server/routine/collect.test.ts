import { describe, expect, test } from "bun:test";
import type { AssetCtx } from "../../shared/types.js";
import { collect, condenseHlCycles, nextCatalysts, parseFredCsv, stablecoinRead, summariseHl } from "./collect.js";

const NOW = new Date("2026-10-18T10:00:00Z");

describe("collect parsers", () => {
  test("FRED CSV skips '.' rows and headers", () => {
    expect(parseFredCsv("observation_date,DGS10\n2026-10-14,5.08\n2026-10-15,.\n2026-10-16,5.10\n")).toEqual([
      { date: "2026-10-14", value: 5.08 },
      { date: "2026-10-16", value: 5.1 },
    ]);
  });

  test("stablecoins: now vs 7 and 30 rows back", () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ date: String(1_790_000_000 + i * 86_400), totalCirculatingUSD: { peggedUSD: 100 + i } }));
    expect(stablecoinRead(rows)).toEqual({ nowUsd: 130, d7Pct: 5.69, d30Pct: 30, date: "2026-10-21" });
    expect(stablecoinRead([])).toBeNull();
  });

  test("hl-cycles: ms epochs become dates, a 3 h old refresh is stale, lenses keep key/score/band", () => {
    const read = condenseHlCycles(
      {
        asOf: Date.parse("2026-10-17T00:00:00Z"),
        regime: { state: "mild_risk_on", since: Date.parse("2026-10-09T00:00:00Z"), conditions: [{ key: "a", on: true }, { key: "b", on: false }] },
        compass: { headline: { score: 47.8, band: "Neutral" }, lenses: [{ key: "macro", score: 32.9, band: "Restrictive", inputs: [1, 2, 3] }] },
        flips: [{ t: 1, from: "a", to: "b" }, { t: 3, from: "c", to: "d" }, { t: 2, from: "e", to: "f" }, { t: 0, from: "g", to: "h" }],
      },
      { lastRefresh: NOW.getTime() - 3 * 3_600_000 },
      NOW,
    );
    expect(read.asOf).toBe("2026-10-17");
    expect(read.stale).toBe(true);
    expect(read.regime).toMatchObject({ state: "mild_risk_on", since: "2026-10-09", conditionsOn: ["a"] });
    expect(read.compass!.lenses).toEqual([{ key: "macro", score: 32.9, band: "Restrictive" }]);
    expect(read.flips.map((f) => f.to)).toEqual(["b", "f", "d"]);
    expect(() => condenseHlCycles({ regime: { state: 5 } }, null, NOW)).toThrow();
  });

  test("HL summary: majors first, then the top by OI in USD; delisted dropped", () => {
    const ctx = (name: string, oi: number, mark = 10, isDelisted = false) =>
      ({ name, markPx: mark, openInterest: oi, funding: 0.00001, dayChange: 0.01, dayNtlVlm: 5, isDelisted }) as AssetCtx;
    const rows = summariseHl([ctx("AAA", 1), ctx("BTC", 1, 80_000), ctx("BBB", 100), ctx("DEAD", 1e9, 10, true)]);
    expect(rows.map((r) => r.name)).toEqual(["BTC", "BBB", "AAA"]);
    expect(rows[0]).toMatchObject({ oiUsd: 80_000, chg24hPct: 1, fundingAnnPct: 8.76 });
  });

  test("next catalysts come from the intel calendar, soonest first", () => {
    expect(nextCatalysts(NOW).map((c) => c.kind)).toEqual(["fomc", "nfp", "cpi"]);
  });
});

describe("collect failures become gaps", () => {
  test("every source down: no throw, one gap per source, FRED retried once on a transport error", async () => {
    let fredCalls = 0;
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("fred.stlouisfed.org")) {
        fredCalls++;
        throw new TypeError("stream reset");
      }
      if (url.includes("hl-cycles")) return new Response("<html>", { status: 200 });
      return new Response("down", { status: 503 });
    }) as typeof fetch;
    const hl = {
      metaAndCtxs: async () => {
        throw new Error("HL request failed: 503");
      },
      candles: async () => {
        throw new Error("HL request failed: 503");
      },
    };
    const pack = await collect({ env: { APP_URL: "https://app.invalid", LAB_API_TOKEN: "t" }, now: NOW, fetch: f, hl, openPaths: [{ asset: "SOL", since: "2026-10-17T00:00:00Z" }] });
    expect(pack.hl).toBeNull();
    expect(pack.marks).toEqual({});
    expect(fredCalls).toBe(14); // 7 series × (try + one retry)
    const sources = pack.gaps.map((g) => g.source);
    for (const s of ["hyperliquid.metaAndAssetCtxs", "hyperliquid.candles.BTC.1d", "hyperliquid.candles.SOL.1h", "hl-cycles.vector", "fred.DGS10", "yahoo.^VIX", "alternative.me.fng", "defillama.stablecoins", "app.metrics", "lab.market_pulse"])
      expect(sources).toContain(s);
    expect(pack.gaps.find((g) => g.source === "app.metrics")!.status).toBe(503);
    expect(pack.gaps.find((g) => g.source === "app.metrics")!.detail).toBe("HTTP 503"); // no response body in the prompt
    expect(pack.gaps.find((g) => g.source === "hl-cycles.vector")!.detail).toBe("response is not JSON");
    expect(pack.gaps.find((g) => g.source === "hl-cycles.vector")!.status).toBe("bad-json");
    expect(pack.app).toBeNull();
  });
});
