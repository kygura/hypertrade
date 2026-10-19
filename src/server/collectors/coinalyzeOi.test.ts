import { describe, expect, test } from "bun:test";
import fixture from "../../shared/fixtures/coinalyze-oi.json" with { type: "json" };
import { createOiBackfill, OiRateLimited, hlSymbolMap, oiRows, parseDailyOi, type OiRow } from "./coinalyzeOi.js";

const DAY = 86_400_000;
// Recorded 2026-10-19 from Coinalyze: /exchanges, the Hyperliquid rows of /future-markets, BTC.H daily open-interest-history (convert_to_usd=false).
const bars = [...parseDailyOi(fixture["open-interest-history"])].sort(([a], [b]) => a - b);
const D0 = bars.at(-1)![0]; // last bar (2026-10-19, still open)
const NOW = D0 + 12 * 3_600_000;
const coinsOf = (d: number) => bars.find(([t]) => t === d)![1];

describe("coinalyze OI backfill", () => {
  test("parses the recorded HL symbol map and daily bars (coins, keyed by UTC day start)", () => {
    expect(hlSymbolMap(fixture.exchanges, fixture["future-markets"]).get("BTC")).toBe("BTC.H");
    expect(bars.length).toBeGreaterThan(700);
    expect(bars.every(([t, v], i) => t % DAY === 0 && v > 0 && (i === 0 || t - bars[i - 1]![0] === DAY))).toBe(true);
  });

  test("USD = coins x same-day close, stamped 23:59:59Z; skips open day, existing days and days without a candle", () => {
    const coins = new Map(bars);
    const closes = new Map([[D0 - 3 * DAY, 50_000], [D0 - DAY, 60_000], [D0, 70_000]]); // D0-2d has no candle
    const rows = oiRows("BTC", coins, closes, new Set([D0 - 3 * DAY]), NOW);
    expect(rows).toEqual([{ seriesId: "hl.oi.BTC", ts: new Date(D0 - 1000), value: coinsOf(D0 - DAY) * 60_000 }]);
  });

  test("idempotent: second run over the store inserts nothing, live points are never replaced", async () => {
    const store = new Map<number, number>([[D0 - DAY - 5000, 42]]); // live point on D0-1d (ts is an instant, not 23:59:59)
    const calls: string[] = [];
    const run = createOiBackfill({
      fetch: (async (u: unknown) => {
        const path = new URL(String(u)).pathname.replace(/^\/v1\//, "");
        calls.push(path);
        return Response.json((fixture as Record<string, unknown>)[path]);
      }) as unknown as typeof fetch,
      env: { COINALYZE_API_KEY: "k" },
      now: () => NOW,
      sleep: async () => {},
      candles: async () => [3, 2, 1, 0].map((k) => ({ t: D0 - k * DAY, c: 100 })),
      stored: async () => [...store.keys()].map((t) => ({ t })),
      insert: async (_c: string, rows: OiRow[]) => void rows.forEach((r) => store.set(r.ts.getTime(), r.value)),
    });
    expect(await run("BTC")).toBe(2); // D0-3d, D0-2d; D0-1d is live, D0 is open
    expect(store.get(D0 - DAY - 5000)).toBe(42);
    expect(await run("BTC")).toBe(0);
    expect(await run("DOGE")).toBe(0); // no HL symbol
    expect(calls.filter((c) => c === "open-interest-history").length).toBe(2); // BTC twice (under 365 stored days it refetches, inserting nothing)
  });

  test("no key: no call, no rows", async () => {
    const run = createOiBackfill({ fetch: (() => { throw new Error("network"); }) as never, env: {}, now: () => NOW, sleep: async () => {}, candles: async () => [], stored: async () => [], insert: async () => {} });
    expect(await run("BTC")).toBe(0);
  });

  test("a failed or empty symbol map is cached for 1h: one attempt, then no calls; retried after", async () => {
    for (const respond of [() => new Response("x", { status: 500 }), () => Response.json({ exchanges: [], "future-markets": [] }) ]) {
      let t = NOW;
      let n = 0;
      const run = createOiBackfill({
        fetch: (async (u: unknown) => ((n++), respond().status === 500 ? respond() : Response.json((({ exchanges: [], "future-markets": [] }) as Record<string, unknown>)[new URL(String(u)).pathname.slice(4)]))) as never,
        env: { COINALYZE_API_KEY: "k" }, now: () => t, sleep: async () => {}, candles: async () => [], stored: async () => [], insert: async () => {},
      });
      await expect(run("BTC")).rejects.toThrow();
      const first = n;
      await expect(run("ETH")).rejects.toBeInstanceOf(OiRateLimited);
      expect(n).toBe(first);
      t += 3_600_001;
      await expect(run("BTC")).rejects.toThrow();
      expect(n).toBeGreaterThan(first);
    }
  });

  test("429 on the history call throws OiRateLimited", async () => {
    const run = createOiBackfill({
      fetch: (async (u: unknown) => { const p = new URL(String(u)).pathname.replace(/^\/v1\//, ""); return p === "open-interest-history" ? new Response("", { status: 429 }) : Response.json((fixture as Record<string, unknown>)[p]); }) as never,
      env: { COINALYZE_API_KEY: "k" }, now: () => NOW, sleep: async () => {}, candles: async () => [], stored: async () => [], insert: async () => {},
    });
    await expect(run("BTC")).rejects.toBeInstanceOf(OiRateLimited);
  });
});
