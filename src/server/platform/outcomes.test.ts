import { describe, expect, test } from "bun:test";
import { dueHorizons, horizonMs, netReturn, parseHorizons } from "./outcomes.js";

const costs = { feeBps: 5, slippageBps: 3, fundingBps: 2 }; // 2*5+3+2 = 15 bps

describe("parseHorizons", () => {
  test("parses the default list and units", () => {
    expect(parseHorizons("1h, 4h,24h,72h")).toEqual(["1h", "4h", "24h", "72h"]);
    expect(horizonMs("90m")).toBe(5_400_000);
    expect(horizonMs("2d")).toBe(172_800_000);
  });
  test("rejects malformed and zero horizons", () => {
    expect(() => parseHorizons("1h,xx")).toThrow();
    expect(() => parseHorizons("0h")).toThrow();
    expect(() => parseHorizons("")).toThrow();
  });
});

describe("dueHorizons", () => {
  const created = "2026-10-13T12:00:00Z";
  const hs = ["1h", "4h", "24h"];
  test("due exactly at the boundary, not a millisecond before", () => {
    expect(dueHorizons(created, hs, [], new Date("2026-10-13T12:59:59.999Z"))).toEqual([]);
    expect(dueHorizons(created, hs, [], new Date("2026-10-13T13:00:00Z"))).toEqual(["1h"]);
  });
  test("skips already-marked horizons and returns all when late", () => {
    expect(dueHorizons(created, hs, ["1h"], new Date("2026-10-13T16:00:00Z"))).toEqual(["4h"]);
    expect(dueHorizons(created, hs, [], new Date("2026-10-20T00:00:00Z"))).toEqual(hs);
  });
  test("bad createdAt yields nothing", () => {
    expect(dueHorizons("nope", hs, [], new Date())).toEqual([]);
  });
});

describe("netReturn", () => {
  test("long gains on a rise, minus 15 bps", () => {
    expect(netReturn({ direction: "long", entryPx: 100, horizonPx: 102, costs })).toBeCloseTo(0.02 - 0.0015, 12);
  });
  test("short gains on a fall, loses on a rise", () => {
    expect(netReturn({ direction: "short", entryPx: 100, horizonPx: 98, costs })).toBeCloseTo(0.02 - 0.0015, 12);
    expect(netReturn({ direction: "short", entryPx: 100, horizonPx: 102, costs })).toBeCloseTo(-0.02 - 0.0015, 12);
  });
  test("zero move is exactly minus costs for both sides", () => {
    for (const direction of ["long", "short"] as const) expect(netReturn({ direction, entryPx: 50, horizonPx: 50, costs })).toBeCloseTo(-0.0015, 12);
  });
  test("negative funding is a credit", () => {
    expect(netReturn({ direction: "long", entryPx: 100, horizonPx: 100, costs: { ...costs, fundingBps: -2 } })).toBeCloseTo(-0.0011, 12);
  });
  test("rejects bad prices", () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(() => netReturn({ direction: "long", entryPx: bad, horizonPx: 1, costs })).toThrow();
    expect(() => netReturn({ direction: "long", entryPx: 1, horizonPx: NaN, costs })).toThrow();
  });
});
