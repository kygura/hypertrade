import { describe, expect, test } from "bun:test";
import fixture from "../../shared/fixtures/coinalyze-oi.json" with { type: "json" };
import { createOiBackfill, hlSymbolMap, oiRows, parseDailyOi, type OiRow } from "./coinalyzeOi.js";

const DAY = 86_400_000;
const D0 = 1791936000 * 1000; // 2026-10-14T00:00Z, the fixture's last bar
const NOW = D0 + 12 * 3_600_000; // mid-day: the D0 bar is still open

describe("coinalyze OI backfill", () => {
  test("parses the HL symbol map and daily bars (coins, keyed by UTC day start)", () => {
    expect([...hlSymbolMap(fixture.exchanges, fixture["future-markets"])]).toEqual([["BTC", "BTCUSD.H"], ["ETH", "ETHUSD.H"]]);
    expect([...parseDailyOi(fixture["open-interest-history"])]).toEqual([[D0 - 3 * DAY, 1003], [D0 - 2 * DAY, 1002], [D0 - DAY, 1001], [D0, 1000]]);
  });

  test("USD = coins x same-day close, stamped 23:59:59Z; skips open day, existing days and days without a candle", () => {
    const coins = parseDailyOi(fixture["open-interest-history"]);
    const closes = new Map([[D0 - 3 * DAY, 50_000], [D0 - DAY, 60_000], [D0, 70_000]]); // D0-2d has no candle
    const rows = oiRows("BTC", coins, closes, new Set([D0 - 3 * DAY]), NOW);
    expect(rows).toEqual([{ seriesId: "hl.oi.BTC", ts: new Date(D0 - 1000), value: 1001 * 60_000 }]);
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
    expect(calls.filter((c) => c === "open-interest-history").length).toBe(2);
  });

  test("no key: no call, no rows", async () => {
    const run = createOiBackfill({ fetch: (() => { throw new Error("network"); }) as never, env: {}, now: () => NOW, sleep: async () => {}, candles: async () => [], stored: async () => [], insert: async () => {} });
    expect(await run("BTC")).toBe(0);
  });
});
