import { describe, expect, test } from "bun:test";
import { AttributionSchema } from "../../shared/moves.js";
import { attribute, basketReturns, buildFactors, coinEvents, flowHours, hourlyOi, hourlyReturns, newsHours, ols, windowBars, type AttributeInput, type Returns } from "./attribution.js";
import { HOUR_MS } from "./constants.js";
import { fixtureSet, PLANTED, SHOCK } from "./fixtures/series.js";

const fx = fixtureSet();
const R = Object.fromEntries(Object.entries(fx.candles).map(([k, v]) => [k, hourlyReturns(v)]));
const peers = ["P1", "P2", "P3", "P4"].map((p) => R[p]!);
const base = (o: Partial<AttributeInput> = {}): AttributeInput => ({ coin: "COIN", window: "24h", asOf: fx.asOf, r: R.COIN!, btc: R.BTC!, eth: R.ETH!, peers, flow: null, news: null, ...o });
const parts = (a: NonNullable<ReturnType<typeof attribute>["attribution"]>) => a.btcPct + a.ethPct + (a.sectorPct ?? 0) + a.residualPct;
const drop = (r: Returns, pred: (t: number) => boolean): Returns => new Map([...r].filter(([t]) => !pred(t)));

describe("hourlyReturns / windowBars / ols", () => {
  test("log returns keyed by bar open; a gap leaves the next bar without a return (never zero)", () => {
    const r = hourlyReturns([{ t: 0, c: 100 }, { t: HOUR_MS, c: 110 }, { t: 3 * HOUR_MS, c: 121 }, { t: 4 * HOUR_MS, c: 121 }]);
    expect([...r.keys()]).toEqual([HOUR_MS, 4 * HOUR_MS]);
    expect(r.get(HOUR_MS)).toBeCloseTo(Math.log(1.1), 12);
    expect(r.get(4 * HOUR_MS)).toBe(0);
  });

  test("window = last h closed bars; estimation = the 168 before it", () => {
    const { est, win } = windowBars(fx.asOf, 4);
    expect(win).toEqual([4, 3, 2, 1].map((k) => fx.asOf - k * HOUR_MS));
    expect(est).toHaveLength(168);
    expect(est.at(-1)).toBe(fx.asOf - 5 * HOUR_MS);
  });

  test("ols recovers an exact linear model and refuses a singular one", () => {
    const x1 = [1, 2, 3, 4, 5, 6], x2 = [2, 1, 4, 3, 6, 5];
    const o = ols(x1.map((v, i) => 0.5 + 2 * v - 3 * x2[i]!), [x1, x2])!;
    expect(o.alpha).toBeCloseTo(0.5, 9);
    expect(o.betas[0]).toBeCloseTo(2, 9);
    expect(o.betas[1]).toBeCloseTo(-3, 9);
    expect(ols([1, 2, 3, 4], [[1, 2, 3, 4], [2, 4, 6, 8]])).toBeNull();
  });
});

describe("attribute on the planted fixture", () => {
  const res = attribute(base());
  const a = res.attribution!;

  test("recovers the planted betas within 0.05", () => {
    expect(AttributionSchema.parse(a)).toEqual(a);
    const beta = (k: string) => a.betas.find((b) => b.factor === k)!.beta!;
    expect(Math.abs(beta("BTC") - PLANTED.btc)).toBeLessThan(0.05);
    expect(Math.abs(beta("ETH") - PLANTED.eth)).toBeLessThan(0.05);
    expect(Math.abs(beta("SECTOR") - PLANTED.sector)).toBeLessThan(0.05);
    expect(a.estimation.n).toBe(168);
    expect(a.r2!).toBeGreaterThan(0.9);
  });

  test("btc + eth + sector + residual === total to 1e-9, for every window", () => {
    for (const window of ["4h", "24h", "72h"] as const) {
      const x = attribute(base({ window })).attribution!;
      expect(Math.abs(parts(x) - x.totalPct)).toBeLessThan(1e-9);
      expect(x.hours).toBe({ "4h": 4, "24h": 24, "72h": 72 }[window]);
    }
  });

  test("the planted shock lands in the residual with a large z", () => {
    expect(Math.abs(a.residualPct - 100 * SHOCK)).toBeLessThan(0.6);
    expect(a.residualZ!).toBeGreaterThan(5);
    expect(Math.abs(a.totalPct - (a.btcPct + a.ethPct + a.sectorPct!)) ).toBeGreaterThan(4);
    // The cumulative residual series jumps at the shocked hour.
    const at = res.series.findIndex((p) => p.t === fx.shockAt);
    expect(res.series[at]!.cumResidualPct - (res.series[at - 1]?.cumResidualPct ?? 0)).toBeGreaterThan(4);
    expect(res.series.at(-1)!.cumResidualPct).toBeCloseTo(a.residualPct, 9);
  });

  test("a shock outside the window stays out of the residual", () => {
    const quiet = fixtureSet({ shockHoursAgo: 30 });
    const RR = Object.fromEntries(Object.entries(quiet.candles).map(([k, v]) => [k, hourlyReturns(v)]));
    const x = attribute({ ...base(), r: RR.COIN!, btc: RR.BTC!, eth: RR.ETH!, peers: ["P1", "P2", "P3", "P4"].map((p) => RR[p]!), window: "4h" }).attribution!;
    expect(Math.abs(x.residualZ!)).toBeLessThan(3);
  });
});

describe("minimum-n rules and special cases", () => {
  test("under 120 estimation bars: null with the reason", () => {
    const { est } = windowBars(fx.asOf, 24);
    const cut = new Set(est.slice(0, 94)); // leaves 74
    const res = attribute(base({ r: drop(R.COIN!, (t) => cut.has(t)) }));
    expect(res.attribution).toBeNull();
    expect(res.reason).toBe("needs 120 of 168 hourly bars before the window — has 74");
  });

  test("under 0.75·h bars in the window: null with the reason", () => {
    const { win } = windowBars(fx.asOf, 4);
    const res = attribute(base({ window: "4h", r: drop(R.COIN!, (t) => t === win[0] || t === win[1]) }));
    expect(res.reason).toBe("window has 2 of 4 hourly bars (needs 3)");
  });

  test("BTC is the factor: total only, residual 0", () => {
    const a = attribute(base({ coin: "BTC", r: R.BTC! })).attribution!;
    expect(a.btcPct).toBe(a.totalPct);
    expect([a.ethPct, a.residualPct, a.sectorPct, a.residualZ]).toEqual([0, 0, null, null]);
    expect(a.betas[0]).toMatchObject({ factor: "BTC", beta: 1, reason: "BTC is the factor" });
  });

  test("ETH: BTC factor only, its move ex-BTC is the residual", () => {
    const a = attribute(base({ coin: "ETH", r: R.ETH! })).attribution!;
    expect(Math.abs(a.betas[0]!.beta! - 1.1)).toBeLessThan(0.05);
    expect(a.ethPct).toBe(0);
    expect(a.sectorPct).toBeNull();
    expect(a.betas[1]!.reason).toBe("ETH is the factor: its move ex-BTC is the residual");
    expect(Math.abs(parts(a) - a.totalPct)).toBeLessThan(1e-9);
  });

  test("sector dropped with fewer than 2 peers, or with too few basket bars", () => {
    const one = attribute(base({ peers: [R.P1!] })).attribution!;
    expect(one.sectorPct).toBeNull();
    expect(one.betas[2]).toMatchObject({ factor: "SECTOR", beta: null, reason: "sector has 1 peer ex-majors (needs 2)" });
    expect(Math.abs(parts(one) - one.totalPct)).toBeLessThan(1e-9);
    const none = attribute(base({ peers: null })).attribution!;
    expect(none.betas[2]!.reason).toBe("not in a sector basket");
    const { est } = windowBars(fx.asOf, 24);
    const cut = new Set(est.slice(0, 100));
    const sparse = attribute(base({ peers: peers.map((p, i) => (i < 3 ? drop(p, (t) => cut.has(t)) : p)) })).attribution!;
    expect(sparse.betas[2]!.reason).toBe("sector basket has 68 of 120 bars before the window");
  });

  test("basket needs 2 peers present at the hour; f3 is orthogonal to f1 and f2 on E", () => {
    const s = basketReturns([new Map([[1, 0.1], [2, 0.2]]), new Map([[1, 0.3]])], [1, 2]);
    expect([...s]).toEqual([[1, 0.2]]);
    const { est, win } = windowBars(fx.asOf, 24);
    const F = buildFactors(R.BTC!, R.ETH!, peers, est, win);
    const dot = (a: Returns, b: Returns) => {
      const ts = est.filter((t) => a.has(t) && b.has(t));
      const ma = ts.reduce((x, t) => x + a.get(t)!, 0) / ts.length, mb = ts.reduce((x, t) => x + b.get(t)!, 0) / ts.length;
      return ts.reduce((x, t) => x + (a.get(t)! - ma) * (b.get(t)! - mb), 0);
    };
    expect(Math.abs(dot(F.f3!, F.f1))).toBeLessThan(1e-12);
    expect(Math.abs(dot(F.f3!, F.f2))).toBeLessThan(1e-12);
    expect(Math.abs(dot(F.f2, F.f1))).toBeLessThan(1e-12);
  });
});

describe("flow and news hours, residual split", () => {
  const { est, win } = windowBars(fx.asOf, 24);
  const bars = [...est, ...win];
  // OI wiggles ±0.5% around a level, and drops 20% at the shocked hour.
  const oiSnaps = bars.flatMap((t, i) => [{ ts: t + HOUR_MS - 60_000, oiUsd: 1e8 * (1 + 0.005 * Math.sin(i * 1.7)) * (t >= fx.shockAt ? 0.8 : 1) }]);

  test("hourly OI is the last snapshot at or before the close within 10 min", () => {
    const oi = hourlyOi([{ ts: 2 * HOUR_MS - 11 * 60_000, oiUsd: 1 }, { ts: 3 * HOUR_MS - 60_000, oiUsd: 2 }, { ts: 3 * HOUR_MS + 1, oiUsd: 3 }], [HOUR_MS, 2 * HOUR_MS]);
    expect([...oi]).toEqual([[2 * HOUR_MS, 2]]);
  });

  test("flow hours need 48 OI changes on E; the OI drop hour is a flow hour", () => {
    const oi = hourlyOi(oiSnaps, bars);
    const f = flowHours(oi, est, win);
    expect(f.hours && [...f.hours]).toEqual([fx.shockAt]);
    const thin = flowHours(new Map([...oi].filter(([t]) => t >= est[130]!)), est, win);
    expect(thin).toMatchObject({ hours: null, reason: "needs 48 hourly OI changes before the window — has 37" });
  });

  test("news hours: an event first seen in [t − 2h, t + 1h) marks hour t; flow events and other coins are not news", () => {
    const evs = [
      { assets: ["coin"], origin: "rss", firstSeen: new Date(fx.shockAt + 30 * 60_000).toISOString() },
      { assets: ["COIN"], origin: "flow", firstSeen: new Date(win[0]!).toISOString() },
      { assets: ["BTC"], origin: "rss", firstSeen: new Date(win[0]!).toISOString() },
    ] as Parameters<typeof coinEvents>[0];
    const seen = coinEvents(evs, "COIN");
    expect(seen).toHaveLength(1);
    const h = newsHours(seen, win);
    expect([...h].sort()).toEqual([fx.shockAt, fx.shockAt + HOUR_MS, fx.shockAt + 2 * HOUR_MS]);
  });

  test("precedence flow > news > other; buckets sum to the residual; unavailable layers are null", () => {
    const flow = flowHours(hourlyOi(oiSnaps, bars), est, win);
    const news = new Set([fx.shockAt, fx.shockAt - HOUR_MS]);
    const res = attribute(base({ flow, news }));
    const a = res.attribution!;
    expect(a.flowHours).toBe(1);
    expect(a.newsHours).toBe(1);
    expect(res.overlap).toBe(1);
    expect(a.residualFlowPct!).toBeGreaterThan(4);
    expect(Math.abs(a.residualFlowPct! + a.residualNewsPct! + a.residualOtherPct - a.residualPct)).toBeLessThan(1e-9);
    const off = attribute(base({ flow: null, news: null })).attribution!;
    expect([off.residualFlowPct, off.residualNewsPct, off.flowHours, off.newsHours]).toEqual([null, null, null, null]);
    expect(off.residualOtherPct).toBeCloseTo(off.residualPct, 12);
    const newsOnly = attribute(base({ flow: null, news })).attribution!;
    expect(newsOnly.newsHours).toBe(2);
    expect(newsOnly.residualNewsPct!).toBeGreaterThan(4);
  });
});
