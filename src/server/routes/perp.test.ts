import { describe, expect, test } from "bun:test";
import { changeSince, trailingMean } from "./perp.js";

const H = 3_600_000;
const D = 24 * H;

describe("trailingMean", () => {
  const rows = Array.from({ length: 48 }, (_, i) => ({ t: i * H, rate: i < 24 ? 0.0001 : 0.0003 }));
  test("averages rows newer than the cutoff", () => {
    expect(trailingMean(rows, 23.5 * H)).toBeCloseTo(0.0003);
  });
  test("null when history doesn't reach the window start", () => {
    expect(trailingMean(rows, -7 * D)).toBeNull();
    expect(trailingMean([], 0)).toBeNull();
  });
});

describe("changeSince", () => {
  const pts = Array.from({ length: 10 }, (_, i) => ({ t: i * 12 * H, v: 100 + i * 10 }));
  test("compares the last point with the one nearest `ago` earlier", () => {
    // last: t=108h v=190; 24h earlier: t=84h v=170
    expect(changeSince(pts, D, H)).toBeCloseTo(190 / 170 - 1);
  });
  test("null when no point sits within tolerance", () => {
    expect(changeSince(pts, 30 * D, H)).toBeNull();
    expect(changeSince(pts.slice(0, 1), D, H)).toBeNull();
  });
});
