import { describe, expect, test } from "bun:test";
import { ATR_WINDOW, FUNDING, HIGH, LOW, OPEN, replayCoin } from "../lab/engine/eventStudy.js";
import { gauss, mulberry32 } from "../lab/engine/rng.js";
import { isoDate } from "../lab/engine/util.js";
import type { LoadDatasetFn } from "../lab/service.js";
import { DAY_MS, type LabDataset } from "../lab/types.js";
import { DEFINITIONS, definitionRule } from "./definitions.js";
import { createDefinitionScanner, definitionMetrics, inZoneNow, metricLookbackDays, SCAN_LOOKBACK_DAYS, SCAN_RETRY_MS, scanDataset } from "./scan.js";

const T0 = Date.UTC(2024, 0, 1);

/**
 * A coin with every metric the definitions read, plus planted episodes so each definition is in zone somewhere:
 * 70-day trend blocks (regime), funding spikes with OI at a 30-day high, negative funding with OI building, two
 * 3-day washouts with OI flushing and funding negative, and volume bursts.
 */
function fixture(n = 420, seed = 11, asset = "FIX"): LabDataset {
  const rng = mulberry32(seed);
  const c: number[] = [];
  const f: number[] = [];
  const oi: number[] = [];
  const vol: number[] = [];
  let px = 100;
  let o = 1e8;
  const hot = new Set([150, 260, 380]);
  const cold = new Set([175, 300]);
  const washout = new Set([200, 201, 202, 330, 331, 332]);
  for (let i = 0; i < n; i++) {
    const drift = Math.floor(i / 70) % 2 ? -0.006 : 0.006;
    px *= 1 + (washout.has(i) ? -0.045 : drift + 0.015 * gauss(rng));
    o *= 1 + 0.01 * gauss(rng) + ([...hot].some((h) => i > h - 4 && i <= h) ? 0.05 : 0) + ([...cold].some((h) => i > h - 7 && i <= h) ? 0.03 : 0) + (washout.has(i) ? -0.06 : 0);
    c.push(px);
    oi.push(o);
    f.push(0.0001 + 0.00002 * gauss(rng) + (hot.has(i) ? 0.0008 : 0) + (cold.has(i) ? -0.0006 : 0) + (washout.has(i) ? -0.0003 : 0));
    vol.push(1e7 * Math.exp(0.3 * gauss(rng)) * (rng() < 0.15 ? 2.5 : 1));
  }
  const op = c.map((_, i) => c[Math.max(0, i - 1)]!);
  return {
    asset,
    t: c.map((_, i) => T0 + i * DAY_MS),
    price: c,
    metrics: {
      [OPEN]: op,
      [HIGH]: c.map((x, i) => Math.max(x, op[i]!) * 1.01),
      [LOW]: c.map((x, i) => Math.min(x, op[i]!) * 0.99),
      [FUNDING]: f,
      "ht:price": c,
      "okx:oi": oi,
      "ht:volume": vol,
    },
    stationary: { "ht:price": false, "okx:oi": false, "ht:volume": false },
  };
}

const cut = (d: LabDataset, k: number): LabDataset => ({
  ...d,
  t: d.t.slice(0, k + 1),
  price: d.price.slice(0, k + 1),
  metrics: Object.fromEntries(Object.entries(d.metrics).map(([id, v]) => [id, v.slice(0, k + 1)])),
});

describe("parity (CLAUDE.md: a second evaluation path needs a parity test): live scan vs the event study", () => {
  // Relation: the event study's entry days for a definition's rule are exactly the days k with
  // ATR_WINDOW ≤ k < n − horizon (ATR warm, the hold fits in the data) on which the live scan of the data
  // truncated at k (no look-ahead) says in zone, and the replay is flat (k ≥ the previous entry + horizon:
  // the cooldown). On this fixture every such day is scorable, so none is skipped.
  const d = fixture();
  const n = d.t.length;
  for (const def of DEFINITIONS) {
    test(def.id, () => {
      const H = def.rule.horizonDays;
      const expected: string[] = [];
      let next = 0;
      for (let k = ATR_WINDOW; k < n - H; k++) {
        if (k < next || !inZoneNow(def, cut(d, k))!.inZone) continue;
        expected.push(isoDate(d.t[k]!));
        next = k + H;
      }
      const got = replayCoin(definitionRule(def, d.asset), d, { stopAtr: 1.5, targetAtr: 3 }).map((e) => e.date).filter((x) => x < isoDate(d.t[n - H]!));
      expect(expected.length).toBeGreaterThan(0);
      expect(got).toEqual(expected);
    });
  }

  test("a definition whose metric the dataset lacks is not evaluable (null), not out of zone", () => {
    const noOi = { ...d, metrics: Object.fromEntries(Object.entries(d.metrics).filter(([k]) => k !== "okx:oi")) };
    expect(inZoneNow(DEFINITIONS.find((x) => x.id === "funding_fade")!, noOi)).toBeNull();
    expect(inZoneNow(DEFINITIONS.find((x) => x.id === "range_breakout")!, noOi)).not.toBeNull();
  });
});

describe("the live scan's window: the last SCAN_LOOKBACK_DAYS bars answer as the full history does", () => {
  // The scanner loads SCAN_LOOKBACK_DAYS of price and, of each condition metric, only metricLookbackDays (the most
  // its features read, plus a fill margin: funding is the slow fetch); the event study loads the whole series. The
  // parity test above cuts from bar 0, so it does not cover the window. Every definition, every last bar the window
  // fits, each metric empty before its own lookback: same answer.
  const d = fixture();
  const lookback = metricLookbackDays();
  test("each metric's lookback fits in the price window", () => {
    for (const days of Object.values(lookback)) expect(days).toBeLessThanOrEqual(SCAN_LOOKBACK_DAYS);
    expect(lookback["ht:funding"]).toBeLessThan(SCAN_LOOKBACK_DAYS); // z(90): about 100 days, not 200
  });
  const win = (k: number): LabDataset => {
    const lo = k + 1 - SCAN_LOOKBACK_DAYS;
    const own = (id: string, v: number[]) => v.slice(lo, k + 1).map((x, i) => (lookback[id] !== undefined && i < SCAN_LOOKBACK_DAYS - lookback[id]! ? NaN : x));
    return { ...d, t: d.t.slice(lo, k + 1), price: d.price.slice(lo, k + 1), metrics: Object.fromEntries(Object.entries(d.metrics).map(([id, v]) => [id, own(id, v)])) };
  };
  for (const def of DEFINITIONS) {
    test(def.id, () => {
      let inZone = 0;
      for (let k = SCAN_LOOKBACK_DAYS - 1; k < d.t.length; k++) {
        const full = inZoneNow(def, cut(d, k))!;
        expect(inZoneNow(def, win(k))).toEqual(full);
        if (full.inZone) inZone++;
      }
      expect(inZone).toBeGreaterThan(0);
    });
  }
});

describe("definition scanner (service)", () => {
  const NOW = Date.UTC(2026, 10, 10, 12);
  /** The fixture shifted so its last bar is yesterday (UTC) relative to `now`. */
  const current = (asset: string, now: number): LabDataset => {
    const d = fixture(420, 11, asset);
    const last = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
    return { ...d, t: d.t.map((_, i) => last - (d.t.length - 1 - i) * DAY_MS) };
  };
  /** A load result whose every metric has a raw value on the dataset's last bar (as the registry reports it). */
  const loaded = (dataset: LabDataset) => ({ dataset, warnings: [], lastRaw: Object.fromEntries(Object.keys(dataset.metrics).map((m) => [m, isoDate(dataset.t.at(-1)!)])) });

  test("once per closed bar, shared in flight; failed, stale and late coins dropped and counted; hits are scanDataset's", async () => {
    let now = NOW;
    const loads: string[] = [];
    const load: LoadDatasetFn = async (cfg) => {
      loads.push(cfg.asset);
      if (cfg.asset === "BAD") throw new Error("HL down");
      if (cfg.asset === "SLOW") return new Promise(() => {});
      if (cfg.asset === "OLD") return loaded(current("OLD", now - 3 * DAY_MS));
      return loaded(current(cfg.asset, now));
    };
    const scanner = createDefinitionScanner({ loadDataset: load, coins: async () => ["AAA", "BAD", "OLD", "SLOW", "aaa"], now: () => now, deadlineMs: 50 });
    const [a, b] = await Promise.all([scanner.scan(), scanner.scan()]);
    expect(a).toBe(b);
    expect(loads.sort()).toEqual(["AAA", "BAD", "OLD", "SLOW"]); // case-insensitive dedupe, one load each
    expect(a).toMatchObject({ bar: isoDate(Math.floor(NOW / DAY_MS) * DAY_MS - DAY_MS), coins: 1, dropped: 3 });
    expect(a.hits).toEqual(scanDataset(current("AAA", NOW)));
    now += SCAN_RETRY_MS - 60_000;
    expect(await scanner.scan()).toBe(a); // within the retry window: no reload
    expect(loads).toHaveLength(4);
    now += DAY_MS;
    await scanner.scan(); // the next closed bar
    expect(loads).toHaveLength(8);
  });

  test("a scan that dropped coins is kept 15 minutes, not the day; a complete one is kept until the day turns", async () => {
    // The first board load after 00:00 UTC runs before stored candles reach yesterday: every coin drops.
    let now = Date.UTC(2026, 10, 10, 0, 5);
    let synced = false;
    let loads = 0;
    const scanner = createDefinitionScanner({
      loadDataset: async (cfg) => (loads++, loaded(current(cfg.asset, synced ? now : now - DAY_MS))),
      coins: async () => ["AAA", "BBB"],
      now: () => now,
    });
    const early = await scanner.scan();
    expect(early).toMatchObject({ coins: 0, dropped: 2, hits: [] });
    synced = true;
    now += SCAN_RETRY_MS - 60_000;
    expect(await scanner.scan()).toBe(early);
    now += 60_000;
    const full = await scanner.scan();
    expect(full).toMatchObject({ coins: 2, dropped: 0 });
    expect(loads).toBe(4);
    now += 20 * 3_600_000; // same UTC day, hours later
    expect(await scanner.scan()).toBe(full);
    expect(loads).toBe(4);
  });

  test("a coin × definition is evaluated only when every metric it reads has a raw value on the bar", async () => {
    // Funding stopped two days ago: the registry forward-fills it onto the bar, lastRaw says where raw data ends.
    const d = current("AAA", NOW);
    const bar = isoDate(d.t.at(-1)!);
    const lastRaw = { ...loaded(d).lastRaw, "ht:funding": isoDate(d.t.at(-3)!) };
    const scan = await createDefinitionScanner({ loadDataset: async () => ({ dataset: d, warnings: [], lastRaw }), coins: async () => ["AAA"], now: () => NOW }).scan();
    const fundingDefs = DEFINITIONS.filter((x) => definitionMetrics([x]).includes("ht:funding"));
    expect(fundingDefs.length).toBeGreaterThan(0);
    expect(fundingDefs.length).toBeLessThan(DEFINITIONS.length);
    expect(scan).toMatchObject({ bar, coins: 1, dropped: fundingDefs.length });
    // A funding day that has not reached the bar (stopped, or still settling) is retried, with its last complete day.
    expect(scan.drops.every((x) => x.retry && x.reason === `ht:funding last complete day ${isoDate(d.t.at(-3)!)}, not ${bar}`)).toBe(true);
    expect(scan.hits).toEqual(scanDataset(d, DEFINITIONS.filter((x) => !fundingDefs.includes(x))));
    // A loader that reports no lastRaw evaluates nothing (fail closed).
    const blind = await createDefinitionScanner({ loadDataset: async () => ({ dataset: d, warnings: [] }), coins: async () => ["AAA"], now: () => NOW }).scan();
    expect(blind).toMatchObject({ coins: 1, dropped: DEFINITIONS.length, hits: [] });
  });

  test("each metric is loaded from its own lookback; the price over SCAN_LOOKBACK_DAYS ending on the bar", async () => {
    const cfgs: Parameters<LoadDatasetFn>[0][] = [];
    await createDefinitionScanner({ loadDataset: async (cfg) => (cfgs.push(cfg), loaded(current(cfg.asset, NOW))), coins: async () => ["AAA"], now: () => NOW }).scan();
    const bar = Math.floor(NOW / DAY_MS) * DAY_MS - DAY_MS;
    expect(cfgs[0]!.from).toBe(isoDate(bar - (SCAN_LOOKBACK_DAYS - 1) * DAY_MS));
    for (const [m, days] of Object.entries(metricLookbackDays())) expect(cfgs[0]!.metricFrom![m]).toBe(isoDate(bar - (days - 1) * DAY_MS));
  });

  test("a coin × definition reading a metric the coin has no data for is dropped for good; one still settling is retried", async () => {
    let now = NOW;
    let loads = 0;
    const scanner = createDefinitionScanner({
      loadDataset: async (cfg) => {
        loads++;
        const r = loaded(current(cfg.asset, now));
        const { "okx:oi": _, ...lastRaw } = r.lastRaw;
        return { ...r, lastRaw, noData: ["okx:oi"] }; // not listed on OKX
      },
      coins: async () => ["AAA"],
      now: () => now,
    });
    const okxDefs = DEFINITIONS.filter((x) => definitionMetrics([x]).includes("okx:oi"));
    const a = await scanner.scan();
    expect(a.drops).toEqual(okxDefs.map((x) => ({ coin: "AAA", definition: x.id, reason: "no okx:oi data for the coin", retry: false })));
    now += SCAN_RETRY_MS + 60_000;
    expect(await scanner.scan()).toBe(a); // nothing a retry could change: kept for the day
    expect(loads).toBe(1);
  });

  test("latest(): null until the first scan finishes, then the last finished scan while a newer one runs", async () => {
    let now = NOW;
    let release: () => void = () => {};
    let gate = Promise.resolve();
    const scanner = createDefinitionScanner({
      loadDataset: async (cfg) => (await gate, loaded(current(cfg.asset, now))),
      coins: async () => ["AAA"],
      now: () => now,
      deadlineMs: Infinity,
    });
    gate = new Promise((r) => (release = r));
    const first = scanner.scan();
    expect(scanner.latest()).toBeNull();
    release();
    const a = await first;
    expect(scanner.latest()).toBe(a);
    now += DAY_MS;
    gate = new Promise((r) => (release = r));
    const second = scanner.scan();
    expect(scanner.latest()).toBe(a); // yesterday's scan keeps serving while today's runs
    release();
    const b = await second;
    expect(b.bar > a.bar).toBe(true);
    expect(scanner.latest()).toBe(b);
  });

  test("a scan with no coin list fails as a whole and is retried on the next call", async () => {
    let fail = true;
    const scanner = createDefinitionScanner({
      loadDataset: async (cfg) => loaded(current(cfg.asset, NOW)),
      coins: async () => {
        if (fail) throw new Error("meta down");
        return ["AAA"];
      },
      now: () => NOW,
    });
    await expect(scanner.scan()).rejects.toThrow("meta down");
    fail = false;
    expect((await scanner.scan()).coins).toBe(1);
  });
});
