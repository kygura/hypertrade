import { describe, expect, test } from "bun:test";
import type { FixedWindow, FlowRow, HeatmapMetric, SnapshotRow } from "../../shared/intel.js";
import { DELEV_OI_PCT, detectFlows, type DetectorInput } from "./flows.js";
import type { Point } from "./normalize.js";
import { computeWindows, seriesFromRows, type WindowResult } from "./windows.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const rnd = (i: number) => (Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1;

/** 15-min samples over the last `days`, noisy around `base`; the sample at now is `last`. */
function level(days: number, base: number, last: number, noise = 0.1): Point[] {
  const out: Point[] = [];
  for (let t = NOW - days * D, i = 0; t <= NOW; t += 15 * MIN, i++) out.push({ t, v: t === NOW ? last : base * (1 + noise * rnd(i)) });
  return out;
}

const win = (metric: HeatmapMetric, window: FixedWindow, z: number | null, delta: number | null = 0): WindowResult => ({ metric, window, z, delta });
const input = (over: Partial<DetectorInput>): DetectorInput => ({ asset: "BTC", now: NOW, series: {}, windows: [], ...over });
const flag = (i: DetectorInput, name: string) => detectFlows(i).find((f) => f.name === name);

describe("crowded_long / crowded_short", () => {
  const crowded = (fundingNow: number, base: number, windows: WindowResult[]) => input({ series: { funding: level(5, base, fundingNow) }, windows });
  const ok = [win("oi_usd", "24h", 1.5, 6), win("price", "24h", 0.3, 0.4)];

  test("fires on funding level z ≥ 2 with its sign, OI building, price flat", () => {
    const long = flag(crowded(5e-5, 1e-5, ok), "crowded_long")!;
    expect(long).toMatchObject({ kind: "detector", asset: "BTC", window: "24h", degraded: false });
    expect(long.numbers.funding_z!).toBeGreaterThan(2);
    expect(long.score).toBe(long.numbers.funding_z!);
    expect(long.numbers).toMatchObject({ funding: 5e-5, oi_z_24h: 1.5, oi_pct_24h: 6, price_z_24h: 0.3 });
    expect(flag(crowded(5e-5, 1e-5, ok), "crowded_short")).toBeUndefined();
    expect(flag(crowded(-5e-5, -1e-5, ok), "crowded_short")!.numbers.funding_z!).toBeLessThan(-2);
  });

  test("quiet when price moved, OI did not build, or funding is ordinary", () => {
    expect(flag(crowded(5e-5, 1e-5, [win("oi_usd", "24h", 1.5), win("price", "24h", 1.2)]), "crowded_long")).toBeUndefined();
    expect(flag(crowded(5e-5, 1e-5, [win("oi_usd", "24h", 0.5), win("price", "24h", 0)]), "crowded_long")).toBeUndefined();
    expect(flag(crowded(1e-5, 1e-5, ok), "crowded_long")).toBeUndefined();
  });

  test("degraded when OI's 24h z is unknown (not a false negative)", () => {
    const d = flag(crowded(5e-5, 1e-5, [win("oi_usd", "24h", null), win("price", "24h", 0.3)]), "crowded_long")!;
    expect(d.degraded).toBe(true);
    expect(d.numbers.oi_z_24h).toBeUndefined();
    // no funding history at all: both sides are unknown
    const none = detectFlows(input({ windows: ok }));
    expect(none.filter((f) => f.name.startsWith("crowded_")).map((f) => [f.name, f.degraded])).toEqual([
      ["crowded_long", true],
      ["crowded_short", true],
    ]);
  });
});

describe("negative_funding_oi_build", () => {
  const nf = (windows: WindowResult[]) => input({ series: { funding: level(5, -1e-5, -1e-5) }, windows });

  test("fires: funding < 0, OI 24h z ≥ 1, price 24h z ≥ −0.5", () => {
    const f = flag(nf([win("oi_usd", "24h", 1.2, 5), win("price", "24h", -0.2)]), "negative_funding_oi_build")!;
    expect(f).toMatchObject({ degraded: false, score: 1.2, window: "24h" });
    expect(f.numbers.funding).toBe(-1e-5);
  });

  test("quiet when price is falling", () => {
    expect(flag(nf([win("oi_usd", "24h", 1.2), win("price", "24h", -1)]), "negative_funding_oi_build")).toBeUndefined();
  });

  test("degraded without price's 24h z", () => {
    expect(flag(nf([win("oi_usd", "24h", 1.2)]), "negative_funding_oi_build")!.degraded).toBe(true);
  });
});

describe("deleveraging", () => {
  test(`fires: OI 6h Δ ≤ −${DELEV_OI_PCT}% and liquidations 6h z ≥ 2`, () => {
    const f = flag(input({ windows: [win("oi_usd", "6h", -3, -10), win("liq_usd", "6h", 2.5, 4e6)] }), "deleveraging")!;
    expect(f).toMatchObject({ degraded: false, score: 3, window: "6h", numbers: { oi_pct_6h: -10, liq_usd_6h: 4e6, liq_z_6h: 2.5, threshold_pct: -8 } });
  });

  test("quiet on a smaller OI drop, also without liquidation data; INTEL_DELEV_OI_PCT tunes it", () => {
    expect(flag(input({ windows: [win("oi_usd", "6h", -1, -5), win("liq_usd", "6h", 3)] }), "deleveraging")).toBeUndefined();
    expect(flag(input({ windows: [win("oi_usd", "6h", -1, -5)] }), "deleveraging")).toBeUndefined();
    expect(flag(input({ windows: [win("oi_usd", "6h", -1, -5), win("liq_usd", "6h", 3)], delevOiPct: 4 }), "deleveraging")).toBeDefined();
  });

  test("degraded without liquidation data when OI did drop", () => {
    expect(flag(input({ windows: [win("oi_usd", "6h", -3, -10)] }), "deleveraging")).toMatchObject({ degraded: true, score: 3 });
  });

  test("end to end from stored rows: OI −12% over 6 h with a liquidation burst", () => {
    const snaps: SnapshotRow[] = [];
    const flow: FlowRow[] = [];
    for (let t = NOW - 10 * D, i = 0; t <= NOW; t += 15 * MIN, i++) {
      const ts = new Date(t).toISOString();
      const drop = t > NOW - 6 * H ? Math.exp(Math.log(0.88) * ((t - (NOW - 6 * H)) / (6 * H))) : 1;
      snaps.push({
        asset: "ETH", ts, price: 3000 * (1 + 0.001 * rnd(i)), vol24h: null, funding: 1e-5, oiUsd: 1e9 * (1 + 0.002 * rnd(i + 7)) * drop,
        premium: null, basis: null, depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null,
      });
      const burst = t > NOW - 6 * H ? 500_000 : 5_000 * (1 + 0.2 * rnd(i + 3));
      flow.push({ asset: "ETH", venue: "agg", metric: "liq_long_usd", value: burst, ts }, { asset: "ETH", venue: "agg", metric: "liq_short_usd", value: 1_000, ts });
    }
    const series = seriesFromRows(snaps, flow);
    const f = flag({ asset: "ETH", now: NOW, series, windows: computeWindows(series, NOW) }, "deleveraging")!;
    expect(f.degraded).toBe(false);
    expect(f.numbers.oi_pct_6h!).toBeLessThan(-8);
    expect(f.numbers.liq_z_6h!).toBeGreaterThanOrEqual(2);
  });
});

describe("spot_led / perp_led", () => {
  const spot = { spot_volume_usd: [{ t: NOW, v: 1 }] };
  const sp = (price: number | null, s: number | null, p: number | null, series: DetectorInput["series"] = spot) =>
    input({ series, windows: [win("price", "6h", price, 3), win("spot_volume_usd", "6h", s), win("perp_volume_usd", "6h", p)] });

  test("gap g = z(spot) − z(perp) ≥ 1 → spot_led, ≤ −1 → perp_led, with price 6h |z| ≥ 2", () => {
    const f = detectFlows(sp(2.5, 2, 0.5));
    expect(f.find((x) => x.name === "spot_led")).toMatchObject({ degraded: false, score: 2.5, numbers: { gap: 1.5, spot_z_6h: 2, perp_z_6h: 0.5 } });
    expect(f.find((x) => x.name === "perp_led")).toBeUndefined();
    expect(flag(sp(-3, 0, 2), "perp_led")).toMatchObject({ degraded: false, score: 3, numbers: { gap: -2 } });
  });

  test("quiet on a small price move or a small gap", () => {
    expect(detectFlows(sp(1, 3, 0)).filter((x) => x.name.endsWith("_led"))).toEqual([]);
    expect(detectFlows(sp(3, 1, 0.5)).filter((x) => x.name.endsWith("_led"))).toEqual([]);
  });

  test("degraded without a perp volume z; skipped without spot data", () => {
    expect(detectFlows(sp(3, 2, null)).filter((x) => x.name.endsWith("_led")).map((x) => [x.name, x.degraded])).toEqual([
      ["spot_led", true],
      ["perp_led", true],
    ]);
    expect(detectFlows(sp(3, null, null, {})).filter((x) => x.name.endsWith("_led"))).toEqual([]);
  });
});

describe("liquidity_thinning", () => {
  test("fires below the 30-day p10 of depth ±2%; score = 1 + (p10 − depth)/p10 × 4", () => {
    const f = flag(input({ series: { depth_2: level(2, 1e6, 5e5) } }), "liquidity_thinning")!;
    expect(f).toMatchObject({ degraded: false, window: "1h" });
    const { p10, depth_2 } = f.numbers;
    expect(p10!).toBeGreaterThan(9e5);
    expect(depth_2).toBe(5e5);
    expect(f.score).toBeCloseTo(1 + ((p10! - 5e5) / p10!) * 4, 10);
  });

  test("quiet at ordinary depth", () => {
    expect(flag(input({ series: { depth_2: level(2, 1e6, 1e6) } }), "liquidity_thinning")).toBeUndefined();
  });

  test("degraded under 48 samples or without depth now", () => {
    expect(flag(input({ series: { depth_2: level(2, 1e6, 5e5).slice(-40) } }), "liquidity_thinning")).toMatchObject({ degraded: true, score: 0 });
    expect(flag(input({}), "liquidity_thinning")!.degraded).toBe(true);
  });
});

test("deterministic: same input, same flags", () => {
  const i = input({ series: { funding: level(5, 1e-5, 5e-5), depth_2: level(2, 1e6, 5e5) }, windows: [win("oi_usd", "24h", 1.5), win("price", "24h", 0)] });
  expect(detectFlows(i)).toEqual(detectFlows(i));
});
