import type { RingPoint } from "../platform/features.js";

// Synthetic snapshot streams for the calibration tests (calibrate.test.ts): no production data in tests.

const MIN = 60_000;
const BAR = 15 * MIN;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 9, 1);
const DAYS = 30;
export const N = (DAYS * DAY) / BAR;
export const BAR_MS = BAR;

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

type Episode =
  /** price slide of `move` (fraction, e.g. -0.3) over `hours`, starting on `day` */
  | { kind: "slide"; day: number; move: number; hours: number }
  /** OI contracts drop of `drop` over 4 h with a price move of `move` */
  | { kind: "flush"; day: number; drop: number; move: number }
  /** funding at `apr`% for 12 h after OI climbed 25% over the day before; price flat */
  | { kind: "crowd"; day: number; apr: number };

/**
 * A synthetic snapshot-like stream: 30 days of 15-min points with OI and funding (the shape scan_snapshots give), a
 * random walk at 0.25% a bar, OI level noise, funding around HL's default, plus the episodes. `vol` sets the 24 h
 * volume the universe ranks by.
 */
function stream(seed: number, episodes: Episode[], vol: number, oi = true): RingPoint[] {
  const z = normals(seed, 2 * N);
  let lnMark = Math.log(100);
  return Array.from({ length: N }, (_, i) => {
    const ts = T0 + i * BAR;
    let r = 0.0025 * z[i]!;
    let lnOi = 0.002 * z[N + i]!;
    let funding = 1.25e-5 + 2e-6 * z[(i * 7) % N]!;
    for (const e of episodes) {
      const start = T0 + e.day * DAY;
      if (e.kind === "slide" && ts > start && ts <= start + e.hours * HOUR) r += Math.log(1 + e.move) / ((e.hours * HOUR) / BAR);
      if (e.kind === "flush") {
        if (ts > start && ts <= start + 4 * HOUR) r += Math.log(1 + e.move) / 16;
        if (ts > start) lnOi += Math.log(1 - e.drop) * Math.min(1, (ts - start) / (4 * HOUR));
      }
      if (e.kind === "crowd") {
        if (ts > start - DAY) lnOi += Math.log(1.25) * Math.min(1, (ts - start + DAY) / DAY) * (ts > start + 2 * DAY ? 0 : 1);
        if (ts > start && ts <= start + 12 * HOUR) funding = e.apr / 100 / (24 * 365);
      }
    }
    lnMark += r;
    const mark = Math.exp(lnMark);
    return { ts, mark, oiUsd: oi ? 1e6 * Math.exp(lnOi) * mark : NaN, funding, dayNtlVlm: vol };
  });
}

/**
 * Twelve coins over 30 days. AAA is the "regime break" coin that fires again and again (the per-coin cap's case); the
 * others carry one episode each, of graded size, so each kind's rate steps down as its multiplier grows.
 */
export function fixture(oi = true): Map<string, RingPoint[]> {
  const coins: Array<[string, Episode[]]> = [
    ["BTC", []],
    ["AAA", [{ kind: "slide", day: 15, move: -0.3, hours: 24 }, { kind: "slide", day: 19, move: -0.35, hours: 24 }, { kind: "slide", day: 23, move: 0.4, hours: 24 }, { kind: "slide", day: 27, move: -0.3, hours: 24 }]],
    ["BBB", [{ kind: "slide", day: 17, move: -0.2, hours: 24 }]],
    ["CCC", [{ kind: "slide", day: 25, move: 0.25, hours: 24 }]],
    ["DDD", [{ kind: "slide", day: 20, move: -0.17, hours: 24 }]],
    ["EEE", [{ kind: "slide", day: 18, move: 0.3, hours: 72 }]],
    ["FFF", [{ kind: "flush", day: 16, drop: 0.25, move: -0.03 }]],
    ["GGG", [{ kind: "flush", day: 22, drop: 0.25, move: 0.05 }]],
    ["HHH", [{ kind: "flush", day: 27, drop: 0.3, move: -0.08 }]],
    ["III", [{ kind: "crowd", day: 19, apr: 85 }]],
    ["JJJ", [{ kind: "crowd", day: 23, apr: 120 }]],
    ["KKK", [{ kind: "crowd", day: 27, apr: 200 }]],
  ];
  return new Map(coins.map(([coin, eps], i) => [coin, stream(i + 1, eps, 9e9 - i * 5e8, oi)]));
}
