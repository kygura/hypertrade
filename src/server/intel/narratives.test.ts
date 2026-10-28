import { describe, expect, test } from "bun:test";
import type { IntelEvent, NarrativeHtf, NarrativeWindow, SnapshotRow } from "../../shared/intel.js";
import type { SectorsData } from "../../shared/types.js";
import { alignment, basketCoins, basketSeries, firstSeenById, flowScore, loadNarrativeFlows, narrativeHeadlines, quadrant, rankNarratives, stage } from "./narratives.js";
import { MemoryIntelStore } from "./store.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const STEP = 15 * 60_000;
const DAY = 86_400_000;

const row = (asset: string, t: number, price: number, oiUsd: number | null, funding: number | null = 1e-5): SnapshotRow => ({
  asset, ts: new Date(t).toISOString(), price, vol24h: null, funding, oiUsd, premium: null, basis: null,
  depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null,
});

/** Deterministic noise in [-1, 1]. */
function noise(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) * 2 - 1;
}

/**
 * 31 days of 15-minute snapshots: log price drifts `drift`/day, OI `oiDrift`/day, both with noise; over the
 * last 6 h price adds `jumpPx` and OI `jumpOi` (log points).
 */
function history(asset: string, o: { drift: number; oiDrift: number; jumpPx?: number; jumpOi?: number; seed: number; price?: number; oi?: number }): SnapshotRow[] {
  const rnd = noise(o.seed);
  const out: SnapshotRow[] = [];
  for (let t = NOW - 31 * DAY; t <= NOW; t += STEP) {
    const days = (t - (NOW - 31 * DAY)) / DAY;
    const late = Math.max(0, Math.min(1, (t - (NOW - 6 * 3_600_000)) / (6 * 3_600_000)));
    const px = (o.price ?? 100) * Math.exp(o.drift * days + 0.002 * rnd() + (o.jumpPx ?? 0) * late);
    const oi = (o.oi ?? 1e8) * Math.exp(o.oiDrift * days + 0.002 * rnd() + (o.jumpOi ?? 0) * late);
    out.push(row(asset, t, px, oi, 1e-5 * (1 + 0.1 * rnd())));
  }
  return out;
}

const htf = (over: Partial<NarrativeHtf>): NarrativeHtf => ({
  pricePct7d: 5, pricePct30d: 10, relBtc7d: 2, relBtc30d: 4, oiPct7d: 8, oiPct30d: 15, funding: 1e-5, fundingZ: 0, ...over,
});
const win = (window: NarrativeWindow["window"], priceZ: number | null, oiZ: number | null): NarrativeWindow => ({
  window, pricePct: 0, priceZ, oiPct: 0, oiZ, quadrant: quadrant(priceZ, oiZ),
});

describe("basketSeries", () => {
  test("price is the chained equal-weight mean ratio; a token entering coverage moves neither index", () => {
    const t0 = NOW - 2 * STEP;
    const s = basketSeries([
      [row("A", t0, 100, 1e6), row("A", t0 + STEP, 110, 1.1e6), row("A", t0 + 2 * STEP, 110, 1.1e6)],
      // B appears at the second time with 100x A's OI; only from then on do its ratios count.
      [row("B", t0 + STEP, 50, 1e8), row("B", t0 + 2 * STEP, 40, 1e8)],
    ]);
    expect(s.price!.map((p) => p.v)).toEqual([1, 1.1, 1.1 * ((1 + 0.8) / 2)]);
    expect(s.oi_usd![1]!.v).toBeCloseTo(1.1, 12);
    expect(s.oi_usd![2]!.v).toBeCloseTo(1.1 * ((1.1e6 + 1e8) / (1.1e6 + 1e8)), 12);
  });

  test("funding is OI-weighted at each time; rows without OI do not weigh in", () => {
    const s = basketSeries([[row("A", NOW, 1, 3e6, 4e-5)], [row("B", NOW, 1, 1e6, 0)], [row("C", NOW, 1, null, 1)]]);
    expect(s.funding![0]!.v).toBeCloseTo(3e-5, 12);
  });
});

describe("quadrant, stage, alignment", () => {
  test("price × OI quadrant needs both |z| ≥ 1", () => {
    expect(quadrant(1.2, 1.5)).toBe("long_build");
    expect(quadrant(-1.2, 1.5)).toBe("short_build");
    expect(quadrant(1.2, -1.5)).toBe("short_cover");
    expect(quadrant(-1, -1)).toBe("long_unwind");
    expect(quadrant(3, 0.5)).toBe("quiet");
    expect(quadrant(null, 2)).toBe("unknown");
  });

  test("stage from relative strength, OI and the funding level", () => {
    expect(stage(htf({}))).toBe("expanding");
    expect(stage(htf({ relBtc30d: -3 }))).toBe("emerging");
    expect(stage(htf({ relBtc30d: null }))).toBe("emerging");
    expect(stage(htf({ fundingZ: 2.5 }))).toBe("crowded");
    expect(stage(htf({ fundingZ: 2.5, oiPct7d: -2 }))).toBe("fading");
    expect(stage(htf({ relBtc7d: -2 }))).toBe("fading");
    expect(stage(htf({ relBtc7d: -2, relBtc30d: -2 }))).toBe("quiet");
    // Inside the floors: noise names no stage.
    expect(stage(htf({ relBtc7d: 0.6, oiPct7d: 0.8 }))).toBe("quiet");
    expect(stage(htf({ relBtc7d: -0.5, relBtc30d: 0.4 }))).toBe("quiet");
    expect(stage(htf({ oiPct7d: null }))).toBe("unknown");
  });

  test("alignment takes the strongest moving window against the 7d price direction", () => {
    const ltf = [win("1h", -1.1, -1.2), win("6h", 2.5, 3), win("24h", 0.2, 0.1)];
    expect(alignment(ltf, 4)).toBe("with");
    expect(alignment(ltf, -4)).toBe("against");
    expect(alignment([win("1h", 0.1, 0.1)], 4)).toBe("none");
    expect(alignment(ltf, null)).toBe("none");
    expect(flowScore(ltf)).toBe(3);
    expect(flowScore([win("1h", null, null)])).toBeNull();
  });

  test("rank: strongest flow first, no-z rows last in input order", () => {
    const rows = [{ id: "a", flowScore: null }, { id: "b", flowScore: 1 }, { id: "c", flowScore: 4 }, { id: "d", flowScore: null }];
    expect(rankNarratives(rows).map((r) => r.id)).toEqual(["c", "b", "a", "d"]);
  });
});

const SECTORS: SectorsData = {
  generated_at: "2026-10-27T10:00:00Z",
  sectors: [
    { id: "quiet", label: "Quiet", mindshare_score: 0.3, momentum: 0, rationale: "", tokens: ["Q1", "Q2"], sources: [] },
    { id: "hot", label: "Hot", mindshare_score: 0.6, momentum: 0.4, rationale: "", tokens: ["H1", "H2", "GONE"], sources: [] },
  ],
  rotations: [],
};

describe("loadNarrativeFlows", () => {
  test("a basket out-running BTC with OI up is expanding, its last-6h burst a long build in line with the trend", async () => {
    const store = new MemoryIntelStore(() => new Date(NOW));
    await store.insertSnapshots([
      ...history("BTC", { drift: 0, oiDrift: 0, seed: 1 }),
      ...history("H1", { drift: 0.01, oiDrift: 0.005, jumpPx: 0.03, jumpOi: 0.1, seed: 2 }),
      ...history("H2", { drift: 0.01, oiDrift: 0.005, jumpPx: 0.03, jumpOi: 0.1, seed: 3 }),
      ...history("Q1", { drift: 0, oiDrift: 0, seed: 4 }),
      ...history("Q2", { drift: 0, oiDrift: 0, seed: 5 }),
    ]);
    const flows = await loadNarrativeFlows({
      store,
      now: () => new Date(NOW),
      sectors: SECTORS,
      history: [{ date: "2026-10-20", data: SECTORS }, { date: "2026-10-01", data: { ...SECTORS, sectors: [SECTORS.sectors[1]] } }, { date: "2026-09-01", data: { bad: true } }],
    });
    const [hot, quiet] = flows;
    expect(hot!.id).toBe("hot"); // ranked first on its 6h z
    expect(hot!.covered).toEqual(["H1", "H2"]);
    expect(hot!.missing).toEqual(["GONE"]);
    expect(hot!.firstSeen).toBe("2026-10-01");
    expect(hot!.stage).toBe("expanding");
    expect(hot!.htf.relBtc7d!).toBeGreaterThan(5);
    expect(hot!.htf.oiPct7d!).toBeGreaterThan(3);
    const six = hot!.ltf.find((w) => w.window === "6h")!;
    expect(six.quadrant).toBe("long_build");
    expect(six.pricePct!).toBeCloseTo((Math.exp(0.03 + 0.01 / 4) - 1) * 100, 0);
    expect(hot!.alignment).toBe("with");
    expect(hot!.oiUsd!).toBeGreaterThan(2e8);
    expect(quiet!.stage).toBe("quiet");
    expect(quiet!.ltf.find((w) => w.window === "6h")!.quadrant).toBe("quiet");
    expect(quiet!.firstSeen).toBe("2026-10-20");
  });

  test("tokens with no stored history read unknown, not zero", async () => {
    const store = new MemoryIntelStore(() => new Date(NOW));
    const [hot] = (await loadNarrativeFlows({ store, now: () => new Date(NOW), sectors: { ...SECTORS, sectors: [SECTORS.sectors[1]!] }, history: [] }));
    expect(hot!.covered).toEqual([]);
    expect(hot!.stage).toBe("unknown");
    expect(hot!.ltf.every((w) => w.quadrant === "unknown")).toBe(true);
    expect(hot!.oiUsd).toBeNull();
    expect(hot!.flowScore).toBeNull();
  });
});

describe("basketCoins and firstSeenById", () => {
  test("deduped basket tokens in sector order, capped", () => {
    const s = { ...SECTORS, sectors: [...SECTORS.sectors, { ...SECTORS.sectors[0]!, id: "dup" }] };
    expect(basketCoins(s)).toEqual(["Q1", "Q2", "H1", "H2", "GONE"]);
    expect(basketCoins(s, 3)).toEqual(["Q1", "Q2", "H1"]);
  });

  test("earliest date per id, unsorted input, invalid files skipped", () => {
    const seen = firstSeenById([{ date: "2026-10-20", data: SECTORS }, { date: "2026-09-01", data: { nope: 1 } }]);
    expect(Object.fromEntries(seen)).toEqual({ quiet: "2026-10-20", hot: "2026-10-20" });
  });
});

const event = (key: string, firstSeen: string, assets: string[], over: Partial<IntelEvent> = {}): IntelEvent => ({
  id: key,
  key,
  clusterId: null,
  type: "other",
  title: key,
  summary: null,
  entities: [],
  assets,
  magnitude: "med",
  sources: [{ label: "rss" }],
  origin: "rss",
  firstSeen,
  scheduledAt: null,
  catalyst: null,
  tag: "observed",
  ...over,
});

describe("narrativeHeadlines", () => {
  const tokens = ["TAO", "FET"];
  test("basket overlap is case-insensitive, newest first, one per cluster, assets in basket spelling", () => {
    const events = [
      event("old", "2026-10-26T08:00:00.000Z", ["tao"]),
      event("sol", "2026-10-27T11:00:00.000Z", ["SOL"]),
      event("dup", "2026-10-27T09:00:00.000Z", ["FET"], { clusterId: "c1" }),
      event("new", "2026-10-27T10:00:00.000Z", ["Fet", "TAO", "SOL", "tao"], { clusterId: "c1", sources: [{ label: "x" }, { label: "y", url: "https://a/1" }, { label: "z", url: "https://a/2" }] }),
      event("solo", "2026-10-27T09:30:00.000Z", ["TAO"]),
    ];
    expect(narrativeHeadlines(events, tokens, 10)).toEqual([
      { title: "new", firstSeen: "2026-10-27T10:00:00.000Z", url: "https://a/1", assets: ["FET", "TAO"] },
      { title: "solo", firstSeen: "2026-10-27T09:30:00.000Z", url: null, assets: ["TAO"] },
      { title: "old", firstSeen: "2026-10-26T08:00:00.000Z", url: null, assets: ["TAO"] },
    ]);
  });

  test("max caps after dedupe; unclustered events never dedupe each other", () => {
    const events = [event("a", "2026-10-27T10:00:00.000Z", ["TAO"]), event("b", "2026-10-27T09:00:00.000Z", ["TAO"], { clusterId: "c" }), event("c", "2026-10-27T08:00:00.000Z", ["TAO"], { clusterId: "c" }), event("d", "2026-10-27T07:00:00.000Z", ["TAO"])];
    expect(narrativeHeadlines(events, tokens, 2).map((h) => h.title)).toEqual(["a", "b"]);
    expect(narrativeHeadlines(events, tokens, 10).map((h) => h.title)).toEqual(["a", "b", "d"]);
    expect(narrativeHeadlines(events, [], 10)).toEqual([]);
  });
});
