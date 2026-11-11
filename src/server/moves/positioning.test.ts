import { describe, expect, test } from "bun:test";
import { AttentionSchema, LiqProximitySchema, PositioningSchema } from "../../shared/moves.js";
import { HOUR_MS } from "./constants.js";
import { attention, liqProximity, positioning, sampleNear, type PositioningInput } from "./positioning.js";

const NOW = Date.parse("2026-11-10T12:30:00Z");
const flat = (n: number, v = 0.00001) => Array.from({ length: n }, (_, i) => v + (i % 2 ? 1e-6 : -1e-6));
const input = (o: Partial<Omit<PositioningInput, "ctx">> & { ctx?: Partial<PositioningInput["ctx"]> } = {}): PositioningInput => ({
  fundingHourly: flat(336),
  oi: [{ ts: NOW - 24 * HOUR_MS + 5 * 60_000, v: 90e6 }, { ts: NOW - 72 * HOUR_MS - 60_000, v: 80e6 }],
  priceChg72hPct: 4,
  now: NOW,
  ...o,
  ctx: { funding: 0.0001, premium: 0.0006, oiUsd: 100e6, dayNtlVlm: 50e6, ...o.ctx },
});
const met = (p: ReturnType<typeof positioning>, side: string) => Object.fromEntries(p.checks.filter((c) => c.side === side).map((c) => [c.key, c.met]));

describe("positioning", () => {
  test("hourly funding (fraction) → APR %; z against the prior hourly values; OI changes; premium in bps", () => {
    const p = PositioningSchema.parse(positioning(input()));
    expect(p.fundingAprPct).toBeCloseTo(0.0001 * 24 * 365 * 100, 9);
    expect(p.fundingZ!).toBeGreaterThan(2);
    expect(p.fundingN).toBe(336);
    expect(p.premiumBps).toBeCloseTo(6, 9);
    expect(p.oiChg24hPct).toBeCloseTo(100 * (100 / 90 - 1), 9);
    expect(p.oiChg72hPct).toBeCloseTo(25, 9);
    expect(p.oiToVolume).toBe(2);
  });

  test("crowded long: all four long checks met, the short side mirrored and not met", () => {
    const p = positioning(input());
    expect(met(p, "long")).toEqual({ funding_z: true, funding_apr: true, oi_build: true, premium: true });
    expect(met(p, "short")).toEqual({ funding_z: false, funding_apr: false, oi_build: false, premium: false });
    expect([p.longMet, p.shortMet, p.of]).toEqual([4, 0, 4]);
    expect(p.checks.find((c) => c.side === "short" && c.key === "funding_apr")!.threshold).toBe(-25);
  });

  test("crowded short mirrors: negative funding, OI build with price down, negative premium", () => {
    const p = positioning(input({ ctx: { funding: -0.0001, premium: -0.0006 }, fundingHourly: flat(336, 0), priceChg72hPct: -3 }));
    expect(met(p, "short")).toEqual({ funding_z: true, funding_apr: true, oi_build: true, premium: true });
    expect(p.longMet).toBe(0);
  });

  test("missing history: z null under 168 values, OI changes null without a point within 20 min; `of` excludes null checks", () => {
    const p = positioning(input({ fundingHourly: flat(100), oi: [{ ts: NOW - 24 * HOUR_MS + 21 * 60_000, v: 90e6 }], priceChg72hPct: null }));
    expect(p.fundingZ).toBeNull();
    expect(p.fundingN).toBe(100);
    expect([p.oiChg24hPct, p.oiChg72hPct]).toEqual([null, null]);
    expect(met(p, "long")).toEqual({ funding_z: null, funding_apr: true, oi_build: null, premium: true });
    expect(p.of).toBe(2);
    expect(p.longMet).toBe(2);
  });

  test("sampleNear picks the closest point within the tolerance", () => {
    expect(sampleNear([{ ts: 100, v: 1 }, { ts: 130, v: 2 }], 120, 15)).toBe(2);
    expect(sampleNear([{ ts: 100, v: 1 }], 120, 15)).toBeNull();
  });
});

describe("liqProximity and attention", () => {
  test("distances in 24h sigmas; null without a sigma", () => {
    const ok = { state: "ok" as const, reason: null };
    const cl = { priceLo: 9, priceHi: 9.5, distancePct: 3, notionalUsd: 1e6 };
    const l = LiqProximitySchema.parse(liqProximity(ok, { long: cl, short: null }, 0.3, 6));
    expect([l.longSigmas, l.shortSigmas, l.coverageRatio]).toEqual([0.5, null, 0.3]);
    expect(liqProximity(ok, { long: cl, short: null }, 0.3, null).longSigmas).toBeNull();
  });

  test("news counts, prior-7d daily mean with the 0.5 floor, Elfa change as a percent", () => {
    const d = 24 * HOUR_MS;
    const news = [NOW - 1000, NOW - 2 * HOUR_MS, NOW - 2 * d, NOW - 5 * d];
    const a = AttentionSchema.parse(attention({ state: { state: "ok", reason: null }, news, social: { mentions24h: 120, mentionsChg24h: 0.6, ts: new Date(NOW - HOUR_MS) }, sectorId: "alt", sectorStage: "crowded", now: NOW }));
    expect([a.news24h, a.news72h]).toEqual([2, 3]);
    expect(a.newsDailyMean7d).toBeCloseTo(2 / 7, 12);
    expect(a.newsRatio).toBeCloseTo(2 / 0.5, 12);
    expect(a.mentionsChg24hPct).toBeCloseTo(60, 9);
    const none = attention({ state: { state: "unavailable", reason: "needs a database (news and Elfa are stored)" }, news: null, social: null, sectorId: null, sectorStage: null, now: NOW });
    expect([none.news24h, none.newsRatio, none.mentions24h, none.mentionsAsOf]).toEqual([null, null, null, null]);
  });
});
