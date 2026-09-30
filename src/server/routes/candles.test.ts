import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { candlesRoute, type CandlesDeps, type CandlesResponse } from "./candles.js";

const H = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

function deps(over: Partial<CandlesDeps> = {}): CandlesDeps & { pages: unknown[] } {
  const pages: unknown[] = [];
  return {
    pages,
    resolveCoin: async (p) => (p.toLowerCase() === "kpepe" ? "kPEPE" : p.toUpperCase()),
    touch: async () => {},
    readPage: async (coin, tf, opts) => {
      pages.push({ coin, tf, ...opts });
      return {
        bars: [0, 1, 2].map((i) => ({ t: T0 + i * H, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, src: "hl" })),
        hasMore: true,
        error: null,
      };
    },
    syncFunding: async () => ({ pages: 1, from: T0, complete: false }),
    funding: async () => [{ t: T0 + H, rate: 0.0001, premium: 0.0003 }],
    oi: async () => [{ t: T0 + 30 * 60_000, v: 5e8 }],
    ...over,
  };
}

const app = (d: CandlesDeps) => new Hono().route("/candles", candlesRoute(d));

describe("GET /candles/:coin", () => {
  test("400s on an unsupported tf", async () => {
    const res = await app(deps()).request("/candles/BTC?tf=3d");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid query" });
  });

  test("400s on a bad before / limit", async () => {
    expect((await app(deps()).request("/candles/BTC?before=abc")).status).toBe(400);
    expect((await app(deps()).request("/candles/BTC?limit=999999")).status).toBe(400);
  });

  test("serves a page with funding, premium and OI joined onto the bars", async () => {
    const d = deps();
    const res = await app(d).request("/candles/kpepe?tf=1h&before=1704200000000&limit=500");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CandlesResponse;
    expect(d.pages[0]).toEqual({ coin: "kPEPE", tf: "1h", before: 1704200000000, limit: 500 });
    expect(body.coin).toBe("kPEPE");
    expect(body.hasMore).toBe(true);
    expect(body.bars.map((b) => b.f)).toEqual([0.0001, null, null]);
    expect(body.bars[0]!.p).toBe(0.0003);
    expect(body.bars.map((b) => b.oi)).toEqual([5e8, null, null]);
    expect(body.funding).toEqual({ from: T0, complete: false });
    expect(body.oi.from).toBe(T0 + 30 * 60_000);
  });

  test("defaults to 1d and a full page; overlay failures degrade to bare candles", async () => {
    const d = deps({
      syncFunding: async () => {
        throw new Error("HL down");
      },
      funding: async () => {
        throw new Error("db");
      },
    });
    const body = (await (await app(d).request("/candles/BTC")).json()) as CandlesResponse;
    expect(d.pages[0]).toEqual({ coin: "BTC", tf: "1d", before: undefined, limit: 1500 });
    expect(body.bars).toHaveLength(3);
    expect(body.bars.every((b) => b.f === null)).toBe(true);
    expect(body.funding).toEqual({ from: null, complete: false });
  });
});
