import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateLines } from "./claims.js";
import { extractNumbers, isAdvice, lineVerdict, payloadNumbers } from "./numbers.js";

describe("extractNumbers", () => {
  const cases: Array<[string, number[]]> = [
    ["SOL fell 4.1% in 24h", [4.1]],
    ["OI −8%, funding +12.5 bps", [8, 12.5]],
    ["$12.4M liquidated, $1.2B OI, 950K volume", [12.4e6, 1.2e9, 950e3]],
    ["1,234.5 contracts and 12,000,000 USD", [1234.5, 12_000_000]],
    ["3.5 million tokens unlock", [3.5e6]],
    ["5x leverage, 3rd largest", [5, 3]],
    // exempt: identifiers, window labels, dates, times, list markers, trade ids, hex
    ["L2 and ATR14 on EIP-1967 for BTC2", []],
    ["over 1h, 6h, 24h and 7d; 48 h ago", []],
    ["2026-10-13T14:00:00Z and 2026-10-13", []],
    ["CPI on Oct 13th at 14:30 UTC, FOMC 29 October 2026, NFP 11/7", []],
    ["1. Long SOL: funding flat", []],
    ["(2) Short ETH: quiet", []],
    ["desk:BTC:1 and hl:ETH:42 cited", []],
    ["impl 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984 sha256 ab12", []],
  ];
  for (const [text, want] of cases) {
    test(text, () => {
      const got = extractNumbers(text).map((t) => t.value);
      expect(got.length).toBe(want.length);
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
    });
  }

  test("unit = one step of the last printed decimal, scaled", () => {
    expect(extractNumbers("4.12%")[0]!.unit).toBeCloseTo(0.01, 12);
    expect(extractNumbers("$12.4M")[0]!.unit).toBeCloseTo(100_000, 6);
    expect(extractNumbers("7")[0]!.unit).toBe(1);
  });

  test("an ordinal outside a date phrase is checked", () => {
    expect(extractNumbers("the 45th day").map((t) => t.value)).toEqual([45]);
  });
});

describe("payloadNumbers", () => {
  test("numbers, nested objects, strings and JSON strings, absolute values", () => {
    const p = payloadNumbers({ a: -4.1, b: [{ c: 2 }], title: "Hack drains $12.4M", nested: JSON.stringify({ z: 1.25e-7 }), ok: true, n: null });
    expect(p).toContain(4.1);
    expect(p).toContain(2);
    expect(p).toContain(12.4e6);
    expect(p).toContain(12.4);
    expect(p).toContain(1.25e-7);
  });
  test("plain text payload: every number counts, dates included", () => {
    expect(payloadNumbers("Thesis: BTC holds 60k until 2026-11-01")).toEqual(expect.arrayContaining([60_000, 2026, 11, 1]));
  });
});

describe("lineVerdict", () => {
  const payload = payloadNumbers({
    changes: [{ asset: "SOL", delta: -4.13, z: -2.31, fromPct8h: 0.01, toPct8h: 0.0412, spreadBps: 3.2, notionalUsd: 12_431_000 }],
    alerts: [{ line: "already −4.1%, OI −8%" }],
  });
  const table: Array<[string, null | "numbers" | "advice"]> = [
    // accept: within rounding (relative 0.5% or one unit of the last printed decimal)
    ["Long SOL: price −4.1% since your last look (z −2.3).", null],
    ["SOL fell 4% over 24h.", null],
    ["Funding rose from 0.01%/8h to 0.041%/8h.", null],
    ["Spread widened to 3.2 bps.", null],
    ["Position is $12.4M notional.", null],
    ["Long SOL. The exploit is on Jito, which affects LST collateral.", null],
    ["A sell-off could follow; watch exit liquidity on L2 venues.", null],
    ["Selling pressure built while buyers stepped back.", null],
    ["Buy volume dropped over 6h.", null],
    // reject: numbers not in the payload
    ["SOL fell 5.2%.", "numbers"],
    ["Funding hit 0.09%/8h.", "numbers"],
    ["$15M was liquidated.", "numbers"],
    ["Price is down 4.13% and OI 12%.", "numbers"],
    // reject: advice
    ["Sell SOL now.", "advice"],
    ["Long SOL: consider exiting before the unlock.", "advice"],
    ["You should buy the dip.", "advice"],
    ["Enter on the retest.", "advice"],
    ["Exit the position.", "advice"],
    ["Target 4.1% higher.", "advice"],
    ["TP at the prior high.", "advice"],
    ["SOL will reach new highs.", "advice"],
  ];
  for (const [line, want] of table) test(line, () => expect(lineVerdict(line, payload)).toBe(want));
});

describe("validateLines (the choke point)", () => {
  const observed = (text: string) => ({ tag: "observed", text, source: { label: "snapshot", url: "/markets/SOL" }, ts: "2026-10-13T14:00:00Z" });
  test("drops untagged, unmatched-number and advice lines, counting each", () => {
    const r = validateLines(
      [observed("SOL −4.1% since 2026-10-13."), { tag: "hypothesis", text: "Longs may be crowded at 0.04%/8h." }, observed("SOL −9.9%."), { tag: "hypothesis", text: "Buy the dip." }, { text: "untagged" }],
      { changes: [{ asset: "SOL", delta: -4.13, toPct8h: 0.0412 }] },
    );
    expect(r.claims.map((c) => c.text)).toEqual(["SOL −4.1% since 2026-10-13.", "Longs may be crowded at 0.04%/8h."]);
    expect(r).toMatchObject({ dropped: 3, numbersRejected: 1, adviceRejected: 1 });
  });

  test("no production module bypasses it (validateClaims stays internal to claims.ts)", () => {
    const dir = import.meta.dir;
    const offenders = [...new Bun.Glob("**/*.ts").scanSync(dir)].filter(
      (f) => !f.endsWith(".test.ts") && f !== "claims.ts" && /\bvalidateClaims\(|ClaimSchema\.safeParse\(/.test(readFileSync(join(dir, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("isAdvice", () => {
  test("nouns are allowed, imperatives are not", () => {
    expect(isAdvice("Sell-off deepened.")).toBe(false);
    expect(isAdvice("Exit liquidity is thin.")).toBe(false);
    expect(isAdvice("Buy-side depth fell.")).toBe(false);
    expect(isAdvice("Long SOL: sell into strength.")).toBe(true);
  });
});
