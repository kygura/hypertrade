import { describe, expect, test } from "bun:test";
import type { NoveltyEntry } from "../../shared/platform.js";
import { admit, admitRun, replay, novelText, novelty, pendingNovel, type Candidate, type NoveltyDaily, type NoveltyHit } from "./novelty.js";

const D0 = Date.UTC(2025, 0, 1);
const DAY = 86_400_000;

/** n daily bars of steady noise (seeded): 2% price moves, volume ~1, funding ~1e-4. `over` replaces bars by index. */
function daily(n: number, over: { f?: Record<number, number>; v?: Record<number, number>; oi?: (i: number) => number | null; c?: Record<number, number> } = {}): NoveltyDaily {
  let s = 7;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5;
  const c: number[] = [];
  for (let i = 0; i < n; i++) c.push(over.c?.[i] ?? (i ? c[i - 1]! * (1 + 0.02 * rnd()) : 100));
  return {
    t: c.map((_, i) => D0 + i * DAY),
    c,
    v: c.map((_, i) => over.v?.[i] ?? 1 + 0.2 * rnd()),
    f: c.map((_, i) => over.f?.[i] ?? 1e-4 + 4e-5 * rnd()),
    oi: c.map((_, i) => over.oi?.(i) ?? null),
  };
}
const BIGS = { 100: 0.01, 101: 0.01, 102: 0.01 };

describe("novelty()", () => {
  test("an engineered funding extreme is a new_extreme in the funding family only", () => {
    const { hit } = novelty(daily(400, { f: { ...BIGS, 399: 0.05 } }));
    expect(hit!.kind).toBe("new_extreme");
    expect(hit!.families).toEqual(["funding"]);
    const z = hit!.features.find((f) => f.id === "funding_z90")!;
    expect(z.value).toBeGreaterThan(z.histMax);
    expect(z.pctRank).toBe(100);
    expect(z.bars).toBeGreaterThanOrEqual(90);
  });

  test("two families beyond p99 but inside min/max is a joint_extreme", () => {
    const { hit } = novelty(daily(400, { f: { ...BIGS, 399: 5e-4 }, v: { 200: 10, 201: 10, 202: 10, 399: 4 } }));
    expect(hit!.newExtremes).toBe(0);
    expect(hit!.kind).toBe("joint_extreme");
    expect(hit!.families).toEqual(["funding", "price"]);
    expect(hit!.features.map((f) => f.id)).toEqual(expect.arrayContaining(["funding_z90", "vol_x"]));
  });

  test("one family beyond p99, not an extreme: no hit", () => {
    expect(novelty(daily(400, { f: { ...BIGS, 399: 5e-4 } })).hit).toBeNull();
  });

  test("equal to the historical max is not beyond it", () => {
    // The same 7-bar climb (ret(7) = 1.2^... identical) at bar 107 and bar 399: the last bar ties the max.
    const climb = (from: number) => Object.fromEntries(Array.from({ length: 8 }, (_, k) => [from + k, 100 * 1.014 ** k]));
    const { hit } = novelty(daily(400, { f: { ...BIGS, 399: 5e-4 }, c: { ...climb(100), ...climb(392) } }));
    const r = hit!.features.find((f) => f.id === "ret(7)")!;
    expect(r.value).toBe(r.histMax);
    expect(r.pctRank).toBeLessThan(100);
    expect(hit!.features.filter((f) => f.value > f.histMax || f.value < f.histMin).map((f) => f.id)).not.toContain("ret(7)");
  });

  test("under 365 closed bars: nothing is checked and the skip says why", () => {
    const r = novelty(daily(364, { f: { 363: 0.05 } }));
    expect(r.hit).toBeNull();
    expect(r.skipped[0]).toContain("365");
  });

  test("OI features are skipped with a note until 365 days of OI exist", () => {
    const r = novelty(daily(400, { oi: (i) => (i < 300 ? null : i === 399 ? 40 : 100) }));
    expect(r.hit).toBeNull();
    expect(r.skipped.join()).toContain("OI history 100 of 365");
  });

  test("with 365 days of OI, a collapse of open interest is a new extreme in the oi family", () => {
    const { hit } = novelty(daily(400, { oi: (i) => (i === 399 ? 40 : 100 + (i % 7)) }));
    expect(hit!.kind).toBe("new_extreme");
    expect(hit!.families).toContain("oi");
    expect(hit!.features.find((f) => f.id === "oi_from_peak(20)")!.value).toBeLessThan(-0.5);
  });

  test("short funding history skips funding with a note, no crash", () => {
    const d = daily(400);
    d.f = d.f.map((x, i) => (i < 380 ? null : x));
    const r = novelty(d);
    expect(r.skipped.join()).toContain("funding_z90");
    expect(r.hit).toBeNull();
  });
});

const hit = (kind: NoveltyHit["kind"], newExtremes: number, nFeatures = newExtremes || 2): NoveltyHit => ({
  kind, newExtremes, families: ["funding"], features: Array.from({ length: nFeatures }, (_, i) => ({ id: `f${i}`, value: 1, histMin: 0, histMax: 0.5, p1: 0, p99: 0.4, bars: 400, pctRank: 100 })),
});
const cand = (coin: string, h: NoveltyHit, rank = 0): Candidate => ({ coin, rank, hit: h, nearSetups: [] });
const at = "2026-01-10T00:10:00.000Z";
const entry = (barDate: string, coin: string, over: Partial<NoveltyEntry> = {}): NoveltyEntry => ({
  id: `${barDate}:${coin}`, detectedAt: at, barDate, coin, kind: "new_extreme", families: ["funding"], features: [], nearSetups: [], marketWide: false, pushed: true, notified: [], ...over,
});

describe("admit()", () => {
  test("a new extreme is pushed; a joint-only hit is journalled and never pushed or suppressed; reruns add nothing", () => {
    const cs = [cand("SOL", hit("new_extreme", 1)), cand("ETH", hit("joint_extreme", 0))];
    const out = admit("2026-01-09", cs, [], 3, at);
    expect(out.map((e) => [e.coin, e.kind, e.pushed, e.suppressed])).toEqual([["SOL", "new_extreme", true, undefined], ["ETH", "joint_extreme", false, undefined]]);
    expect(admit("2026-01-09", cs, out, 3, at)).toEqual([]);
  });

  test("3-day cooldown applies on either side of the bar", () => {
    const cs = [cand("SOL", hit("new_extreme", 1))];
    expect(admit("2026-01-09", cs, [entry("2026-01-07", "SOL")], 3, at)[0]).toMatchObject({ pushed: false, suppressed: "cooldown" });
    expect(admit("2026-01-09", cs, [entry("2026-01-11", "SOL")], 3, at)[0]).toMatchObject({ pushed: false, suppressed: "cooldown" });
    expect(admit("2026-01-09", cs, [entry("2026-01-06", "SOL")], 3, at)[0]!.pushed).toBe(true);
    expect(admit("2026-01-09", cs, [entry("2026-01-07", "SOL", { pushed: false })], 3, at)[0]!.pushed).toBe(true);
  });

  test("the run cap pushes the most extreme first and suppresses the rest", () => {
    const cs = [cand("A", hit("new_extreme", 1), 1), cand("B", hit("new_extreme", 2), 2), cand("C", hit("new_extreme", 1, 4), 3), cand("D", hit("new_extreme", 1), 0)];
    const out = admit("2026-01-09", cs, [], 3, at);
    expect(out.map((e) => e.coin)).toEqual(["B", "C", "D", "A"]);
    expect(out.map((e) => e.suppressed)).toEqual([undefined, undefined, undefined, "run_cap"]);
  });

  test("a late run gives the budget to the newest bar first; BTC is market-wide", () => {
    const out = admitRun([{ bar: "2026-01-07", cands: [cand("A", hit("new_extreme", 1))] }, { bar: "2026-01-09", cands: [cand("BTC", hit("new_extreme", 1))] }], [], 1, at);
    expect(out.map((e) => [e.barDate, e.pushed, e.suppressed, e.marketWide])).toEqual([["2026-01-07", false, "run_cap", false], ["2026-01-09", true, undefined, true]]);
  });
});

describe("pendingNovel() and novelText()", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  test("pushed entries no channel took are retried for 3 days, then dropped", () => {
    const log = [entry("2026-01-09", "A"), entry("2026-01-09", "B", { notified: [{ at, channels: ["telegram"] }] }), entry("2026-01-09", "C", { notified: [{ at, channels: [] }] }), entry("2026-01-05", "D"), entry("2026-01-09", "E", { pushed: false })];
    expect(pendingNovel(log, now).map((e) => e.coin)).toEqual(["A", "C"]);
  });
  test("alert text names the new extremes, states no advice", () => {
    const e = entry("2026-01-09", "BTC", { marketWide: true, features: [{ id: "funding_z90", value: 9, histMin: -3, histMax: 8, p1: -2, p99: 3, bars: 400, pctRank: 100 }, { id: "vol_x", value: 2, histMin: 0.1, histMax: 5, p1: 0.2, p99: 3, bars: 400, pctRank: 97 }] });
    const t = novelText(e);
    expect(t.title).toBe("NOVEL: BTC — funding_z90 — no setup covers this");
    expect(t.body).toBe("new extreme on bar 2026-01-09 · market-wide (BTC)\nfunding_z90 9 (history -3 to 8, pct rank 100)");
    expect(novelText({ ...e, nearSetups: ["squeeze"] }).title).toContain("near: squeeze");
  });
});

describe("replay()", () => {
  test("replays the last days oldest first with the live rules: the engineered bar is pushed, the per-day cap holds", () => {
    const r = replay({ SOL: daily(400, { f: { ...BIGS, 399: 0.05 } }), ETH: daily(400) }, 30);
    expect(Object.keys(r.perDay)).toHaveLength(30);
    expect(Math.max(...Object.values(r.perDay).map((d) => d.pushes))).toBeLessThanOrEqual(3);
    expect(r.entries.find((e) => e.coin === "SOL" && e.barDate === new Date(D0 + 399 * DAY).toISOString().slice(0, 10))).toMatchObject({ kind: "new_extreme", pushed: true });
  });
});
