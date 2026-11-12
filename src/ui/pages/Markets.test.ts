import { describe, expect, test } from "bun:test";
import { fundingAprPct } from "../../shared/signalMath";
import { FUNDING_CROWDED, isFundingCrowded, marketsInsight } from "./Markets";

describe("Markets funding flag", () => {
  test("threshold is 0.1%/8h expressed as the hourly fraction HL reports", () => {
    expect(FUNDING_CROWDED).toBeCloseTo(0.000125, 10);
    // ~109.5% APR on hourly funding.
    expect(fundingAprPct(FUNDING_CROWDED)).toBeCloseTo(109.5, 1);
  });

  test("fires on a realistic hot hourly rate, not on the 1h baseline", () => {
    expect(isFundingCrowded(0.0000125)).toBe(false); // 0.01%/8h-equivalent: the HL baseline, 10.95% APR
    expect(isFundingCrowded(0.00015)).toBe(true);
    expect(isFundingCrowded(-0.0002)).toBe(true);
  });
});

describe("marketsInsight", () => {
  const row = (coin: string, dayChangePct: number, funding: number, openInterestUsd: number) => ({ coin, dayChangePct, funding, openInterestUsd });

  test("breadth, median 24h change, crowded-funding counts on each side and the top OI share", () => {
    const rows = [row("BTC", 0.02, 0.0000125, 3_000_000_000), row("ETH", -0.01, 0.00015, 1_000_000_000), row("xyz:NVDA", 0.004, -0.0002, 0), row("DOGE", 0, FUNDING_CROWDED, 0)];
    expect(marketsInsight(rows)).toBe(
      "4 perps: 2 up and 1 down over 24h, median +0.20%; funding at or above +0.0125% per hour on 2, at or below −0.0125% on 1; BTC holds 75% of the $4.00B open interest.",
    );
  });

  test("no open interest: the share is left out; no rows: null", () => {
    expect(marketsInsight([row("HYPE", -0.05, 0, 0)])).toBe("1 perp: 0 up and 1 down over 24h, median -5.00%; funding at or above +0.0125% per hour on 0, at or below −0.0125% on 0.");
    expect(marketsInsight([])).toBeNull();
  });
});
