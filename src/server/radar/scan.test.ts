import { describe, expect, test } from "bun:test";
import { RADAR_STATE_DAYS, type RadarState } from "../../shared/radar.js";
import type { AssetCtx } from "../../shared/types.js";
import { digest, formatDigest, moveSince, nextState, seedDays, showMarkets, toMarkets, type RadarMarket } from "./scan.js";

const ctx = (name: string, o: Partial<AssetCtx> = {}): AssetCtx => ({
  name,
  szDecimals: 2,
  markPx: 10,
  oraclePx: 10,
  midPx: 10,
  dayNtlVlm: 5_000_000,
  prevDayPx: 10,
  openInterest: 500_000,
  funding: 0.0000125,
  premium: 0,
  dayChange: 0,
  isDelisted: false,
  ...o,
});

const mk = (key: string, o: Partial<RadarMarket> = {}): RadarMarket => ({
  key,
  dex: "main",
  mark: 10,
  chg24hPct: 0,
  vol24h: 5_000_000,
  oiUsd: 5_000_000,
  fundingApr: 11,
  premiumBps: 0,
  atCap: false,
  ...o,
});

const day = (date: string, marks: Record<string, [number, number, number]>) => ({ date, at: `${date}T07:41:00Z`, marks });

describe("toMarkets", () => {
  test("keeps live markets on every dex, converts units, drops delisted", () => {
    const out = toMarkets(
      [
        { dex: "", ctxs: [ctx("BTC", { markPx: 110, prevDayPx: 100, funding: 0.0001, premium: -0.0005 }), ctx("OLD", { isDelisted: true })] },
        { dex: "xyz", ctxs: [ctx("xyz:SKHX", { markPx: 2, openInterest: 1000 })] },
      ],
      new Set(["BTC"]),
    );
    expect(out.map((m) => m.key)).toEqual(["BTC", "xyz:SKHX"]);
    const btc = out[0]!;
    expect(btc.dex).toBe("main");
    expect(btc.chg24hPct).toBeCloseTo(10);
    expect(btc.fundingApr).toBeCloseTo(87.6); // hourly rate x 24 x 365
    expect(btc.premiumBps).toBeCloseTo(-5);
    expect(btc.atCap).toBe(true);
    expect(out[1]!.dex).toBe("xyz");
    expect(out[1]!.oiUsd).toBe(2000);
  });
});

describe("digest", () => {
  test("cold start: no memory means no new-listing, 7d, spike or OI-move claims", () => {
    const d = digest([mk("BTC", { mark: 100 }), mk("HYPE", { chg24hPct: 15 })], null, "2026-11-02");
    expect(d.newListings).toBeNull();
    expect(d.up7d).toBeNull();
    expect(d.volSpikes).toBeNull();
    expect(d.oiMoves).toBeNull();
    expect(d.up24h.map((m) => m.key)).toEqual(["HYPE"]);
    expect(formatDigest(d)).toContain("cold start");
  });

  test("a same-day snapshot from an earlier run is not history", () => {
    const state: RadarState = { days: [day("2026-11-02", { BTC: [100, 1e9, 1e9] })] };
    const d = digest([mk("BTC"), mk("NEW")], state, "2026-11-02");
    expect(d.history.days).toBe(0);
    expect(d.newListings).toBeNull();
  });

  test("new listings, rank entrants, OI moves and 7d movers against memory", () => {
    const state: RadarState = {
      days: [
        day("2026-10-25", { BTC: [100, 9e9, 9e9], HYPE: [40, 3e8, 1e9], MEGA: [2, 5e6, 4e6] }),
        day("2026-11-01", { BTC: [100, 9e9, 9e9], HYPE: [44, 3e8, 1e9], MEGA: [2, 5e6, 4e6], BUILD: [1, 5e6, 5e6] }),
      ],
    };
    const markets = [
      mk("BTC", { mark: 100, vol24h: 9e9, oiUsd: 9e9 }),
      mk("HYPE", { mark: 50, vol24h: 4e8, oiUsd: 1.5e9 }),
      mk("MEGA", { mark: 1, vol24h: 6e6, oiUsd: 2e6 }),
      mk("BUILD", { mark: 0.7, vol24h: 6e6, oiUsd: 4.9e6 }),
      mk("xyz:NEWCO", { dex: "xyz", vol24h: 2e7 }),
    ];
    const d = digest(markets, state, "2026-11-02");
    expect(d.history).toEqual({ days: 2, seeded: 0, prevDate: "2026-11-01", weekDate: "2026-10-25" });
    expect(d.newListings!.map((m) => m.key)).toEqual(["xyz:NEWCO"]);
    expect(d.rankEntrants!.map((m) => m.key)).toEqual(["xyz:NEWCO"]);
    expect(d.up7d!.map((m) => [m.key, Math.round(m.chgPct)])).toEqual([["HYPE", 25]]);
    expect(d.down7d!.map((m) => [m.key, Math.round(m.chgPct)])).toEqual([["MEGA", -50]]);
    // In contracts: HYPE 22.7M -> 30M (+32%); MEGA's price halved with contracts flat (no move); BUILD -30% price, +40% contracts.
    expect(d.oiMoves!.map((m) => [m.key, Math.round(m.oiChgPct)])).toEqual([["BUILD", 40], ["HYPE", 32]]);
  });

  test("7d base must be 7-9 days old; a 3-day-old snapshot is not a week", () => {
    const state: RadarState = { days: [day("2026-10-30", { HYPE: [40, 3e8, 1e9] })] };
    expect(digest([mk("HYPE", { mark: 50 })], state, "2026-11-02").up7d).toBeNull();
  });

  test("volume spike against the median of past days, floors applied", () => {
    const state: RadarState = {
      days: [day("2026-10-31", { A: [1, 2e6, 1e6], B: [1, 2e5, 1e6] }), day("2026-11-01", { A: [1, 2e6, 1e6], B: [1, 2e5, 1e6] })],
    };
    const d = digest([mk("A", { vol24h: 8e6 }), mk("B", { vol24h: 9e5 })], state, "2026-11-02");
    expect(d.volSpikes!.map((m) => [m.key, m.x])).toEqual([["A", 4]]); // B is under the $1M floor
  });

  test("funding and premium extremes respect thresholds and floors", () => {
    const d = digest(
      [
        mk("HOT", { fundingApr: 120 }),
        mk("COLD", { fundingApr: -60 }),
        mk("TINY", { fundingApr: 300, oiUsd: 1e5 }),
        mk("xyz:GAP", { dex: "xyz", premiumBps: -80 }),
        mk("CALM", { fundingApr: 20, premiumBps: 10 }),
      ],
      null,
      "2026-11-02",
    );
    expect(d.funding.map((m) => m.key)).toEqual(["HOT", "COLD"]);
    expect(d.premium.map((m) => m.key)).toEqual(["xyz:GAP"]);
  });

  test("the macro block prints after the header and gaps, before the dexes; none without lines", () => {
    const d = digest([mk("BTC")], null, "2026-11-02");
    const text = formatDigest(d, ["dex xyz: 429"], {}, ["policy    Fed funds 3.75-4.00", "macro gaps: none"]);
    expect(text.indexOf("gaps: dex xyz")).toBeLessThan(text.indexOf("\n## macro"));
    expect(text.indexOf("\n## macro")).toBeLessThan(text.indexOf("\n## dexes"));
    expect(text).toContain("macro gaps: none\n\n## dexes");
    expect(formatDigest(d)).not.toContain("## macro");
  });

  test("dex volume shares add up", () => {
    const d = digest([mk("BTC", { vol24h: 3e9 }), mk("xyz:A", { dex: "xyz", vol24h: 1e9 })], null, "2026-11-02");
    expect(d.dexes.map((x) => [x.dex, x.volSharePct])).toEqual([["main", 75], ["xyz", 25]]);
  });
});

describe("nextState", () => {
  test("replaces the same date, keeps order and rolls off the oldest", () => {
    const days = Array.from({ length: RADAR_STATE_DAYS }, (_, i) => day(`2026-10-${String(20 + i).padStart(2, "0")}`, {}));
    const s1 = nextState({ days }, [mk("BTC", { mark: 101.23456 })], "2026-11-02", "2026-11-02T07:41:00Z");
    expect(s1.days).toHaveLength(RADAR_STATE_DAYS);
    expect(s1.days[0]!.date).toBe("2026-10-21");
    expect(s1.days.at(-1)!.marks.BTC).toEqual([101.23, 5_000_000, 5_000_000]);
    const s2 = nextState(s1, [mk("BTC", { mark: 99 })], "2026-11-02", "2026-11-02T16:41:00Z");
    expect(s2.days).toHaveLength(RADAR_STATE_DAYS);
    expect(s2.days.at(-1)!.marks.BTC![0]).toBe(99);
  });
});

describe("seedDays", () => {
  const candle = (date: string, c: number, v: number) => ({ t: Date.parse(`${date}T00:00:00Z`), T: Date.parse(`${date}T23:59:59Z`), o: c, h: c, l: c, c, v });

  test("backfills missing dates from candles, keeps real days, flags seeds", () => {
    const real = day("2026-10-31", { BTC: [100, 1e9, 1e9] });
    // Day D pairs with the candle that closed at D 00:00 UTC, i.e. the candle opened on D-1.
    const s = seedDays({ days: [real] }, new Map([["HYPE", [candle("2026-10-23", 40, 1e6), candle("2026-10-30", 45, 1e6), candle("2026-10-31", 44, 2e6)]]]), "2026-11-02");
    expect(s.days.map((d) => [d.date, d.seeded ?? false])).toEqual([["2026-10-24", true], ["2026-10-31", false], ["2026-11-01", true]]);
    expect(s.days[2]!.marks.HYPE).toEqual([44, 88_000_000, 0]);
    expect(s.days[1]).toEqual(real);
  });

  test("seeded days feed 7d and spikes but never new listings, rank entrants or OI moves", () => {
    const seeded = { days: [{ ...day("2026-10-25", { HYPE: [40, 3e8, 0] }), seeded: true }, { ...day("2026-11-01", { HYPE: [44, 3e8, 0] }), seeded: true }] };
    const d = digest([mk("HYPE", { mark: 50 }), mk("ILLIQ", { vol24h: 1e5 })], seeded, "2026-11-02");
    expect(d.up7d!.map((m) => m.key)).toEqual(["HYPE"]);
    expect(d.newListings).toBeNull();
    expect(d.rankEntrants).toBeNull();
    expect(d.oiMoves).toBeNull();
    expect(d.history).toEqual({ days: 2, seeded: 2, prevDate: null, weekDate: "2026-10-25" });
  });
});

describe("dex failures", () => {
  test("a dex missing from today's scan does not promote others into the top 30", () => {
    const main = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`M${i}`, [1, 1e8 - i * 1e6, 1e6] as [number, number, number]]));
    const xyz = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`xyz:E${i}`, [1, 5e8, 1e6] as [number, number, number]]));
    const state: RadarState = { days: [{ ...day("2026-11-01", { ...main, ...xyz }), dexes: ["main", "xyz"] }] };
    const today = Object.entries(main).map(([k, v]) => mk(k, { vol24h: v[1], oiUsd: 1e6 }));
    expect(digest(today, state, "2026-11-02").rankEntrants).toEqual([]);
  });

  test("nextState carries a failed dex forward from the last real snapshot", () => {
    const state: RadarState = { days: [{ ...day("2026-11-01", { BTC: [100, 1, 1], "xyz:A": [5, 1, 1] }), dexes: ["main", "xyz"] }] };
    const next = nextState(state, [mk("BTC")], "2026-11-02", "t", ["xyz"]);
    expect(next.days.at(-1)!.marks["xyz:A"]).toEqual([5, 1, 1]);
    expect(next.days.at(-1)!.dexes).toEqual(["main", "xyz"]);
  });
});

describe("moveSince and show", () => {
  const state: RadarState = { days: [day("2026-10-29", { BTC: [100, 1, 1], HYPE: [80, 1, 1] }), day("2026-10-31", { BTC: [110, 1, 1], HYPE: [90, 1, 1] })] };

  test("move from the first snapshot on or after the date, absolute and vs BTC", () => {
    const m = moveSince(state, mk("HYPE", { mark: 88 }), 100, "2026-10-30")!;
    expect(m.fromDate).toBe("2026-10-31");
    expect(m.pct).toBeCloseTo(-2.22, 1);
    expect(m.vsBtcPct).toBeCloseTo(7.56, 1);
    expect(moveSince(state, mk("HYPE"), 100, "2026-11-05")).toBeNull();
  });

  test("show prints the line, daily marks and the since move; unknown markets say so", () => {
    const out = showMarkets([mk("BTC", { mark: 100 }), mk("HYPE", { mark: 88 })], state, ["HYPE", "NOPE"], "2026-10-29");
    expect(out[0]).toStartWith("HYPE [main] mark 88");
    expect(out[1]).toBe("  daily marks: 10-29 80 · 10-31 90");
    expect(out[2]).toBe("  since 2026-10-29: +10.0% (+10.0% vs BTC)");
    expect(out[3]).toBe("NOPE: not a live market in this scan");
  });
});
