import { describe, expect, test } from "bun:test";
import type { SnapshotRow } from "../../shared/intel.js";
import { loadPricedIn, pricedIn, pricedInText } from "./pricedIn.js";
import { MemoryIntelStore } from "./store.js";

const now = new Date("2026-10-13T12:00:00Z");
const H = 3_600_000;

function snap(asset: string, ts: string, price: number, oiUsd: number | null): SnapshotRow {
  return { asset, ts, price, oiUsd, vol24h: null, funding: null, premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null };
}

const bar = (t: number, c: number) => ({ t, h: c + 1, l: c - 1, c });

describe("pricedIn (pure)", () => {
  test("percent moves since the baseline; OI null when either side lacks it", () => {
    expect(pricedIn({ price: 95.9, oiUsd: 920 }, { price: 100, oiUsd: 1000, ts: "2026-10-13T10:00:00.000Z" })).toEqual({
      pricePct: expect.closeTo(-4.1, 9),
      oiPct: expect.closeTo(-8, 9),
      since: "2026-10-13T10:00:00.000Z",
    });
    expect(pricedIn({ price: 101, oiUsd: null }, { price: 100, oiUsd: 1000, ts: "2026-10-13T10:00:00.000Z" })?.oiPct).toBeNull();
    expect(pricedIn({ price: 101, oiUsd: 1 }, { price: 0, oiUsd: 1, ts: "2026-10-13T10:00:00.000Z" })).toBeNull();
  });

  test("text suffix", () => {
    expect(pricedInText({ pricePct: -4.1, oiPct: -8, since: "x" })).toBe("already −4.1%, OI −8%");
    expect(pricedInText({ pricePct: 2.345, oiPct: null, since: "x" })).toBe("already +2.3%");
    expect(pricedInText({ pricePct: 0.01, oiPct: 0.2, since: "x" })).toBe("already 0.0%, OI 0%");
  });
});

describe("loadPricedIn", () => {
  test("uses the nearest snapshot at/after first_seen against the latest snapshot", async () => {
    const store = new MemoryIntelStore();
    await store.insertSnapshots([
      snap("SOL", "2026-10-13T09:45:00Z", 120, 2000), // before first_seen: ignored
      snap("SOL", "2026-10-13T10:15:00Z", 100, 1000),
      snap("SOL", "2026-10-13T11:45:00Z", 95.9, 920),
    ]);
    let candleCalls = 0;
    const p = await loadPricedIn({ store, now: () => now, candles1h: async () => (candleCalls++, []) }, "SOL", "2026-10-13T10:00:00Z");
    expect(p).toEqual({ pricePct: expect.closeTo(-4.1, 9), oiPct: expect.closeTo(-8, 9), since: "2026-10-13T10:15:00.000Z" });
    expect(pricedInText(p!)).toBe("already −4.1%, OI −8%");
    expect(candleCalls).toBe(0);
  });

  test("falls back to the 1h candle containing first_seen (oiPct null) when no snapshot is close enough", async () => {
    const store = new MemoryIntelStore();
    const seen = Date.parse("2026-10-13T06:20:00Z");
    // A snapshot exists, but 5 h after first_seen: too far to be the baseline. It still serves as "now".
    await store.insertSnapshots([snap("SOL", "2026-10-13T11:20:00Z", 90, 500)]);
    const hourOpen = Date.parse("2026-10-13T06:00:00Z");
    const candles = [bar(hourOpen - H, 99), bar(hourOpen, 100), bar(hourOpen + H, 97)];
    const p = await loadPricedIn({ store, now: () => now, candles1h: async () => candles }, "SOL", new Date(seen).toISOString());
    expect(p).toEqual({ pricePct: expect.closeTo(-10, 9), oiPct: null, since: "2026-10-13T07:00:00.000Z" });

    const noSnaps = await loadPricedIn({ store: new MemoryIntelStore(), now: () => now, candles1h: async () => candles }, "SOL", new Date(seen).toISOString());
    expect(noSnaps).toEqual({ pricePct: expect.closeTo(-3, 9), oiPct: null, since: "2026-10-13T07:00:00.000Z" });
  });

  test("null without data, for a future first_seen, and when a loader throws", async () => {
    const store = new MemoryIntelStore();
    const deps = { store, now: () => now, candles1h: async () => [] };
    expect(await loadPricedIn(deps, "SOL", "2026-10-13T10:00:00Z")).toBeNull();
    expect(await loadPricedIn(deps, "SOL", "2026-10-14T10:00:00Z")).toBeNull();
    expect(await loadPricedIn({ ...deps, candles1h: async () => Promise.reject(new Error("db down")) }, "SOL", "2026-10-13T10:00:00Z")).toBeNull();
  });
});
