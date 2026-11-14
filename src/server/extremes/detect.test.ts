import { describe, expect, test } from "bun:test";
import { ExtremeEventSchema } from "../../shared/extremes.js";
import type { RingPoint } from "../platform/features.js";
import { DEFAULT_EXTREME_THRESHOLDS, detectExtremes, EXTREME_LOOKBACK_MS, EXTREME_MIN_HISTORY_MS, readExtremes } from "./detect.js";

const MIN = 60_000;
const BAR = 15 * MIN;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 15, 12);
const N = EXTREME_LOOKBACK_MS / BAR + 4 * 24; // 31 days of 15-min bars

/** Deterministic standard normals (mulberry32 + Box-Muller). */
function normals(seed: number, n: number): number[] {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  return Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()));
}

type Shape = {
  /** Per-bar log return (i = 0 oldest, n - 1 ends at NOW). */
  ret: (i: number) => number;
  /** Log OI contracts offset; NaN for no OI. */
  oi?: (i: number) => number;
  funding?: (i: number) => number;
  n?: number;
};

/** 15-min points ending at NOW; OI in USD = contracts × mark (1e6 contracts baseline, ±0.2% noise). */
function stream(seed: number, s: Shape): RingPoint[] {
  const n = s.n ?? N;
  const z = normals(seed, n);
  let mark = 100;
  return Array.from({ length: n }, (_, i) => {
    mark *= Math.exp(s.ret(i));
    const contracts = 1e6 * Math.exp((s.oi ? s.oi(i) : 0) + 0.002 * z[i]!);
    return { ts: NOW - (n - 1 - i) * BAR, mark, oiUsd: contracts * mark, funding: s.funding ? s.funding(i) : 1e-5 + 2e-6 * z[(i * 7) % n]!, dayNtlVlm: 1e8 };
  });
}

const VOL = 0.0025; // per 15-min bar
const last = (bars: number, i: number, n = N) => i >= n - bars;
const btcZ = normals(1, N);
const btcFlat = stream(1, { ret: (i) => VOL * btcZ[i]! });
const kinds = (pts: RingPoint[], btc: RingPoint[] | null, coin = "SOL", now = NOW) => detectExtremes({ coin, points: pts, btc, now }).map((e) => e.kind);

describe("detectExtremes", () => {
  test("price_dislocation: an idiosyncratic 24 h drop fires, side long, contract-valid event", () => {
    const z = normals(2, N);
    const pts = stream(2, { ret: (i) => VOL * z[i]! + (last(96, i) ? Math.log(0.7) / 96 : 0) });
    const evs = detectExtremes({ coin: "SOL", points: pts, btc: btcFlat, now: NOW });
    const e = evs.find((x) => x.kind === "price_dislocation")!;
    expect(e).toBeDefined();
    expect(ExtremeEventSchema.parse(e)).toEqual(e);
    expect(e.side).toBe("long");
    expect(e.key).toBe("price_dislocation|SOL|long");
    expect(e.severity).toBeGreaterThanOrEqual(DEFAULT_EXTREME_THRESHOLDS.price.z[e.window as "24h"]);
    expect(e.facts.zResid!).toBeLessThanOrEqual(-DEFAULT_EXTREME_THRESHOLDS.price.zResid[e.window as "24h"]);
    expect(e.line).toMatch(/^SOL (24h|72h|4h) -\d+\.\d% \(-\d+\.\dσ own, -\d+\.\dσ vs BTC\)/);
    // one event per kind per call
    expect(evs.filter((x) => x.kind === "price_dislocation").length).toBe(1);
  });

  test("price_dislocation: a market-wide beta move does not fire the alt; BTC fires on its own history", () => {
    const btcCrash = stream(1, { ret: (i) => VOL * btcZ[i]! + (last(96, i) ? Math.log(0.7) / 96 : 0) });
    const z = normals(3, N);
    let prev = btcCrash[0]!.mark;
    const btcRets = btcCrash.map((p) => {
      const r = Math.log(p.mark / prev);
      prev = p.mark;
      return r;
    });
    const alt = stream(3, { ret: (i) => 1.3 * btcRets[i]! + 0.001 * z[i]! });
    // the alt's own move is extreme; only the BTC residual keeps it quiet
    const own = readExtremes({ coin: "SOL", points: alt, btc: btcCrash, now: NOW }).price.find((p) => p.window === "24h")!;
    expect(own.z!).toBeLessThan(-DEFAULT_EXTREME_THRESHOLDS.price.z["24h"]);
    expect(own.ret).toBeLessThan(-DEFAULT_EXTREME_THRESHOLDS.price.minMove["24h"]);
    expect(Math.abs(own.zResid!)).toBeLessThan(DEFAULT_EXTREME_THRESHOLDS.price.zResid["24h"]);
    expect(kinds(alt, btcCrash)).not.toContain("price_dislocation");
    expect(kinds(btcCrash, null, "BTC")).toContain("price_dislocation");
    // the same alt with BTC data missing fails closed
    expect(kinds(alt, null)).not.toContain("price_dislocation");
  });

  test("too little history: not evaluable, []", () => {
    const n = EXTREME_MIN_HISTORY_MS / BAR - 4;
    const z = normals(4, n);
    const pts = stream(4, { n, ret: (i) => VOL * z[i]! + (last(96, i, n) ? Math.log(0.7) / 96 : 0) });
    expect(detectExtremes({ coin: "SOL", points: pts, btc: btcFlat, now: NOW })).toEqual([]);
    expect(readExtremes({ coin: "SOL", points: pts, btc: btcFlat, now: NOW }).evaluable).toBe(false);
  });

  test("oi_flush: OI contracts -30% in 4 h with price down fires, side long, funding before/after in facts", () => {
    const z = normals(5, N);
    const pts = stream(5, {
      ret: (i) => VOL * z[i]! + (last(16, i) ? Math.log(0.92) / 16 : 0),
      oi: (i) => (last(16, i) ? (Math.log(0.7) * (i - (N - 17))) / 16 : 0),
      funding: (i) => (last(16, i) ? -2e-5 : 1.5e-5),
    });
    const e = detectExtremes({ coin: "ETH", points: pts, btc: btcFlat, now: NOW }).find((x) => x.kind === "oi_flush")!;
    expect(e).toBeDefined();
    expect(e.side).toBe("long");
    expect(e.facts.oiChg!).toBeLessThan(-0.2);
    expect(e.facts.fundingBefore).toBe(1.5e-5);
    expect(e.facts.fundingAfter).toBe(-2e-5);
    expect(e.line).toMatch(/^ETH (1h|4h|24h) OI -\d+\.\d% contracts/);
    // price up with the same OI drop: shorts flushed
    const up = stream(5, { ret: (i) => VOL * z[i]! + (last(16, i) ? Math.log(1.08) / 16 : 0), oi: (i) => (last(16, i) ? (Math.log(0.7) * (i - (N - 17))) / 16 : 0) });
    expect(detectExtremes({ coin: "ETH", points: up, btc: btcFlat, now: NOW }).find((x) => x.kind === "oi_flush")?.side).toBe("short");
  });

  test("oi_flush: OI in USD falling only because price fell does not fire (contracts flat)", () => {
    const z = normals(6, N);
    const pts = stream(6, { ret: (i) => VOL * z[i]! + (last(16, i) ? Math.log(0.75) / 16 : 0) });
    expect(kinds(pts, btcFlat)).not.toContain("oi_flush");
  });

  test("crowded_asymmetry: funding at its 30 d extreme, OI at its high, price not following: side against the crowd", () => {
    const z = normals(7, N);
    const pts = stream(7, {
      ret: (i) => VOL * z[i]! * 0.5 + (last(96, i) ? -0.005 / 96 : 0),
      oi: (i) => (last(96, i) ? 0.25 * (i - (N - 97)) / 96 : 0),
      funding: (i) => (last(4, i) ? 2e-4 : 1e-5 + 2e-6 * z[(i * 7) % N]!),
    });
    const r = readExtremes({ coin: "DOGE", points: pts, btc: btcFlat, now: NOW });
    expect(r.crowded?.fires).toBe(true);
    const e = detectExtremes({ coin: "DOGE", points: pts, btc: btcFlat, now: NOW }).find((x) => x.kind === "crowded_asymmetry")!;
    expect(e.side).toBe("short");
    expect(e.facts.fundingAprPct!).toBeCloseTo(175.2, 1);
    expect(e.line).toMatch(/^DOGE funding \+175% apr \(100th pctile 30d/);
    // price running with the crowd: no asymmetry
    const follow = stream(7, { ret: (i) => VOL * z[i]! * 0.5 + (last(96, i) ? 0.15 / 96 : 0), oi: (i) => (last(96, i) ? 0.25 * (i - (N - 97)) / 96 : 0), funding: (i) => (last(4, i) ? 2e-4 : 1e-5) });
    expect(kinds(follow, btcFlat, "DOGE")).not.toContain("crowded_asymmetry");
  });

  test("OI kinds are silent when OI is absent (candle streams)", () => {
    const z = normals(8, N);
    const pts = stream(8, {
      ret: (i) => VOL * z[i]! + (last(16, i) ? Math.log(0.85) / 16 : 0),
      funding: (i) => (last(4, i) ? 2e-4 : 1e-5),
    }).map((p) => ({ ...p, oiUsd: NaN }));
    const r = readExtremes({ coin: "SOL", points: pts, btc: btcFlat, now: NOW });
    expect(r.evaluable).toBe(true);
    expect(r.oi).toEqual([]);
    expect(r.crowded).toBeNull();
    expect(r.price.length).toBe(3);
    expect(kinds(pts, btcFlat)).toEqual(["price_dislocation"]);
  });

  test("no look-ahead: points after now do not change the answer at now", () => {
    const z = normals(9, N);
    const pts = stream(9, { ret: (i) => VOL * z[i]! + (last(96, i) ? Math.log(0.7) / 96 : 0), oi: (i) => (last(16, i) ? -0.4 : 0) });
    const now = NOW - 2 * DAY;
    const cut = pts.filter((p) => p.ts <= now);
    const btcCut = btcFlat.filter((p) => p.ts <= now);
    const a = detectExtremes({ coin: "SOL", points: cut, btc: btcCut, now });
    const b = detectExtremes({ coin: "SOL", points: pts, btc: btcFlat, now });
    expect(b).toEqual(a);
    expect(detectExtremes({ coin: "SOL", points: pts, btc: btcFlat, now: NOW }).length).toBeGreaterThan(0);
  });
});
