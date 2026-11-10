import { describe, expect, test } from "bun:test";
import { ATR_WINDOW, FUNDING, HIGH, LOW, OPEN, replayCoin } from "../lab/engine/eventStudy.js";
import { gauss, mulberry32 } from "../lab/engine/rng.js";
import { isoDate } from "../lab/engine/util.js";
import type { LoadDatasetFn } from "../lab/service.js";
import { DAY_MS, type LabDataset } from "../lab/types.js";
import { DEFINITIONS, definitionRule } from "./definitions.js";
import { createDefinitionScanner, inZoneNow, scanDataset } from "./scan.js";

const T0 = Date.UTC(2024, 0, 1);

/**
 * A coin with every metric the definitions read, plus planted episodes so each definition is in zone somewhere:
 * 70-day trend blocks (regime), funding spikes with OI at a 30-day high, negative funding with OI building, two
 * 3-day washouts with OI flushing, and volume bursts.
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
    f.push(0.0001 + 0.00002 * gauss(rng) + (hot.has(i) ? 0.0008 : 0) + (cold.has(i) ? -0.0006 : 0));
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
      "ht:oi": oi,
      "ht:volume": vol,
    },
    stationary: { "ht:price": false, "ht:oi": false, "ht:volume": false },
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
    const noOi = { ...d, metrics: Object.fromEntries(Object.entries(d.metrics).filter(([k]) => k !== "ht:oi")) };
    expect(inZoneNow(DEFINITIONS.find((x) => x.id === "funding_fade")!, noOi)).toBeNull();
    expect(inZoneNow(DEFINITIONS.find((x) => x.id === "range_breakout")!, noOi)).not.toBeNull();
  });
});

describe("definition scanner (service)", () => {
  const NOW = Date.UTC(2026, 10, 10, 12);
  /** The fixture shifted so its last bar is yesterday (UTC) relative to `now`. */
  const current = (asset: string, now: number): LabDataset => {
    const d = fixture(420, 11, asset);
    const last = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
    return { ...d, t: d.t.map((_, i) => last - (d.t.length - 1 - i) * DAY_MS) };
  };

  test("once per closed bar, shared in flight; failed, stale and late coins dropped and counted; hits are scanDataset's", async () => {
    let now = NOW;
    const loads: string[] = [];
    const load: LoadDatasetFn = async (cfg) => {
      loads.push(cfg.asset);
      if (cfg.asset === "BAD") throw new Error("HL down");
      if (cfg.asset === "SLOW") return new Promise(() => {});
      if (cfg.asset === "OLD") return { dataset: current("OLD", now - 3 * DAY_MS), warnings: [] };
      return { dataset: current(cfg.asset, now), warnings: [] };
    };
    const scanner = createDefinitionScanner({ loadDataset: load, coins: async () => ["AAA", "BAD", "OLD", "SLOW", "aaa"], now: () => now, deadlineMs: 50 });
    const [a, b] = await Promise.all([scanner.scan(), scanner.scan()]);
    expect(a).toBe(b);
    expect(loads.sort()).toEqual(["AAA", "BAD", "OLD", "SLOW"]); // case-insensitive dedupe, one load each
    expect(a).toMatchObject({ bar: isoDate(Math.floor(NOW / DAY_MS) * DAY_MS - DAY_MS), coins: 1, dropped: 3 });
    expect(a.hits).toEqual(scanDataset(current("AAA", NOW)));
    now += 3_600_000;
    expect(await scanner.scan()).toBe(a); // same UTC day: no reload
    expect(loads).toHaveLength(4);
    now += DAY_MS;
    await scanner.scan(); // the next closed bar
    expect(loads).toHaveLength(8);
  });

  test("a scan with no coin list fails as a whole and is retried on the next call", async () => {
    let fail = true;
    const scanner = createDefinitionScanner({
      loadDataset: async (cfg) => ({ dataset: current(cfg.asset, NOW), warnings: [] }),
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
