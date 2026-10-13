import { describe, expect, test } from "bun:test";
import { hourlyLogChanges, levelZ, metricFamily, metricZ, ratioZ, returnZ, type Point } from "./normalize.js";

const H = 3_600_000;
const T = Date.UTC(2026, 9, 13, 12);

/** n hourly points ending at T, log steps alternating +step / −step (σ = step, mean 0 for an even count of changes). */
function zigzag(n: number, step = 0.01, base = 100): Point[] {
  const out: Point[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    out.push({ t: T - (n - 1 - i) * H, v });
    v *= Math.exp(i % 2 === 0 ? step : -step);
  }
  return out;
}

describe("metricFamily", () => {
  test("price/oi are returns, rates are levels, the rest are ratios", () => {
    expect(["price", "oi_usd"].map((m) => metricFamily(m as never))).toEqual(["return", "return"]);
    expect(["funding", "premium", "basis"].map((m) => metricFamily(m as never))).toEqual(["level", "level", "level"]);
    expect(["vol24h", "depth_bid_1", "depth_ask_2", "spread_bps"].map((m) => metricFamily(m as never))).toEqual(["ratio", "ratio", "ratio", "ratio"]);
  });
});

describe("hourlyLogChanges", () => {
  test("last value per hour, adjacent hours only", () => {
    const pts: Point[] = [
      { t: T, v: 100 },
      { t: T + 0.5 * H, v: 999 }, // same hour as 101 below, which is later and wins
      { t: T + 0.75 * H, v: 101 },
      { t: T + 1.25 * H, v: 102 },
      { t: T + 3.1 * H, v: 200 }, // hour 3 after a gap at hour 2: no change counted across it
    ];
    const ch = hourlyLogChanges(pts);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toBeCloseTo(Math.log(102 / 101), 12);
  });
});

describe("returnZ (price, oi_usd)", () => {
  const history = zigzag(25); // 24 hourly changes, σ = 0.01
  test("Δ_h / (σ_1h · √h)", () => {
    const z = returnZ({ t: T - 4 * H, v: 100 }, { t: T, v: 100 * Math.exp(0.04) }, history);
    expect(z).toBeCloseTo(0.04 / (0.01 * 2), 9);
  });
  test("h is the real elapsed time (no 24 h cap) and is floored at 0.25 h", () => {
    const z = returnZ({ t: T - 72 * H, v: 100 }, { t: T, v: 100 * Math.exp(0.1) }, history);
    expect(z).toBeCloseTo(0.1 / (0.01 * Math.sqrt(72)), 9);
    const fast = returnZ({ t: T - 60_000, v: 100 }, { t: T, v: 100 * Math.exp(0.005) }, history);
    expect(fast).toBeCloseTo(0.005 / (0.01 * Math.sqrt(0.25)), 9);
  });
  test("fewer than 24 samples → null; history older than 7 days does not count", () => {
    expect(returnZ({ t: T - H, v: 100 }, { t: T, v: 101 }, zigzag(24))).toBeNull();
    const old = zigzag(25).map((p) => ({ ...p, t: p.t - 8 * 24 * H }));
    expect(returnZ({ t: T - H, v: 100 }, { t: T, v: 101 }, old)).toBeNull();
  });
  test("no elapsed time or a non-positive value → null", () => {
    expect(returnZ({ t: T, v: 100 }, { t: T, v: 101 }, history)).toBeNull();
    expect(returnZ({ t: T - H, v: 0 }, { t: T, v: 101 }, history)).toBeNull();
  });
});

describe("levelZ (funding, premium, basis)", () => {
  const alt = (n: number) => Array.from({ length: n }, (_, i) => ({ t: T - (n - i) * H, v: i % 2 ? 3 : 1 }));
  test("(now − mean) / σ over the 7-day window", () => {
    expect(levelZ({ t: T, v: 4 }, alt(24))).toBeCloseTo(2, 12); // mean 2, σ 1
    expect(levelZ({ t: T, v: 0 }, alt(24))).toBeCloseTo(-2, 12);
  });
  test("< 24 samples or a flat series → null", () => {
    expect(levelZ({ t: T, v: 4 }, alt(23))).toBeNull();
    expect(levelZ({ t: T, v: 4 }, Array.from({ length: 30 }, (_, i) => ({ t: T - i * H, v: 1 })))).toBeNull();
  });
});

describe("ratioZ (vol24h, depth, spread)", () => {
  test("log(now / median) over σ of log(x / median)", () => {
    // 12 × 100e^0.1, 12 × 100e^-0.1, one 100: median 100, log ratios ±0.1 (and one 0).
    const xs = [...Array(12).fill(100 * Math.exp(0.1)), ...Array(12).fill(100 * Math.exp(-0.1)), 100];
    const hist = xs.map((v, i) => ({ t: T - (i + 1) * H, v }));
    const sigma = Math.sqrt((24 * 0.01) / 25);
    expect(ratioZ({ t: T, v: 100 * Math.exp(0.2) }, hist)).toBeCloseTo(0.2 / sigma, 9);
  });
  test("non-positive current or < 24 positive samples → null", () => {
    const hist = Array.from({ length: 30 }, (_, i) => ({ t: T - i * H, v: i % 2 ? 0 : 5 + i }));
    expect(ratioZ({ t: T, v: 10 }, hist)).toBeNull(); // only 15 positive samples
    expect(ratioZ({ t: T, v: 0 }, zigzag(30))).toBeNull();
  });
});

describe("metricZ", () => {
  const from = { t: T - 4 * H, v: 100 };
  const to = { t: T, v: 100 * Math.exp(0.04) };
  test("cold start stands in while the snapshot history is too short", () => {
    expect(metricZ("price", { from, to, history: zigzag(5) })).toBeNull();
    expect(metricZ("price", { from, to, history: zigzag(5), coldStart: zigzag(25) })).toBeCloseTo(2, 9);
    // Enough snapshots: the cold start is ignored.
    expect(metricZ("price", { from, to, history: zigzag(25), coldStart: zigzag(25, 0.02) })).toBeCloseTo(2, 9);
  });
  test("the ratio family has no cold start", () => {
    expect(metricZ("vol24h", { from, to, history: [], coldStart: zigzag(30) })).toBeNull();
  });
});
