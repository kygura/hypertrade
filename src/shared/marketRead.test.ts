import { describe, expect, test } from "bun:test";
import type { Breadth } from "./flow.js";
import { coinRead, fundingWord, marketRead, premiumSentence, venueApr } from "./marketRead.js";
import type { AssetCtx } from "./types.js";

const breadth = (o: Partial<Breadth> = {}): Breadth => ({
  sample: 50,
  advancingPct: 62,
  medianDayChangePct: 1.4,
  btcDayChangePct: 0.8,
  btcLeadPct: -0.6,
  oiWeightedFundingApr: 11,
  hotFunding: [],
  coldFunding: [],
  ...o,
});

const ctx = (o: Partial<AssetCtx> = {}): AssetCtx => ({
  name: "SOL",
  szDecimals: 2,
  markPx: 100,
  oraclePx: 100,
  midPx: 100,
  dayNtlVlm: 50e6,
  prevDayPx: 100,
  openInterest: 3_100_000,
  funding: 0,
  premium: 0,
  dayChange: 0,
  isDelisted: false,
  ...o,
});

describe("marketRead", () => {
  test("alt-led day", () => {
    const r = marketRead(breadth());
    expect(r.sentences).toEqual([
      "31 of the top 50 perps are up today (62%); the median perp is +1.4%.",
      "BTC +0.8%: alts are leading by 0.6 pts.",
      "OI-weighted funding is +11% a year: longs are paying shorts, mildly crowded.",
    ]);
    expect(r.chips.map((c) => c.label)).toEqual(["ADVANCING", "BTC LEAD", "FUNDING TILT"]);
    expect(r.chips.map((c) => c.value)).toEqual(["62%", "-0.6 pts", "+11% APR"]);
    expect(r.chips.every((c) => c.title.length > 0)).toBe(true);
  });

  test("BTC-led day", () => {
    const r = marketRead(breadth({ advancingPct: 30, medianDayChangePct: -1.2, btcDayChangePct: 2.1, btcLeadPct: 3.3, oiWeightedFundingApr: 35 }));
    expect(r.sentences[0]).toBe("15 of the top 50 perps are up today (30%); the median perp is -1.2%.");
    expect(r.sentences[1]).toBe("BTC +2.1%: BTC is leading alts by 3.3 pts.");
    expect(r.sentences[2]).toBe("OI-weighted funding is +35% a year: longs are paying shorts, crowded.");
  });

  test("negative funding", () => {
    const r = marketRead(breadth({ oiWeightedFundingApr: -22 }));
    expect(r.sentences[2]).toBe("OI-weighted funding is -22% a year: shorts are paying longs, crowded short.");
    expect(r.chips[2]!.value).toBe("-22% APR");
  });

  test("flat market", () => {
    const r = marketRead(breadth({ advancingPct: 50, medianDayChangePct: 0, btcDayChangePct: 0.02, btcLeadPct: 0.02, oiWeightedFundingApr: 0.4 }));
    expect(r.sentences).toEqual([
      "25 of the top 50 perps are up today (50%); the median perp is 0.0%.",
      "BTC 0.0%: in line with the median perp.",
      "OI-weighted funding is 0% a year: close to neutral.",
    ]);
  });

  test("no BTC in the sample drops its sentence and chip", () => {
    const r = marketRead(breadth({ btcDayChangePct: null, btcLeadPct: null }));
    expect(r.sentences).toHaveLength(2);
    expect(r.chips.map((c) => c.label)).toEqual(["ADVANCING", "FUNDING TILT"]);
  });

  test("empty input", () => {
    expect(marketRead(breadth({ sample: 0, advancingPct: 0 }))).toEqual({ sentences: ["No live perps to read right now."], chips: [] });
  });
});

describe("fundingWord", () => {
  test("bands match classifyRegime's hot lines", () => {
    expect(fundingWord(30)).toBe("hot");
    expect(fundingWord(29.9)).toBe("mild");
    expect(fundingWord(10)).toBe("mild");
    expect(fundingWord(9.9)).toBe("neutral");
    expect(fundingWord(-14.9)).toBe("neutral");
    expect(fundingWord(-15)).toBe("shorts paying");
  });
});

describe("venueApr", () => {
  test("normalises an 8h Binance rate by its interval", () => {
    // 0.01% per 8h = 0.00125%/h = 10.95% a year
    expect(venueApr({ venue: "BinPerp", rate: 0.0001, intervalHours: 8, nextFundingTime: null })).toBeCloseTo(0.1095, 6);
    expect(venueApr({ venue: "HlPerp", rate: 0.0001, intervalHours: 1, nextFundingTime: null })).toBeCloseTo(0.876, 6);
  });
});

describe("premiumSentence", () => {
  test("above, below, in line", () => {
    expect(premiumSentence("WIF", 0.0072)).toBe("WIF perp trades 72 bp above its oracle.");
    expect(premiumSentence("WIF", -0.0051)).toBe("WIF perp trades 51 bp below its oracle.");
    expect(premiumSentence("WIF", 0.00004)).toBe("WIF perp trades in line with its oracle.");
  });
});

describe("coinRead", () => {
  test("hot coin at cap with a Binance comparison", () => {
    const line = coinRead({
      ctx: ctx({ funding: 0.42 / 8760, premium: 0.0012 }),
      rank: 4,
      predicted: [
        { venue: "HlPerp", rate: 0.42 / 8760, intervalHours: 1, nextFundingTime: null },
        { venue: "BinPerp", rate: (0.09 / 8760) * 8, intervalHours: 8, nextFundingTime: null },
      ],
      atCap: true,
    });
    expect(line).toBe("Funding +42% APR, hot (Binance +9%) · perp 12 bp over spot · OI $310M, #4 on HL · at OI cap");
  });

  test("no venues, no rank, not capped", () => {
    expect(coinRead({ ctx: ctx({ funding: -0.2 / 8760, premium: -0.0003, openInterest: 12_000_000 }), rank: null, atCap: false })).toBe(
      "Funding -20% APR, shorts paying · perp 3 bp under spot · OI $1.2B",
    );
  });
});
