import { describe, expect, test } from "bun:test";
import type { AccountState } from "../desk/types.js";
import { loadExposure, watchedAssets } from "./positions.js";
import { MemoryIntelStore } from "./store.js";

const acct = (venue: string, over: Partial<AccountState> = {}): AccountState => ({
  venue,
  equityUsd: 10_000,
  dayPnlUsd: 0,
  available: true,
  positions: [{ coin: "ETH", side: "short", size: 2, entryPx: 4000, markPx: 3900, stopPx: 4200, tpPx: null, unrealizedPnl: 200, notionalUsd: 7800 }],
  ...over,
});

async function storeWithSol() {
  const store = new MemoryIntelStore();
  await store.createManualPosition({ asset: "SOL", side: "long", size: 10, entryPx: 150, stopPx: 140, leverage: 3, venue: "binance" });
  return store;
}

describe("loadExposure", () => {
  test("unifies manual, hl and desk", async () => {
    const store = await storeWithSol();
    const res = await loadExposure({
      store,
      marks: async () => ({ SOL: 160 }),
      watchAddress: "0x" + "1".repeat(40),
      readHl: async () => acct("hyperliquid (watch)"),
      deskAccount: async () => acct("paper", { positions: [] }),
    });
    expect(res.sources).toEqual([{ source: "manual", ok: true }, { source: "hl", ok: true }, { source: "desk", ok: true }]);
    expect(res.positions).toHaveLength(2);
    expect(res.positions[0]).toMatchObject({ source: "manual", asset: "SOL", markPx: 160, notionalUsd: 1600, unrealizedPnl: 100, stopPx: 140, leverage: 3 });
    expect(res.positions[1]).toMatchObject({ id: "hl:ETH", source: "hl", side: "short", notionalUsd: 7800, leverage: 0.78, venue: "hyperliquid (watch)" });
    expect(res.totalNotionalUsd).toBe(9400);
  });

  test("failing sources are reported, never thrown", async () => {
    const store = await storeWithSol();
    const res = await loadExposure({
      store,
      marks: async () => {
        throw new Error("ctxs down");
      },
      watchAddress: "0x" + "1".repeat(40),
      readHl: async () => acct("hyperliquid (watch)", { available: false, positions: [], note: "HTTP 429" }),
      deskAccount: async () => {
        throw new Error("DATABASE_URL is not set");
      },
    });
    expect(res.sources).toEqual([
      { source: "manual", ok: true, error: "marks unavailable: ctxs down" },
      { source: "hl", ok: false, error: "HTTP 429" },
      { source: "desk", ok: false, error: "DATABASE_URL is not set" },
    ]);
    // Without a mark the manual position counts at entry and has no PnL.
    expect(res.positions).toEqual([expect.objectContaining({ asset: "SOL", markPx: 150, notionalUsd: 1500, unrealizedPnl: null })]);
  });

  test("store failure and unconfigured sources", async () => {
    const res = await loadExposure({
      store: { listManualPositions: async () => Promise.reject(new Error("db down")) },
      marks: async () => ({}),
    });
    expect(res.positions).toEqual([]);
    expect(res.totalNotionalUsd).toBe(0);
    expect(res.sources.map((s) => [s.source, s.ok])).toEqual([["manual", false], ["hl", false], ["desk", false]]);
    expect(res.sources[1]!.error).toContain("DESK_WATCH_ADDRESS");
  });
});

describe("watchedAssets", () => {
  test("intel_watchlist wins; empty falls back to DESK_WATCHLIST", async () => {
    const store = new MemoryIntelStore();
    expect(await watchedAssets(store, { DESK_WATCHLIST: "btc, hype" })).toEqual(["BTC", "HYPE"]);
    expect(await watchedAssets(store, {})).toEqual(["BTC", "ETH", "SOL", "HYPE"]);
    await store.putWatchlist([{ asset: "kPEPE", tags: ["meme"] }]);
    expect(await watchedAssets(store, { DESK_WATCHLIST: "BTC" })).toEqual(["kPEPE"]);
  });
});
