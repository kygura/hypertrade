import { describe, expect, test } from "bun:test";
import { approveBlock, MAX_MID_AGE_SEC } from "./context.js";

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
