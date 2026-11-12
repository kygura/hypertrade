import { describe, expect, test } from "bun:test";
import { approveBlock, approveBlockOf, dbPlatformContext, MAX_MID_AGE_SEC } from "./context.js";
import { MemoryPlatformStore } from "./store-memory.js";

describe("approveBlock (P0.15 freshness gate)", () => {
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  const base = { coin: "ETH", midAgeSec: 1 as number | null, lastScanAt: new Date(now - 30_000) as Date | null, now, scanIntervalSec: 60 };
  test.each([
    ["fresh mid and scan", {}, null],
    ["no mid", { midAgeSec: null }, "no live mid for ETH"],
    ["mid at the limit passes", { midAgeSec: MAX_MID_AGE_SEC }, null],
    ["mid over the limit", { midAgeSec: 31.4 }, "ETH mid is 31 s old (limit 30 s)"],
    ["no scan yet", { lastScanAt: null }, "the last scan is older than twice the scan interval"],
    ["scan older than twice the interval", { lastScanAt: new Date(now - 121_000) }, "the last scan is older than twice the scan interval"],
    ["the mid is checked before the scan", { midAgeSec: null, lastScanAt: null }, "no live mid for ETH"],
  ] as const)("%s", (_, over, want) => {
    expect(approveBlock({ ...base, ...over })).toBe(want);
  });
});

describe("dbPlatformContext mids (no worker)", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const scanned = async () => { const store = new MemoryPlatformStore(); await store.saveNearMisses(new Date(now - 600_000).toISOString(), []); return store; };

  test("a fetched mid is fresh, then ages past the gate when Hyperliquid stops answering", async () => {
    let up = true;
    const ctx = dbPlatformContext(await scanned(), { info: (async () => { if (!up) throw new Error("offline"); return { ETH: "4000.5", JUNK: "x" }; }) as never });
    expect(ctx.midAge("ETH", now)).toBeNull();
    expect(await approveBlockOf(ctx, "ETH", now)).toBeNull();
    expect(ctx.mid("ETH")).toBe(4000.5);
    expect(ctx.mid("JUNK")).toBeNull();
    expect(await approveBlockOf(ctx, "SOL", now)).toBe("no live mid for SOL");
    up = false;
    expect(await approveBlockOf(ctx, "ETH", now + 20_000)).toBeNull(); // the last mid, 20 s old
    expect(await approveBlockOf(ctx, "ETH", now + 45_000)).toBe("ETH mid is 45 s old (limit 30 s)");
  });
  test("an unusable answer is not a mid", async () => {
    const ctx = dbPlatformContext(await scanned(), { info: (async () => ["not", "mids"]) as never });
    expect(await approveBlockOf(ctx, "ETH", now)).toBe("no live mid for ETH");
  });
});
