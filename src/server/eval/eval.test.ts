import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../lab/engine/rng.js";
import { createEvalRoutes, parseLevels, parseRaces } from "../routes/eval.js";
import { panelsFromSnapshot, snapshotOf } from "./load.js";
import { backtest, cvar, evaluate, maxDrawdown, sharpe, splitOf } from "./objective.js";
import { buildPanel, realizedVol, trailingMean, type EvalPanel } from "./panel.js";
import { simulatePaths } from "./paths.js";
import { labelRegimes, rawRegimes, regimeCounts, smoothRegimes, transitionMatrix, type Regime } from "./regimes.js";
import { contextOf, finalize, runSearch, scoreSpec } from "./search.js";
import { assetView } from "./service.js";
import { DEFAULT_SPECS, FAMILIES, normalizeSpec, positions, specKey } from "./strategies.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2021, 0, 1);

/** A synthetic asset: a slow rise, a crash, a range, a recovery; seeded noise; funding and F&G that follow price. */
function synth(asset = "BTC", n = 1400, seed = 7): EvalPanel {
  const rng = mulberry32(seed);
  const price: number[] = [];
  let p = 30_000;
  for (let i = 0; i < n; i++) {
    const drift = i < 400 ? 0.002 : i < 600 ? -0.004 : i < 1000 ? 0 : 0.0015;
    p *= Math.exp(drift + 0.03 * (rng() - 0.5) * 2);
    price.push(p);
  }
  const ma = trailingMean(price, 30);
  return buildPanel({
    asset,
    t: price.map((_, i) => T0 + i * DAY),
    price,
    iv: asset === "HYPE" ? undefined : realizedVol(price).map((v, i) => (i > 200 ? v * 1.15 : NaN)),
    funding: price.map((x, i) => (i > 100 && Number.isFinite(ma[i]!) ? (x / ma[i]! - 1) * 0.001 : NaN)),
    fng: price.map((x, i) => (Number.isFinite(ma[i]!) ? Math.max(0, Math.min(100, 50 + (x / ma[i]! - 1) * 400)) : NaN)),
    mvrv: asset === "HYPE" ? undefined : price.map(() => 1.5),
  });
}

describe("panel", () => {
  test("HYPE implied vol is realized vol times the borrowed variance premium", () => {
    const h = synth("HYPE");
    expect(h.ivSource).toBe("realized");
    const rv = realizedVol(h.price);
    const i = 500;
    expect(h.iv[i]! / rv[i]!).toBeCloseTo(1.1, 6);
    const b = buildPanel({ asset: "HYPE", t: h.t, price: h.price, variancePremium: 1.3 });
    expect(b.iv[i]! / rv[i]!).toBeCloseTo(1.3, 6);
  });

  test("BTC fills IV gaps before DVOL existed and says the source is mixed", () => {
    const b = synth("BTC");
    expect(b.ivSource).toBe("mixed");
    expect(Number.isFinite(b.iv[100]!)).toBe(true);
  });

  test("the STH stand-in continues a stored series at its level", () => {
    const price = Array.from({ length: 400 }, (_, i) => 100 + i);
    const proxy = trailingMean(price);
    const stored = proxy.map((v, i) => (i >= 200 && i < 300 ? v * 1.2 : NaN));
    const p = buildPanel({ asset: "BTC", t: price.map((_, i) => i * DAY), price, sthRp: stored });
    expect(p.sthSource).toBe("mixed");
    expect(p.sthRp[350]! / proxy[350]!).toBeCloseTo(1.2, 6);
  });

  test("snapshot round-trips", () => {
    const ps = [synth("BTC"), synth("ETH", 1400, 9)];
    const back = panelsFromSnapshot(snapshotOf(ps), ["BTC", "ETH"]);
    expect(back.map((p) => p.asset)).toEqual(["BTC", "ETH"]);
    expect(back[0]!.price.at(-1)).toBeCloseTo(ps[0]!.price.at(-1)!, 6);
  });
});

describe("regimes", () => {
  test("hysteresis: a label needs minRun days in a row to change", () => {
    const raw: Regime[] = ["range", "range", "bull", "range", "bull", "bull", "bull"];
    expect(smoothRegimes(raw, 3)).toEqual(["range", "range", "range", "range", "range", "range", "bull"]);
  });

  test("deep drawdown is capitulation, the crash shows up in the synthetic series", () => {
    const p = synth();
    const lab = labelRegimes(p);
    expect(lab.length).toBe(p.price.length);
    const c = regimeCounts(lab);
    expect(c.capitulation + c.bear).toBeGreaterThan(0);
    const price = [...Array(400)].map((_, i) => (i < 300 ? 100 : 30));
    const r = rawRegimes({ price, sthRp: price.map(() => NaN), fng: price.map(() => NaN), mvrv: price.map(() => NaN) });
    expect(r[350]).toBe("capitulation");
  });

  test("transition rows sum to one", () => {
    const m = transitionMatrix(labelRegimes(synth()));
    for (const row of Object.values(m)) expect(Object.values(row).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe("objective", () => {
  test("position decided at close i earns return i+1, minus funding and the fee on the change", () => {
    const p = synth();
    const pos = p.price.map(() => 0);
    pos[300] = 1;
    const { ret } = backtest(p, pos, 300, 303);
    const r = p.price[301]! / p.price[300]! - 1;
    expect(ret[0]).toBe(0);
    expect(ret[1]!).toBeCloseTo(r - p.funding[301]! - 0.0005, 12);
    expect(ret[2]!).toBeCloseTo(-0.0005, 12);
  });

  test("stats", () => {
    expect(maxDrawdown([0.1, -0.5, 0.2])).toBeCloseTo(0.5, 9);
    expect(cvar([-0.1, 0.1, 0.2, 0.3], 0.25)).toBeCloseTo(0.1, 9);
    expect(sharpe([0.01, 0.01, 0.01])).toBe(0);
  });

  test("flat scores zero and buy-and-hold scores something finite", () => {
    const p = synth();
    const reg = labelRegimes(p);
    expect(evaluate(p, p.price.map(() => 0), reg).score).toBe(0);
    expect(Number.isFinite(evaluate(p, p.price.map(() => 1), reg).score)).toBe(true);
  });

  test("the size of a position does not change its score", () => {
    const p = synth();
    const reg = labelRegimes(p);
    const pos = positions(DEFAULT_SPECS.trend, p, reg);
    const a = evaluate(p, pos, reg, 300, 1300).score;
    const b = evaluate(p, pos.map((x) => x * 0.01), reg, 300, 1300).score;
    expect(b).toBeCloseTo(a, 2);
  });

  test("the split keeps the holdout last and the folds before it", () => {
    const s = splitOf(1000, 200);
    expect(s.holdout).toBe(840);
    expect(s.folds[0]![0]).toBe(200);
    expect(s.folds.at(-1)![1]).toBe(840);
  });
});

describe("strategies and search", () => {
  test("every family yields one bounded position per day", () => {
    const p = synth();
    const reg = labelRegimes(p);
    for (const f of FAMILIES) {
      const pos = positions(DEFAULT_SPECS[f], p, reg);
      expect(pos.length).toBe(p.price.length);
      for (const x of pos) expect(Math.abs(x)).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  test("a regime gate holds nothing outside its regimes", () => {
    const p = synth();
    const reg = labelRegimes(p);
    const pos = positions({ ...DEFAULT_SPECS.hold, regimes: ["bull"] }, p, reg);
    pos.forEach((x, i) => {
      if (reg[i] !== "bull") expect(x).toBe(0);
    });
  });

  test("normalize clamps params into range and the key is stable", () => {
    const s = normalizeSpec({ family: "trend", params: { fast: -5, slow: 1e9, volTarget: 500, maxLev: 9 } });
    expect(s.params.maxLev).toBeLessThanOrEqual(2);
    expect(specKey(s)).toBe(specKey(normalizeSpec(s)));
  });

  test("the search never reads the holdout: changing it leaves the search score alone", () => {
    const p = synth();
    const q: EvalPanel = { ...p, price: p.price.slice() };
    const c = contextOf(p);
    for (let i = c.split.holdout + 1; i < q.price.length; i++) q.price[i] = q.price[i]! * (i % 2 ? 1.2 : 0.8);
    const a = scoreSpec(DEFAULT_SPECS.trend, [c]).score;
    const b = scoreSpec(DEFAULT_SPECS.trend, [contextOf(q)]).score;
    expect(b).toBeCloseTo(a, 9);
  });

  test("the loop keeps only improvements and logs every experiment", () => {
    const ctxs = [contextOf(synth())];
    const res = runSearch(ctxs, { families: ["trend"], seed: 3, maxExperiments: 25 });
    expect(res.log.length).toBe(25);
    let best = -Infinity;
    for (const e of res.log) {
      if (e.status === "keep" || e.status === "baseline") {
        expect(e.score).toBeGreaterThan(best);
        best = e.score;
      } else expect(e.score).toBeLessThanOrEqual(best);
    }
    const fin = finalize(res, ctxs);
    expect(fin[0]!.holdout.BTC!.days).toBeGreaterThan(0);
  });
});

describe("paths", () => {
  test("bands are ordered, start at spot, and touch odds are monotone in distance", () => {
    const p = synth();
    const spot = p.price.at(-1)!;
    const r = simulatePaths(p, { horizon: 30, n: 800, seed: 1, levels: [spot * 0.9, spot * 0.8, spot * 1.1], races: [[spot * 0.9, spot * 1.1]] });
    expect(r.bands[0]!.p50).toBeCloseTo(spot, 6);
    for (const b of r.bands) expect(b.p5 <= b.p25 && b.p25 <= b.p50 && b.p50 <= b.p75 && b.p75 <= b.p95).toBe(true);
    const [l90, l80] = r.levels;
    expect(l90!.touch).toBeGreaterThanOrEqual(l80!.touch);
    expect(l90!.touch).toBeGreaterThanOrEqual(l90!.close);
    const race = r.races[0]!;
    expect(race.loFirst + race.hiFirst + race.neither).toBeCloseTo(1, 9);
    expect(r.regimeMix.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 6);
  });

  test("same seed, same fan", () => {
    const p = synth();
    const a = simulatePaths(p, { horizon: 20, n: 300, seed: 5 });
    const b = simulatePaths(p, { horizon: 20, n: 300, seed: 5 });
    expect(a.bands).toEqual(b.bands);
  });
});

describe("service and route", () => {
  test("asset view carries regime, fan and champions", () => {
    const v = assetView(synth(), { horizon: 20, n: 300 });
    expect(v.asset).toBe("BTC");
    expect(v.paths.horizon).toBe(20);
    expect(v.champions.length).toBeGreaterThan(0);
  });

  test("level and race parsing drops junk", () => {
    expect(parseLevels("BTC:58500,66000;eth:1500;x:1;BAD")).toEqual({ BTC: [58500, 66000], ETH: [1500] });
    expect(parseRaces("BTC:58500-66000,9-1")).toEqual({ BTC: [[58500, 66000]] });
    expect(parseLevels(undefined)).toBeUndefined();
  });

  test("GET /eval passes parsed options and rejects a bad horizon", async () => {
    let seen: unknown;
    const app = createEvalRoutes(async (o) => {
      seen = o;
      return { ok: true };
    });
    const ok = await app.request("/?horizon=30&levels=BTC:60000");
    expect(ok.status).toBe(200);
    expect(seen).toEqual({ horizon: 30, levels: { BTC: [60000] }, races: undefined });
    expect((await app.request("/?horizon=2")).status).toBe(400);
  });
});
