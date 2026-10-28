import { describe, expect, test } from "bun:test";
import type { Alert, DiffItem, SnapshotRow } from "../../shared/intel.js";
import { atr as atr14 } from "../desk/tools.js";
import { alertSource, buildDiffItems, changedSinceBaseline, confluence, confluenceK, delta, exposureWeight, materiality, rankDiffs, stopDistance, stopProximity, WATCH_FLOOR, type ActiveSources, type AssetDiffInput, type SignalSource } from "./diff.js";

const H = 3_600_000;
const T = Date.UTC(2026, 9, 13, 12);
const iso = (t: number) => new Date(t).toISOString();

function row(asset: string, t: number, over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    asset, ts: iso(t), price: 100, vol24h: null, funding: null, oiUsd: null, premium: null, basis: null,
    depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null, ...over,
  };
}

/** 25 hourly snapshots ending 1h before T: price log steps ±1% (σ_1h = 0.01); 24 funding values alternating 3e-5 / 1e-5 (mean 2e-5, σ 1e-5). */
function history(asset: string): SnapshotRow[] {
  let p = 100;
  return Array.from({ length: 25 }, (_, i) => {
    const r = row(asset, T - (25 - i) * H, { price: p, funding: i === 0 ? null : i % 2 ? 3e-5 : 1e-5 });
    p *= Math.exp(i % 2 === 0 ? 0.01 : -0.01);
    return r;
  });
}

const flat = (n: number) => Array.from({ length: n }, () => ({ h: 101, l: 99, c: 100 })); // TR 2 each

describe("atr14", () => {
  test("mean of the last 14 true ranges; needs 15 bars", () => {
    expect(atr14(flat(14))).toBeNull();
    expect(atr14(flat(15))).toBe(2);
    // A gap bar: TR = max(110−105, |110−100|, |105−100|) = 10.
    expect(atr14([...flat(15), { h: 110, l: 105, c: 108 }])).toBeCloseTo((13 * 2 + 10) / 14, 12);
  });
});

describe("stops", () => {
  test("distance to the nearest stop on the losing side; a crossed stop is 0", () => {
    expect(stopDistance(100, [{ side: "long", stopPx: 95, notionalUsd: 1 }])).toBe(5);
    expect(stopDistance(100, [{ side: "long", stopPx: 95, notionalUsd: 1 }, { side: "short", stopPx: 104, notionalUsd: 1 }])).toBe(4);
    expect(stopDistance(100, [{ side: "long", stopPx: 101, notionalUsd: 1 }])).toBe(0);
    expect(stopDistance(100, [{ side: "long", stopPx: null, notionalUsd: 1 }])).toBeNull();
  });
  test("stop_proximity = 1 + 2·max(0, 1 − dist/(2·ATR))", () => {
    expect(stopProximity(1, 2)).toBe(2.5);
    expect(stopProximity(0, 2)).toBe(3);
    expect(stopProximity(4, 2)).toBe(1);
    expect(stopProximity(null, 2)).toBe(1);
    expect(stopProximity(1, null)).toBe(1);
  });
  test("exposure weight: notional share; watchlist-only floor", () => {
    expect(exposureWeight([], 10_000)).toBe(WATCH_FLOOR);
    expect(exposureWeight([{ side: "long", stopPx: null, notionalUsd: 1500 }, { side: "short", stopPx: null, notionalUsd: -500 }], 8000)).toBe(0.25);
  });
  test("delta units", () => {
    expect(delta("price", 100, 104)).toEqual({ delta: 4, deltaUnit: "pct" });
    expect(delta("funding", 1e-5, 3e-5).deltaUnit).toBe("bps");
    expect(delta("funding", 1e-5, 3e-5).delta).toBeCloseTo(0.2, 12);
    expect(delta("spread_bps", 2, 5)).toEqual({ delta: 3, deltaUnit: "bps" });
  });
});

describe("buildDiffItems", () => {
  // SOL is held long with a stop 1 below the mark; ATR 2 → proximity 2.5.
  const hist = history("SOL");
  const baseline = hist.at(-4)!; // T−4h
  const to = baseline.price * Math.exp(0.04);
  const sol: AssetDiffInput = {
    asset: "SOL",
    current: row("SOL", T, { price: to, funding: 4e-5 }),
    baseline: { ...baseline, ts: iso(T - 4 * H) },
    history: hist,
    candles1h: flat(20),
    positions: [{ side: "long", stopPx: to - 1, notionalUsd: 2000 }],
  };
  const eth: AssetDiffInput = { asset: "ETH", current: row("ETH", T, { price: 100 }), baseline: row("ETH", T - 4 * H), history: history("ETH"), positions: [] };

  test("hand-computed z, weight, proximity and materiality", () => {
    const { items, diffed } = buildDiffItems([sol, eth], 8000);
    expect(diffed).toBe(3); // SOL price + funding, ETH price (ETH has no funding in its baseline → skipped)
    const price = items.find((i) => i.asset === "SOL" && i.metric === "price")!;
    expect(price.z).toBeCloseTo(0.04 / (0.01 * 2), 9);
    expect(price).toMatchObject({ held: true, exposureWeight: 0.25, stopProximity: 2.5, deltaUnit: "pct", ts: iso(T), baselineTs: iso(T - 4 * H) });
    expect(price.materiality).toBeCloseTo(2 * 0.25 * 2.5, 9);
    expect(price.stopDistPct).toBeCloseTo((1 / to) * 100, 9);
    expect(price.stopDistAtr).toBeCloseTo(0.5, 9);
    // Funding: level z = (4e-5 − 2e-5) / 1e-5 = 2, regardless of the baseline.
    const funding = items.find((i) => i.asset === "SOL" && i.metric === "funding")!;
    expect(funding.z).toBeCloseTo(2, 9);
    const ethPrice = items.find((i) => i.asset === "ETH" && i.metric === "price")!;
    expect(ethPrice).toMatchObject({ held: false, exposureWeight: WATCH_FLOOR, stopProximity: 1 });
    expect(ethPrice.stopDistPct).toBeUndefined();
  });

  test("metrics with too little history are skipped, not zero", () => {
    const young = { ...sol, history: hist.slice(-10), candles1h: undefined };
    expect(buildDiffItems([young], 8000)).toEqual({ items: [], diffed: 0 });
  });
});

describe("held floor", () => {
  test("a held position never weighs less than a watch-only asset, and a small one still reaches the digest", () => {
    expect(exposureWeight([{ side: "long", stopPx: null, notionalUsd: 300 }], 10_000)).toBe(WATCH_FLOOR);
    const hist = history("SOL");
    const baseline = hist.at(-4)!;
    const sol: AssetDiffInput = {
      asset: "SOL",
      current: row("SOL", T, { price: baseline.price * Math.exp(0.05) }), // z 2.5
      baseline: { ...baseline, ts: iso(T - 4 * H) },
      history: hist,
      positions: [{ side: "long", stopPx: null, notionalUsd: 300 }], // 3 % of the book
    };
    const ranked = rankDiffs(buildDiffItems([sol], 10_000).items, { minZ: 2, topK: 5, digestMateriality: 0.1 });
    expect(ranked.map((i) => i.metric)).toEqual(["price"]);
    expect(ranked[0]!.materiality).toBeCloseTo(2.5 * WATCH_FLOOR, 9);
  });
});

describe("confluence", () => {
  test("1 for a lone signal, +0.25 per further source, capped at 1.5", () => {
    expect([1, 2, 3, 4, 9].map(confluence)).toEqual([1, 1.25, 1.5, 1.5, 1.5]);
    expect(confluence(0)).toBe(1);
  });

  test("materiality(parts, k) = surprise × exposure × proximity × confluence(k)", () => {
    const parts = { surprise: 2, exposure: 0.25, proximity: 2.5 };
    expect(materiality(parts)).toBeCloseTo(1.25, 9);
    expect(materiality(parts, 3)).toBeCloseTo(1.25 * 1.5, 9);
  });

  test("k counts the item itself plus the distinct other sources; its own source never boosts it", () => {
    expect(confluenceK(undefined, "flow")).toBe(1);
    expect(confluenceK(new Set<SignalSource>(["flow"]), "flow")).toBe(1);
    expect(confluenceK(new Set<SignalSource>(["flow", "regime"]), "flow")).toBe(2);
    expect(confluenceK(new Set<SignalSource>(["snapshot", "flow", "regime", "news"]), "news")).toBe(4);
  });

  test("alerts map to source classes: detectors, flips/crossings, news; terminal and narrative none", () => {
    const src = (kind: Alert["kind"], eventType: string | null) => alertSource({ kind, eventType });
    expect([src("flow", "crowded_long"), src("flow", "funding_flip"), src("flow", "oi_up_price_down"), src("flow", "funding>0.0001")]).toEqual(["flow", "regime", "regime", "regime"]);
    expect([src("mapper", "exploit"), src("catalyst", "unlock"), src("docwatch", null), src("terminal", null)]).toEqual(["news", "news", "news", null]);
    expect(src("narrative", "stage_crowded")).toBeNull();
  });

  test("buildDiffItems: other sources on the asset lift materiality and expose the factor; the snapshot source itself does not", () => {
    const hist = history("SOL");
    const baseline = hist.at(-4)!;
    const to = baseline.price * Math.exp(0.04);
    const sol: AssetDiffInput = { asset: "SOL", current: row("SOL", T, { price: to }), baseline: { ...baseline, ts: iso(T - 4 * H) }, history: hist, positions: [{ side: "long", stopPx: null, notionalUsd: 2000 }] };
    const price = (active?: ActiveSources) => buildDiffItems([sol], 2000, active).items.find((i) => i.metric === "price")!;
    const lone = price();
    expect(lone.confluence).toBe(1);
    expect(price(new Map([["SOL", new Set<SignalSource>(["snapshot"])]])).confluence).toBe(1);
    const two = price(new Map([["SOL", new Set<SignalSource>(["flow", "news"])]]));
    expect(two.confluence).toBe(1.5);
    expect(two.materiality).toBeCloseTo(lone.materiality * 1.5, 9);
  });
});

describe("rankDiffs", () => {
  const item = (asset: string, z: number, materiality: number) => ({ asset, metric: "price", z, materiality }) as DiffItem;
  test("digest threshold hides items below it", () => {
    const items = [item("A", 3, 0.05), item("B", 3, 0.1), item("C", 3, 0.5)];
    expect(rankDiffs(items, { minZ: 2, topK: 5, digestMateriality: 0.1 }).map((i) => i.asset)).toEqual(["C", "B"]);
    expect(rankDiffs(items, { minZ: 2, topK: 5 })).toHaveLength(3);
  });
  test("|z| ≥ minZ, by materiality, top k", () => {
    const ranked = rankDiffs([item("A", 2.5, 0.1), item("B", -3, 0.9), item("C", 1.9, 5), item("D", 2, 0.5)], { minZ: 2, topK: 2 });
    expect(ranked.map((i) => i.asset)).toEqual(["B", "D"]);
    expect(rankDiffs([item("C", 1.9, 5)], { minZ: 2, topK: 5 })).toEqual([]);
  });
});

describe("level/ratio gate (changed since the baseline)", () => {
  // Funding history: mean 2e-5, σ 1e-5, so z = (f − 2e-5) / 1e-5.
  const flagged = (from: number, to: number) => {
    const input: AssetDiffInput = {
      asset: "BTC",
      current: row("BTC", T, { funding: to }),
      baseline: row("BTC", T - 4 * H, { funding: from }),
      history: history("BTC"),
      positions: [],
    };
    const { items } = buildDiffItems([input], 0);
    return rankDiffs(items, { minZ: 2, topK: 5 }).filter((i) => i.metric === "funding");
  };

  test("a persistent unusual level with Δ ≈ 0 is not flagged", () => {
    expect(flagged(4.8e-5, 4.8e-5)).toEqual([]); // z +2.8 at both ends
    expect(flagged(4.8e-5, 4.5e-5)).toEqual([]); // still unusual, z moved 0.3
  });
  test("crossing the threshold since the baseline is flagged", () => {
    const [f] = flagged(3e-5, 4.5e-5); // z 1 → 2.5
    expect(f!.z).toBeCloseTo(2.5, 9);
    expect("zBase" in f!).toBe(false); // internal, not on the DiffItem contract
  });
  test("already unusual but z moved ≥ 1 is flagged", () => {
    expect(flagged(4.5e-5, 6e-5)).toHaveLength(1); // z 2.5 → 4
    expect(flagged(-2.5e-5, 4.5e-5)).toHaveLength(1); // z −4.5 → +2.5
  });
  test("changedSinceBaseline: no baseline z (returns) always passes", () => {
    expect(changedSinceBaseline(3, undefined, 2)).toBe(true);
    expect(changedSinceBaseline(3, 1.9, 2)).toBe(true);
    expect(changedSinceBaseline(3, 2.1, 2)).toBe(false);
    expect(changedSinceBaseline(3, 2, 2)).toBe(true);
  });
});
