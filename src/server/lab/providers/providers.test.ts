import { describe, expect, test } from "bun:test";
import cmPage1 from "./fixtures/cm-page1.json" with { type: "json" };
import cmPage2 from "./fixtures/cm-page2.json" with { type: "json" };
import fngFixture from "./fixtures/fng-history.json" with { type: "json" };
import stablesFixture from "./fixtures/llama-stablecoincharts.json" with { type: "json" };
import tvlFixture from "./fixtures/llama-chain-tvl.json" with { type: "json" };
import { cmAsset, createCmProvider, parseCmPage } from "./cm.js";
import { createFngProvider, parseFngHistory } from "./fng.js";
import { createHtProvider, htCoin, type HtDeps } from "./ht.js";
import { createLlamaProvider, parseChainTvl, parseStablecoinChart } from "./llama.js";
import { HttpError } from "./series.js";

const D0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;
const days = (n: number) => Array.from({ length: n }, (_, i) => D0 + i * DAY);

/** fetch stub: first matching url fragment wins; records requested urls. */
function stubFetch(routes: Array<[string, unknown, number?]>) {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: hit[2] ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, urls };
}

describe("fng", () => {
  test("parses the full history ascending", () => {
    expect(parseFngHistory(fngFixture)).toEqual({ t: days(4), v: [65, 70, 65, 71] });
  });

  test("fetch clips to the range", async () => {
    const { fn, urls } = stubFetch([["alternative.me", fngFixture]]);
    const s = await createFngProvider(fn).fetch("value", "BTC", D0 + DAY, D0 + 2 * DAY);
    expect(s).toEqual({ t: [D0 + DAY, D0 + 2 * DAY], v: [70, 65] });
    expect(urls[0]).toContain("limit=0");
  });
});

describe("llama", () => {
  test("stablecoin chart skips points without peggedUSD", () => {
    expect(parseStablecoinChart(stablesFixture)).toEqual({ t: [D0, D0 + DAY, D0 + 3 * DAY], v: [130e9, 130.5e9, 131.2e9] });
  });

  test("chain tvl", () => {
    expect(parseChainTvl(tvlFixture)).toEqual({ t: days(3), v: [52.1e9, 53.4e9, 51.9e9] });
  });

  test("fetch routes each key to its endpoint", async () => {
    const { fn } = stubFetch([
      ["stablecoincharts", stablesFixture],
      ["historicalChainTvl", tvlFixture],
    ]);
    const p = createLlamaProvider(fn);
    expect((await p.fetch("defi_tvl", "", D0, D0 + 9 * DAY)).v).toEqual([52.1e9, 53.4e9, 51.9e9]);
    expect((await p.fetch("stablecoin_cap", "", D0, D0 + 9 * DAY)).t.length).toBe(3);
  });
});

describe("cm", () => {
  test("parseCmPage reads the metric column and the next page", () => {
    const page = parseCmPage(cmPage1, "CapMVRVCur");
    expect(page.points).toEqual([
      { t: D0, v: 1.92 },
      { t: D0 + DAY, v: 1.98 },
    ]);
    expect(page.next).toContain("next_page_token");
    expect(parseCmPage(cmPage2, "CapMVRVCur").next).toBeNull();
  });

  test("fetch follows next_page_url and skips rows without the metric", async () => {
    const { fn, urls } = stubFetch([
      ["next_page_token", cmPage2],
      ["asset-metrics", cmPage1],
    ]);
    const s = await createCmProvider(fn).fetch("CapMVRVCur", "BTC", D0, D0 + 3 * DAY);
    expect(s).toEqual({ t: days(3), v: [1.92, 1.98, 1.95] });
    expect(urls).toHaveLength(2);
    const first = new URL(urls[0]!);
    expect(first.searchParams.get("assets")).toBe("btc");
    expect(first.searchParams.get("metrics")).toBe("CapMVRVCur");
    expect(first.searchParams.get("start_time")).toBe("2024-01-01");
    expect(first.searchParams.get("end_time")).toBe("2024-01-04");
    expect(first.searchParams.get("frequency")).toBe("1d");
  });

  test("a next_page_url off the CM API stops paging with an error", async () => {
    const evil = { ...cmPage1, next_page_url: "https://evil.test/v4/timeseries/asset-metrics?next_page_token=x" };
    const { fn, urls } = stubFetch([["asset-metrics", evil]]);
    await expect(createCmProvider(fn).fetch("CapMVRVCur", "BTC", D0, D0 + 3 * DAY)).rejects.toThrow("unexpected next_page_url");
    expect(urls).toHaveLength(1);
  });

  test("a refused metric throws with the status", async () => {
    const { fn } = stubFetch([["asset-metrics", { error: { type: "forbidden" } }, 403]]);
    const err = await createCmProvider(fn).fetch("HashRate", "ETH", D0, D0 + DAY).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as Error).message).toContain("403");
  });

  test("asset map and metric catalogue", () => {
    expect(cmAsset("BTC")).toBe("btc");
    expect(cmAsset("kPEPE")).toBe("pepe");
    const m = createCmProvider().metrics();
    expect(m).toHaveLength(12);
    expect(m.every((d) => d.lagDays === 1 && d.scope === "asset")).toBe(true);
    expect(m.find((d) => d.key === "PriceUSD")!.category).toBe("price");
    expect(m.find((d) => d.key === "CapMVRVCur")!.category).toBe("onchain");
  });
});

describe("ht", () => {
  const H = 3_600_000;
  function deps(over: Partial<HtDeps> = {}): HtDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      hasDb: () => true,
      ensureHistory: async (coin) => void calls.push(`ensure:${coin}`),
      candles: async () => [
        { t: D0, o: 100, h: 110, l: 90, c: 100, v: 2 },
        { t: D0 + DAY, o: 100, h: 105, l: 95, c: 102, v: 3 },
      ],
      funding: async () => [
        { t: D0, rate: 0.0001, premium: 0.001 },
        { t: D0 + H, rate: 0.0002, premium: 0.003 },
        { t: D0 + DAY, rate: -0.0001, premium: -0.001 },
      ],
      series: async (id) => {
        calls.push(`series:${id}`);
        return [
          { t: D0 + H, v: 1 },
          { t: D0 + 20 * H, v: 2 },
          { t: D0 + DAY + H, v: 3 },
        ];
      },
      liveCandles: async () => {
        calls.push("liveCandles");
        return [{ t: D0, o: 1, h: 1, l: 1, c: 1, v: 1 }];
      },
      liveFunding: async () => {
        calls.push("liveFunding");
        return [{ t: D0, rate: 0.5, premium: 0 }];
      },
      ...over,
    };
  }
  const R = [D0, D0 + 5 * DAY] as const;

  test("price, volume and range from stored candles, with a backfill first", async () => {
    const d = deps();
    const p = createHtProvider(d);
    expect(await p.fetch("price", "btc", ...R)).toEqual({ t: [D0, D0 + DAY], v: [100, 102] });
    expect((await p.fetch("volume", "BTC", ...R)).v).toEqual([200, 306]);
    expect((await p.fetch("range", "BTC", ...R)).v).toEqual([0.2, 10 / 102]);
    expect(d.calls.filter((c) => c === "ensure:BTC")).toHaveLength(1); // memoized per coin
  });

  test("funding is a daily sum, premium a daily mean", async () => {
    const p = createHtProvider(deps());
    const f = await p.fetch("funding", "BTC", ...R);
    expect(f.t).toEqual([D0, D0 + DAY]);
    expect(f.v[0]).toBeCloseTo(0.0003, 12);
    expect((await p.fetch("premium", "BTC", ...R)).v).toEqual([0.002, -0.001]);
  });

  test("observation metrics take the last value per day from the right series", async () => {
    const d = deps();
    const p = createHtProvider(d);
    expect(await p.fetch("oi", "ETH", ...R)).toEqual({ t: [D0, D0 + DAY], v: [2, 3] });
    await p.fetch("elfa_share", "SOL", ...R);
    await p.fetch("fred.DGS10", "BTC", ...R);
    await p.fetch("btc_dominance", "BTC", ...R);
    expect(d.calls).toContain("series:hl.oi.ETH");
    expect(d.calls).toContain("series:elfa.share_24h.SOL");
    expect(d.calls).toContain("series:fred.DGS10");
    expect(d.calls).toContain("series:cg.btc_dominance");
  });

  test("no DB: live Hyperliquid for price and funding, empty for stored series", async () => {
    const d = deps({ hasDb: () => false });
    const p = createHtProvider(d);
    expect((await p.fetch("price", "BTC", ...R)).v).toEqual([1]);
    expect((await p.fetch("funding", "BTC", ...R)).v).toEqual([0.5]);
    expect(await p.fetch("oi", "BTC", ...R)).toEqual({ t: [], v: [] });
    expect(d.calls).toEqual(["liveCandles", "liveFunding"]);
  });

  test("an empty or failing DB read falls back to live", async () => {
    const p = createHtProvider(deps({ candles: async () => [], funding: async () => Promise.reject(new Error("db down")) }));
    expect((await p.fetch("price", "BTC", ...R)).v).toEqual([1]);
    expect((await p.fetch("funding", "BTC", ...R)).v).toEqual([0.5]);
  });

  test("catalogue: asset metrics, stored globals, every FRED series", () => {
    const ids = createHtProvider(deps()).metrics().map((m) => m.id);
    for (const id of ["ht:price", "ht:volume", "ht:range", "ht:funding", "ht:premium", "ht:oi", "ht:elfa_mentions", "ht:elfa_share", "ht:fng", "ht:btc_dominance", "ht:total_mcap", "ht:stablecoin_cap", "ht:dvol", "ht:fred.WALCL", "ht:fred.net_liquidity"])
      expect(ids).toContain(id);
    expect(htCoin("eth")).toBe("ETH");
    expect(htCoin("kPEPE")).toBe("kPEPE");
  });

  test("unknown key throws", async () => {
    await expect(createHtProvider(deps()).fetch("nope", "BTC", ...R)).rejects.toThrow("unknown ht metric");
  });
});
