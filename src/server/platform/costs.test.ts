import { describe, expect, test } from "bun:test";
import { bookFromL2, costs, DEFAULT_TAKER_FEE_BPS, midOf, netEdge, walkBook, type Book } from "./costs.js";

// mid 100: bids 99.9 / 99.5, asks 100.1 / 100.5
const book: Book = {
  bids: [{ px: 99.9, sz: 10 }, { px: 99.5, sz: 100 }],
  asks: [{ px: 100.1, sz: 10 }, { px: 100.5, sz: 100 }],
};

describe("walkBook", () => {
  test("inside the first level: no slippage vs best", () => {
    const f = walkBook(book.asks, "buy", 500)!;
    expect(f.avgPx).toBeCloseTo(100.1, 9);
    expect(f.slippageBps).toBeCloseTo(0, 9);
  });
  test("two levels: weighted avg", () => {
    // level 1 holds 1001 USD; 2001 USD = 1001 @100.1 + 1000 @100.5
    const f = walkBook(book.asks, "buy", 2001)!;
    const coins = 10 + 1000 / 100.5;
    expect(f.avgPx).toBeCloseTo(2001 / coins, 9);
    expect(f.slippageBps).toBeCloseTo((2001 / coins / 100.1 - 1) * 1e4, 6);
  });
  test("sell side is adverse downward", () => {
    const f = walkBook(book.bids, "sell", 2000)!;
    expect(f.avgPx).toBeLessThan(99.9);
    expect(f.slippageBps).toBeGreaterThan(0);
  });
  test("too thin, bad size, junk levels -> null", () => {
    expect(walkBook(book.asks, "buy", 1e9)).toBeNull();
    expect(walkBook(book.asks, "buy", 0)).toBeNull();
    expect(walkBook(book.asks, "buy", NaN)).toBeNull();
    expect(walkBook([{ px: NaN, sz: 1 }, { px: 1, sz: -1 }], "buy", 1)).toBeNull();
  });
});

describe("costs", () => {
  test("long: slippage vs mid, funding paid, absorbable 10% of asks within 0.5%", () => {
    const c = costs({ book, sizeUsd: 500, fundingHourly: 0.0001, holdingHours: 8, direction: "long" })!;
    expect(c.feeBps).toBe(DEFAULT_TAKER_FEE_BPS);
    expect(c.slippageBps).toBeCloseTo(10, 6); // 100.1 vs mid 100
    expect(c.fundingBps).toBeCloseTo(8, 9); // 0.0001 x 8h = 8 bps
    expect(c.absorbableUsd).toBeCloseTo(0.1 * (100.1 * 10 + 100.5 * 100), 6); // 100.5 is exactly 0.5% from mid (inside)
  });
  test("short receives positive funding (negative cost) and fills on bids", () => {
    const c = costs({ book, sizeUsd: 500, takerFeeBps: 3, fundingHourly: 0.0001, holdingHours: 8, direction: "short" })!;
    expect(c.fundingBps).toBeCloseTo(-8, 9);
    expect(c.feeBps).toBe(3);
    expect(c.slippageBps).toBeCloseTo(10, 6);
  });
  test("null when the book cannot fill or inputs are not finite", () => {
    expect(costs({ book, sizeUsd: 1e9, fundingHourly: 0, holdingHours: 1, direction: "long" })).toBeNull();
    expect(costs({ book, sizeUsd: 100, fundingHourly: NaN, holdingHours: 1, direction: "long" })).toBeNull();
    expect(costs({ book: { bids: [], asks: [] }, sizeUsd: 100, fundingHourly: 0, holdingHours: 1, direction: "long" })).toBeNull();
  });
});

describe("netEdge", () => {
  test("gross - 2 fee - slippage - funding", () => {
    const c = { feeBps: 4.5, slippageBps: 3, fundingBps: 2, absorbableUsd: 1 };
    expect(netEdge({ grossEdgeBps: 50, costs: c })).toBeCloseTo(50 - 9 - 3 - 2, 9);
    expect(netEdge({ grossEdgeBps: 50, costs: { ...c, fundingBps: -2 } })).toBeCloseTo(50 - 9 - 3 + 2, 9);
  });
});

describe("bookFromL2", () => {
  test("parses HL strings, drops junk, rejects crossed", () => {
    const raw = { levels: [[{ px: "99.9", sz: "10", n: 1 }, { px: "x", sz: "1" }], [{ px: "100.1", sz: "10" }]] };
    const b = bookFromL2(raw)!;
    expect(b.bids).toEqual([{ px: 99.9, sz: 10 }]);
    expect(midOf(b)).toBeCloseTo(100, 9);
    expect(bookFromL2({ levels: [[{ px: "101", sz: "1" }], [{ px: "100", sz: "1" }]] })).toBeNull();
    expect(bookFromL2(null)).toBeNull();
  });
});
