import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Bus } from "./bus.js";
import type { RingPoint } from "./features.js";
import { evaluability, gradeEntry, replayEntries, setupRefs, summarise, type ReplayEntry } from "./replay.js";
import { fixtureTicks, STEP, STEPS, T0, type Tick } from "./replay.fixture.js";
import { createScanner, type Info } from "./scanner.js";
import { SETUPS } from "./setups.js";
import { MemoryPlatformStore } from "./store-memory.js";

const MIN = 60_000;
const grid = Array.from({ length: STEPS }, (_, i) => T0 + i * STEP);
const ticks = fixtureTicks();

/** The ring point the scanner builds from a tick's ctx: oiUsd = openInterest × markPx. */
const point = (t: Tick): RingPoint => ({ ts: t.ts, mark: t.mark, oiUsd: t.openInterest * t.mark, funding: t.funding, dayNtlVlm: t.dayNtlVlm });
function streamsOf(ts: Tick[], map = point): Map<string, RingPoint[]> {
  const m = new Map<string, RingPoint[]>();
  for (const t of ts) (m.get(t.coin) ?? m.set(t.coin, []).get(t.coin)!).push(map(t));
  return m;
}
const key = (e: { coin: string; kind: string; direction: string; ts: number; entryPx: number }) => `${e.ts}|${e.coin}|${e.kind}|${e.direction}|${e.entryPx}`;

afterEach(() => setSystemTime());

/**
 * The live scanner fed the fixture tick by tick through its real tick(): HL's metaAndAssetCtxs and l2Book from the
 * fixture, a memory store, the clock set to each tick (the memory store stamps createdAt and statusChangedAt from
 * the wall clock). Neutral gates: every candidate is costed (costTopN above the candidate count, a deep book), so
 * each idea goes ready on creation and expires at the TTL, the lifecycle the replay models; no operator decides.
 */
async function liveOpportunities(cooldownMin: number, readyTtlMin: number) {
  const store = new MemoryPlatformStore();
  const coins = [...new Set(ticks.map((t) => t.coin))];
  let step = 0;
  const at = (coin: string) => ticks.find((t) => t.coin === coin && t.ts === grid[step])!;
  const info = (async (body: { type: string; coin?: string }) => {
    if (body.type === "l2Book") {
      const m = at(body.coin!).mark;
      const side = (d: number) => Array.from({ length: 20 }, (_, i) => ({ px: String(m * (1 + d * 0.0002 * (i + 1))), sz: String(1e6 / m), n: 1 }));
      return { levels: [side(-1), side(1)] };
    }
    return [
      { universe: coins.map((name) => ({ name, szDecimals: 3, maxLeverage: 20 })) },
      coins.map((c) => {
        const t = at(c);
        return { funding: String(t.funding), openInterest: String(t.openInterest), prevDayPx: String(t.mark), dayNtlVlm: String(t.dayNtlVlm), premium: "0", oraclePx: String(t.mark), markPx: String(t.mark), midPx: String(t.mark), impactPxs: null, dayBaseVlm: "1" };
      }),
    ];
  }) as Info;
  const sc = createScanner({ store, info, now: () => Date.now(), bus: new Bus(), costTopN: 1000, cooldownMin, readyTtlMin, filter: undefined });
  for (step = 0; step < grid.length; step++) {
    setSystemTime(new Date(grid[step]!));
    await sc.tick();
  }
  return (await store.listOpportunities({ limit: 10_000 })).map((o) => ({ coin: o.coin, kind: o.setupKind, direction: o.direction, ts: Date.parse(o.createdAt), entryPx: o.entryPx! }));
}

describe("replay parity with the live scanner", () => {
  for (const [cooldownMin, readyTtlMin] of [[240, 60], [0, 60]] as const) {
    test(`same coin, kind, side, time and entry as tick() (cooldown ${cooldownMin} min, TTL ${readyTtlMin} min)`, async () => {
      const live = await liveOpportunities(cooldownMin, readyTtlMin);
      const replay = replayEntries({ streams: streamsOf(ticks), grid, cooldownMs: cooldownMin * MIN, readyTtlMs: readyTtlMin * MIN });
      expect(replay.map(key).sort()).toEqual(live.map(key).sort());
      // The fixture fires three kinds, and the cooldown run differs from the no-cooldown run.
      expect(new Set(replay.map((e) => e.kind)).size).toBeGreaterThanOrEqual(3);
      expect(replay.length).toBe(cooldownMin ? 4 : 6);
    }, 60_000);
  }
});

describe("replayEntries", () => {
  const all = replayEntries({ streams: streamsOf(ticks), grid, cooldownMs: 240 * MIN, readyTtlMs: 60 * MIN });

  test("no look-ahead: the stream cut after a step gives the same entries up to that step", () => {
    for (const k of [151, 201, 231]) {
      const cut = ticks.filter((t) => t.ts <= grid[k]!);
      const part = replayEntries({ streams: streamsOf(cut), grid: grid.slice(0, k + 1), cooldownMs: 240 * MIN, readyTtlMs: 60 * MIN });
      expect(part).toEqual(all.filter((e) => e.ts <= grid[k]!));
    }
  });

  test("without OI the three OI setups never fire; vol_expansion_breakout still does", () => {
    const noOi = replayEntries({ streams: streamsOf(ticks, (t) => ({ ...point(t), oiUsd: NaN })), grid, cooldownMs: 240 * MIN, readyTtlMs: 60 * MIN });
    expect([...new Set(noOi.map((e) => e.kind))]).toEqual(["vol_expansion_breakout"]);
  });

  test("tier context: coins outside the stream rank in the tiers", () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ coin: `BIG${i}`, dayNtlVlm: 1e12 }));
    const es = replayEntries({ streams: streamsOf(ticks), grid, cooldownMs: 240 * MIN, readyTtlMs: 60 * MIN, tierContext: big });
    expect(es.every((e) => e.tier === 3)).toBe(true);
  });
});

describe("evaluability", () => {
  test("setups reading oiChg1hZ are not evaluable without OI; the breakout is", () => {
    const by = Object.fromEntries(SETUPS.map((s) => [s.kind, evaluability(s, ["oi", "book", "liquidations"])]));
    expect(by.vol_expansion_breakout).toEqual({ evaluable: true });
    for (const k of ["crowded_long", "negative_funding_squeeze", "deleveraging_washout"]) {
      expect(by[k]!.evaluable).toBe(false);
      expect(by[k]).toMatchObject({ reason: expect.stringContaining("oiChg1hZ") });
    }
    expect(SETUPS.every((s) => evaluability(s, []).evaluable)).toBe(true);
  });
  test("setupRefs includes the direction's feature", () => {
    expect(setupRefs(SETUPS.find((s) => s.kind === "vol_expansion_breakout")!)).toContain("ret15mZ");
  });
});

describe("grading", () => {
  const stream: RingPoint[] = [0, 1, 2, 4].map((h) => ({ ts: T0 + h * 3_600_000, mark: 100 + h, oiUsd: NaN, funding: 1e-5, dayNtlVlm: 1 }));
  const e: ReplayEntry = { coin: "A", kind: "k", direction: "short", ts: T0, entryPx: 100, tier: 1, regime: "range", fundingHourly: 1e-5 };

  test("net = side × move − 2 fees − funding at entry over the horizon (short receives positive funding)", () => {
    const r = gradeEntry(e, stream, "4h", 4.5)!;
    expect(r.grossReturn).toBeCloseTo(-0.04, 12);
    expect(r.netReturn).toBeCloseTo(-0.04 - (9 - 1e-5 * 4 * 1e4) / 1e4, 12);
    expect(gradeEntry(e, stream, "3h", 4.5)).toBeNull(); // no point at exactly ts + 3 h
    expect(gradeEntry(e, stream, "24h", 4.5)).toBeNull(); // past the stream
  });

  test("summarise: groupStats per kind × side × horizon; not-evaluable rows say why; empty rows are n 0 with nulls", () => {
    const entries = Array.from({ length: 6 }, (_, d): ReplayEntry => ({ ...e, kind: "vol_expansion_breakout", direction: "long", ts: T0 + d * 86_400_000 }));
    const streams = new Map([["A", entries.flatMap((x) => [{ ts: x.ts, mark: 100, oiUsd: NaN, funding: 0, dayNtlVlm: 1 }, { ts: x.ts + 3_600_000, mark: 101, oiUsd: NaN, funding: 0, dayNtlVlm: 1 }])]]);
    const rows = summarise({ entries: entries.map((x) => ({ ...x, fundingHourly: 0 })), streams, horizons: ["1h", "2h"], missing: ["oi"], feeBps: 4.5 });
    const up = rows.find((r) => r.kind === "vol_expansion_breakout" && r.side === "long" && r.horizon === "1h")!;
    expect(up).toMatchObject({ evaluable: true, entries: 6, n: 6, clusters: 6, hitRate: 1 });
    expect(up.meanNet).toBeCloseTo(0.01 - 9 / 1e4, 12);
    expect(up.ci95).not.toBeNull();
    expect(rows.find((r) => r.kind === "vol_expansion_breakout" && r.side === "long" && r.horizon === "2h")).toMatchObject({ entries: 6, n: 0, meanNet: null, ci95: null, hitRate: null });
    expect(rows.find((r) => r.kind === "vol_expansion_breakout" && r.side === "short")).toMatchObject({ entries: 0, n: 0, meanNet: null });
    const crowded = rows.find((r) => r.kind === "crowded_long")!;
    expect(crowded).toMatchObject({ side: "short", evaluable: false, n: 0 });
    expect(crowded.reason).toContain("oiChg1hZ");
    expect(rows).toHaveLength((1 + 1 + 1 + 2) * 2);
  });
});
