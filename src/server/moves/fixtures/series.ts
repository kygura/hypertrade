import type { Candle } from "../../../shared/types.js";
import { CANDLE_BARS, HOUR_MS } from "../constants.js";

// Synthetic hourly series for the attribution tests (seeded, deterministic). Factors are drawn independently:
//   btc_t ~ N(0, 0.6%) · ethx_t ~ N(0, 0.4%) · sectx_t ~ N(0, 0.8%), orthogonalised on the 24h estimation window
//   ETH   = 1.1·btc + ethx
//   peer_i = 1.2·btc + sectx + N(0, 0.2%)            (4 peers)
//   COIN  = 1.3·btc + 0.5·ethx + 0.8·sectx + N(0, 0.05%), plus SHOCK (log) in one hour of the window
// so the recovered betas are about 1.3 (BTC), 0.5 (ETH ex-BTC) and 0.8·var(sectx)/var(sectx + mean idio) ≈ 0.79.

export const FIXTURE_AS_OF = Date.parse("2026-11-10T12:00:00Z");
export const PLANTED = { btc: 1.3, eth: 0.5, sector: 0.8 } as const;
export const SHOCK = 0.05;

export function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (sd: number) => sd * Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** Candles from a log-return path: one candle per bar open, close = 100·exp(Σ r). The first bar has no return. */
export function candlesFrom(returns: number[], firstOpen: number, start = 100): Candle[] {
  let px = start;
  return [{ t: firstOpen, T: firstOpen + HOUR_MS - 1, o: px, h: px, l: px, c: px, v: 1 }, ...returns.map((r, i) => {
    const o = px;
    px *= Math.exp(r);
    const t = firstOpen + (i + 1) * HOUR_MS;
    return { t, T: t + HOUR_MS - 1, o, h: Math.max(o, px), l: Math.min(o, px), c: px, v: 1 };
  })];
}

export interface FixtureSet {
  asOf: number;
  /** Candles per coin, CANDLE_BARS bars ending at asOf (bar opens asOf − CANDLE_BARS·1h … asOf − 1h). */
  candles: Record<string, Candle[]>;
  /** Bar open of the shocked hour (inside the last 24 bars). */
  shockAt: number;
}

/** BTC, ETH, COIN and peers P1..P4; `shockHoursAgo` places the shock (1 = the last closed bar). */
export function fixtureSet(o: { seed?: number; shockHoursAgo?: number; asOf?: number; bars?: number } = {}): FixtureSet {
  const g = rng(o.seed ?? 7);
  const asOf = o.asOf ?? FIXTURE_AS_OF;
  const bars = o.bars ?? CANDLE_BARS;
  const n = bars - 1; // returns
  const firstOpen = asOf - bars * HOUR_MS;
  const shockIdx = n - (o.shockHoursAgo ?? 5);
  const btc: number[] = [], ethx: number[] = [], sect: number[] = [];
  for (let i = 0; i < n; i++) btc.push(g(0.006)), ethx.push(g(0.004)), sect.push(g(0.008));
  // Orthogonalise the draws on the 24h estimation window, so the planted betas are the in-sample truth (a chance
  // correlation between the sector draw and ETH would otherwise move into the ETH beta, by design of the factors).
  const est = Array.from({ length: 168 }, (_, k) => n - 24 - 168 + k);
  const resid = (y: number[], x: number[]) => {
    const my = est.reduce((a, i) => a + y[i]!, 0) / est.length, mx = est.reduce((a, i) => a + x[i]!, 0) / est.length;
    const b = est.reduce((a, i) => a + (x[i]! - mx) * (y[i]! - my), 0) / est.reduce((a, i) => a + (x[i]! - mx) ** 2, 0);
    for (let i = 0; i < n; i++) y[i] = y[i]! - b * x[i]!;
  };
  resid(ethx, btc);
  resid(sect, btc);
  resid(sect, ethx);
  const eth = btc.map((b, i) => 1.1 * b + ethx[i]!);
  const peers = [1, 2, 3, 4].map(() => btc.map((b, i) => 1.2 * b + sect[i]! + g(0.002)));
  const coin = btc.map((b, i) => PLANTED.btc * b + PLANTED.eth * ethx[i]! + PLANTED.sector * sect[i]! + g(0.0005) + (i === shockIdx ? SHOCK : 0));
  const candles: Record<string, Candle[]> = {
    BTC: candlesFrom(btc, firstOpen, 90_000),
    ETH: candlesFrom(eth, firstOpen, 3_000),
    COIN: candlesFrom(coin, firstOpen, 10),
    ...Object.fromEntries(peers.map((p, i) => [`P${i + 1}`, candlesFrom(p, firstOpen, 5)])),
  };
  return { asOf, candles, shockAt: firstOpen + (shockIdx + 1) * HOUR_MS };
}

/** A sectors file listing COIN with its four peers, and a two-coin basket (one peer ex-majors). */
export const FIXTURE_SECTORS = {
  generated_at: "2026-11-02T07:00:00Z",
  sectors: [
    { id: "alt", label: "Alt basket", mindshare_score: 0.5, momentum: 0, rationale: "fixture", tokens: ["COIN", "P1", "P2", "P3", "P4"], sources: [] },
    { id: "l1-majors", label: "L1 majors", mindshare_score: 0.5, momentum: 0, rationale: "fixture", tokens: ["BTC", "ETH", "P1", "LONE"], sources: [] },
  ],
  rotations: [],
};
