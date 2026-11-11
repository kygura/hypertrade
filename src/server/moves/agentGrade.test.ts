import { describe, expect, test } from "bun:test";
import type { AgentRecord } from "../../shared/agentRecords.js";
import { AgentStatsResponseSchema } from "../../shared/agentRecords.js";
import { iso, record, T0 } from "./agent.fixture.js";
import { agentStats, coversWindow, gradeRecord, relPct, type Bar } from "./agentGrade.js";

const H = 3_600_000;
// Created mid-hour: the 12:00 bar is not fully after creation, so it can never falsify.
const created = T0 + 30 * 60_000;
const bar = (t: number, l: number, h: number, c = (l + h) / 2): Bar => ({ t, l, h, c });
const flat = (from: number, n: number, px: number) => Array.from({ length: n }, (_, i) => bar(from + i * H, px * 0.99, px * 1.01, px));
const rec = (over: Partial<AgentRecord> = {}) => record({ createdAt: iso(created), ...over });
const due = created + 24 * H;

describe("relPct", () => {
  test("log-% vs BTC, signed by direction", () => {
    const r = rec();
    expect(relPct(r, 110, 60000)).toBeCloseTo(100 * Math.log(1.1), 10);
    expect(relPct(r, 110, 66000)).toBeCloseTo(0, 10); // moved with BTC: no edge
    expect(relPct({ ...r, direction: "short" }, 90, 60000)).toBeCloseTo(-100 * Math.log(0.9), 10);
  });
});

describe("gradeRecord", () => {
  const bars = flat(T0 + H, 24, 100);
  const btc = flat(T0 + H, 24, 60000);

  test("at the horizon: graded at the horizon price vs BTC, hit = beat BTC in the called direction", () => {
    expect(gradeRecord(rec(), { now: due - 1, bars, btcBars: btc, horizonPx: 110, horizonBtcPx: 60000 })).toBeNull();
    const p = gradeRecord(rec(), { now: due, bars, btcBars: btc, horizonPx: 104, horizonBtcPx: 61200 });
    expect(p).toEqual({ status: "graded", grade: { atHours: 24, px: 104, btcPx: 61200, relPct: 100 * (Math.log(1.04) - Math.log(1.02)), hit: true, falsifiedAt: null } });
    const short = gradeRecord(rec({ direction: "short", falsifier: { level: 105, side: "above", text: "" } }), { now: due, bars, btcBars: btc, horizonPx: 104, horizonBtcPx: 61200 });
    expect(short!.grade).toMatchObject({ hit: false });
    expect(short!.grade!.relPct).toBeCloseTo(-100 * (Math.log(1.04) - Math.log(1.02)), 10);
  });

  test("falsified early by an hourly low (long) or high (short) crossing the level", () => {
    const hitBar = T0 + 5 * H;
    const dipped = bars.map((b) => (b.t === hitBar ? bar(b.t, 94.5, 100, 96) : b));
    const p = gradeRecord(rec(), { now: hitBar + H, bars: dipped, btcBars: btc, horizonPx: null, horizonBtcPx: null });
    expect(p).toEqual({ status: "falsified", grade: { atHours: 4.5, px: 95, btcPx: 60000, relPct: 100 * Math.log(0.95), hit: false, falsifiedAt: iso(hitBar) } });
    // The bar is not closed yet: no verdict.
    expect(gradeRecord(rec(), { now: hitBar + H - 1, bars: dipped, btcBars: btc, horizonPx: null, horizonBtcPx: null })).toBeNull();
    const spiked = bars.map((b) => (b.t === hitBar ? bar(b.t, 100, 105.5) : b));
    const s = gradeRecord(rec({ direction: "short", falsifier: { level: 105, side: "above", text: "" } }), { now: due, bars: spiked, btcBars: btc, horizonPx: 90, horizonBtcPx: 60000 });
    expect(s).toMatchObject({ status: "falsified", grade: { hit: false, px: 105, falsifiedAt: iso(hitBar) } });
    // A falsified record beat BTC (relPct > 0) and is still a miss.
    const beat = gradeRecord(rec(), { now: hitBar + H, bars: dipped, btcBars: flat(T0 + H, 24, 50000), horizonPx: null, horizonBtcPx: null });
    expect(beat!.grade!.relPct).toBeGreaterThan(0);
    expect(beat!.grade!.hit).toBe(false);
  });

  test("bars before creation or at/after the horizon never falsify; missing bars hold the horizon grade", () => {
    const early = [bar(T0, 90, 100), ...bars];
    expect(gradeRecord(rec(), { now: due, bars: early, btcBars: btc, horizonPx: 101, horizonBtcPx: 60000 })!.status).toBe("graded");
    const late = [...bars, bar(due + H, 90, 100)];
    expect(gradeRecord(rec(), { now: due + 2 * H, bars: late, btcBars: btc, horizonPx: 101, horizonBtcPx: 60000 })!.status).toBe("graded");
    const gap = bars.filter((b) => b.t !== T0 + 7 * H);
    expect(gradeRecord(rec(), { now: due, bars: gap, btcBars: btc, horizonPx: 101, horizonBtcPx: 60000 })).toBeNull();
    expect(coversWindow(gap, created, due)).toBe(false);
    expect(coversWindow(bars, created, due)).toBe(true);
    expect(gradeRecord(rec(), { now: due, bars, btcBars: btc, horizonPx: null, horizonBtcPx: 60000 })).toBeNull();
  });

  test("direction-null and no_cause records are never graded", () => {
    expect(gradeRecord(rec({ direction: null, falsifier: null }), { now: due - 1, bars, btcBars: btc, horizonPx: 1, horizonBtcPx: 1 })).toBeNull();
    expect(gradeRecord(rec({ direction: null, falsifier: null }), { now: due, bars, btcBars: btc, horizonPx: 1, horizonBtcPx: 1 })).toEqual({ status: "graded", grade: null });
    expect(gradeRecord(rec({ status: "no_cause", direction: null }), { now: due, bars, btcBars: btc, horizonPx: 1, horizonBtcPx: 1 })).toBeNull();
    expect(gradeRecord(rec({ status: "falsified" }), { now: due, bars, btcBars: btc, horizonPx: 1, horizonBtcPx: 1 })).toBeNull();
  });
});

describe("agentStats", () => {
  const graded = (i: number, rel: number, over: Partial<AgentRecord> = {}) =>
    rec({ id: `g${i}`, createdAt: iso(T0 + i * 86_400_000), status: "graded", grade: { atHours: 24, px: 100, btcPx: 60000, relPct: rel, hit: rel > 0, falsifiedAt: null }, ...over });

  test("counts every record; numbers only from graded ones, null under 5 clusters", () => {
    const four = [1, -2, 3, 4].map((x, i) => graded(i, x));
    const s4 = agentStats([...four, rec({ id: "nc", status: "no_cause", direction: null }), rec({ id: "dn", status: "graded", direction: null, grade: null })]);
    expect(AgentStatsResponseSchema.parse(s4)).toEqual(s4);
    expect(s4).toMatchObject({ total: 6, graded: 4, noCause: 1 });
    expect(s4.byHorizon).toEqual([{ key: "24h", n: 4, clusters: 4, meanRelPct: null, ci95: null, hitRate: null }]);

    const falsified = graded(5, 0.5, { status: "falsified", grade: { atHours: 3, px: 95, btcPx: 50000, relPct: 0.5, hit: false, falsifiedAt: iso(T0) } });
    const s = agentStats([...four, falsified, graded(6, 1, { horizonHours: 4, layer: "narrative" })]);
    const h24 = s.byHorizon.find((r) => r.key === "24h")!;
    expect(h24).toMatchObject({ n: 5, clusters: 5, hitRate: 3 / 5 }); // the falsified one beat BTC and is still a miss
    expect(h24.meanRelPct).toBeCloseTo((1 - 2 + 3 + 4 + 0.5) / 5, 10);
    expect(h24.ci95![0]).toBeLessThan(h24.meanRelPct!);
    expect(s.byHorizon.map((r) => r.key)).toEqual(["4h", "24h"]);
    expect(s.byLayer.map((r) => [r.key, r.n])).toEqual([["forced_flow", 5], ["narrative", 1]]);
  });
});
