import { describe, expect, test } from "bun:test";
import { bookWalls, sigFigsFor, sigStep } from "./bookDepth.js";

describe("book depth near levels", () => {
  test("nSigFigs: the finest aggregation whose 20 levels a side span 2 ATR", () => {
    expect(sigStep(90_000, 5)).toBe(1);
    expect(sigFigsFor(90_000, 900)).toBe(3); // step 100: 20 × 100 = 2000 ≥ 2 × 900
    expect(sigFigsFor(90_000, 2_500)).toBe(2); // step 1000: 20 000 ≥ 5000
    expect(sigFigsFor(150, 0.1)).toBe(5); // 20 × 0.01 = 0.2 ≥ 0.2
    expect(sigFigsFor(0.45, 1)).toBe(2); // nothing spans it: the coarsest
  });

  test("a level ≥ 3× the median within 0.25 ATR of a liquidity level is a wall; a big level far from any level is not", () => {
    const lv = (px: number, sz: number) => ({ px, sz });
    const book = {
      bids: [lv(99.9, 10), lv(99.5, 10), lv(98, 80), lv(97, 10), lv(96, 90)],
      asks: [lv(100.1, 10), lv(100.5, 10), lv(101, 10), lv(102, 10), lv(103, 10)],
    };
    const walls = bookWalls(book, [{ key: "1d.pdl", px: 97.9 }], 2);
    expect(walls).toEqual([{ side: "bid", px: 98, usd: 7840, multiple: 7.78, level: { key: "1d.pdl", px: 97.9 }, distAtr: 0.05 }]);
    expect(bookWalls(book, [{ key: "1d.pdl", px: 97.9 }], 0)).toEqual([]);
  });
});
