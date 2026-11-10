import { describe, expect, test } from "bun:test";
import type { PredictedFunding } from "./hl-client.js";
import { deriveSignals, robustZ, SIGNAL, turnover } from "./signals.js";
import type { AssetCtx } from "./types.js";

const H = 8760;

const ctx = (name: string, o: Partial<AssetCtx> = {}): AssetCtx => ({
  name,
  szDecimals: 2,
  markPx: 10,
  oraclePx: 10,
  midPx: 10,
  dayNtlVlm: 20e6,
  prevDayPx: 10,
  openInterest: 2_000_000, // $20M
  funding: 0.1 / H,
  premium: 0.0002,
  dayChange: 0,
  isDelisted: false,
  ...o,
});

/** A quiet universe with some spread on every metric so the robust scale is non-zero. */
function quiet(n = 20): AssetCtx[] {
  return Array.from({ length: n }, (_, i) => {
    const w = (i % 5) - 2; // -2..2
    return ctx(`C${i}`, { dayChange: w * 0.005, funding: (0.1 + w * 0.02) / H, premium: w * 0.0001, dayNtlVlm: (20 + w * 2) * 1e6 });
  });
}

const firstNumber = (s: string) => s.match(/\d+(\.\d+)?/)![0];

describe("robustZ", () => {
  test("median and MAD scale", () => {
    const z = robustZ([1, 2, 3, 4, 100]);
    // median 3, MAD 1 → scale 1.4826
    expect(z[2]).toBe(0);
    expect(z[4]).toBeCloseTo(97 / 1.4826, 6);
  });
  test("zero spread gives null", () => {
    expect(robustZ([5, 5, 5])).toEqual([null, null, null]);
    expect(robustZ([])).toEqual([]);
  });
});

describe("turnover", () => {
  test("volume over OI in USD", () => {
    expect(turnover(ctx("X", { dayNtlVlm: 40e6 }))).toBe(2);
    expect(turnover(ctx("X", { openInterest: 0 }))).toBeNull();
  });
});

describe("deriveSignals", () => {
  test("a flat universe returns nothing", () => {
    expect(deriveSignals({ ctxs: Array.from({ length: 10 }, (_, i) => ctx(`F${i}`)) })).toEqual([]);
    expect(deriveSignals({ ctxs: quiet() })).toEqual([]);
    expect(deriveSignals({ ctxs: [] })).toEqual([]);
  });

  test("a hot-funding coin ranks first", () => {
    const ctxs = [...quiet(), ctx("SOL", { funding: 0.84 / H }), ctx("TIA", { dayChange: 0.14 })];
    const out = deriveSignals({ ctxs, atCap: ["C3"] });
    expect(out[0]!.coin).toBe("SOL");
    expect(out[0]!.kind).toBe("funding_extreme");
    expect(out[0]!.sentence).toBe("SOL longs pay 84% a year to hold, more than 95% of HL perps.");
    expect(out[0]!.rule).toBe("fires when |funding| ≥ 50% APR");
    expect(out.map((s) => s.coin)).toEqual(["SOL", "TIA", "C3"]);
  });

  test("a coin under the floors never fires", () => {
    const thin = ctx("THIN", { funding: 2 / H, premium: 0.02, dayChange: 0.5, openInterest: 50_000 }); // $500K OI
    const illiquid = ctx("ILLQ", { funding: 2 / H, dayNtlVlm: 900_000 });
    const dead = ctx("DEAD", { funding: 2 / H, isDelisted: true });
    const out = deriveSignals({ ctxs: [...quiet(), thin, illiquid, dead], atCap: ["THIN", "ILLQ", "DEAD"] });
    expect(out).toEqual([]);
  });

  test("each coin gets one card, its strongest", () => {
    const hot = ctx("HYPE", { funding: 1.5 / H, premium: 0.006, dayChange: 0.2, dayNtlVlm: 300e6 });
    const out = deriveSignals({ ctxs: [...quiet(), hot], atCap: ["HYPE"] });
    expect(out.filter((s) => s.coin === "HYPE")).toHaveLength(1);
    expect(new Set(out.map((s) => s.coin)).size).toBe(out.length);
  });

  test("each sentence contains its own evidence number", () => {
    const predicted = new Map<string, PredictedFunding[]>([
      ["DOGE", [{ venue: "BinPerp", rate: (0.12 / H) * 8, intervalHours: 8, nextFundingTime: null }]],
    ]);
    const ctxs = [
      ...quiet(),
      ctx("SOL", { funding: 0.84 / H }),
      ctx("WIF", { premium: 0.0072 }),
      ctx("TIA", { dayChange: 0.14 }),
      ctx("ENA", { dayNtlVlm: 122e6 }),
      ctx("HYPE"),
      ctx("DOGE", { funding: 0.45 / H }),
    ];
    const out = deriveSignals({ ctxs, predicted, atCap: ["HYPE"] }, 10);
    const kinds = Object.fromEntries(out.map((s) => [s.coin, s.kind]));
    expect(kinds).toEqual({ SOL: "funding_extreme", WIF: "basis", TIA: "outsized_move", ENA: "turnover", HYPE: "at_cap", DOGE: "venue_gap" });
    for (const s of out) {
      if (s.kind === "at_cap") continue; // its sentence states a fact, not a number
      expect(s.evidence.length).toBeGreaterThanOrEqual(2);
      expect(s.evidence.length).toBeLessThanOrEqual(3);
      const lead = s.kind === "venue_gap" ? s.evidence[2]! : s.evidence[0]!;
      expect(s.sentence).toContain(firstNumber(lead.value));
      expect(s.why.length).toBeGreaterThan(0);
      expect(s.rule.startsWith("fires when")).toBe(true);
    }
    expect(out.find((s) => s.coin === "DOGE")!.sentence).toBe("DOGE funding on HL is 33 pts APR above Binance.");
    expect(out.find((s) => s.coin === "WIF")!.sentence).toBe("WIF perp trades 72 bp above its oracle.");
    expect(out.find((s) => s.coin === "ENA")!.sentence).toBe("ENA traded 6.1x its open interest in 24h; the median perp trades 1.0x.");
  });

  test("lists at most `top`, default 6", () => {
    const ctxs = [...quiet(), ...Array.from({ length: 9 }, (_, i) => ctx(`HOT${i}`, { funding: (0.6 + i * 0.1) / H }))];
    expect(deriveSignals({ ctxs })).toHaveLength(SIGNAL.top);
    expect(deriveSignals({ ctxs }, 3).map((s) => s.coin)).toEqual(["HOT8", "HOT7", "HOT6"]);
  });
});
