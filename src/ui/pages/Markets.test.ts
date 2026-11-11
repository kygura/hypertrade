import { describe, expect, test } from "bun:test";
import { fundingAprPct } from "../../shared/signalMath";
import { FUNDING_CROWDED, isFundingCrowded } from "./Markets";

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
