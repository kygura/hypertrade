import { describe, expect, test } from "bun:test";
import { yAxisIdProp } from "./AssetTimeline";

describe("yAxisIdProp", () => {
  test("no id gives no yAxisId key at all (recharts reads an explicit undefined as a missing axis)", () => {
    expect("yAxisId" in yAxisIdProp(undefined)).toBe(false);
    expect(yAxisIdProp("usd")).toEqual({ yAxisId: "usd" });
  });
});
