import { describe, expect, test } from "bun:test";
import { bucketBounds, bucketIndex, type FeedRow, type LiqBucket, type PlatformHealth } from "../../../shared/platform";
import {
  alphaStep, cellRow, cellSide, coverageTreatment, denseBuckets, edgeWord, filterFeed, fmtSigned, fmtSignedPct, healthItems, keyAction, p95, priceY, stepSelection, worstItem,
} from "./logic";

const row = (over: Partial<FeedRow>): FeedRow => ({
  id: "00000000-0000-4000-8000-000000000001", coin: "HYPE", direction: "long", setupKind: "oi-accel", tradeType: "directional",
  status: "ready", score: 0.8, netEdgeBps: 38, edgeBasis: "unvalidated", tags: [], liquidityTier: 1,
  createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", snoozedUntil: null, ...over,
});

describe("filterFeed", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const rows = [
    row({ id: "a", status: "ready", liquidityTier: 1 }),
    row({ id: "b", status: "new", liquidityTier: 2 }),
    row({ id: "c", status: "rejected", liquidityTier: 1 }),
    row({ id: "d", status: "calculated", snoozedUntil: "2026-10-16T13:00:00Z" }),
    row({ id: "e", status: "investigating", snoozedUntil: "2026-10-16T11:00:00Z" }),
    row({ id: "f", status: "failed", liquidityTier: 2 }),
  ];
  const ids = (r: FeedRow[]) => r.map((x) => x.id);
  test("status sets keep server order, expired snoozes rejoin the list", () => {
    expect(ids(filterFeed(rows, "live", "all", now).ranked)).toEqual(["a", "b", "e"]);
    expect(ids(filterFeed(rows, "live", "all", now).snoozed)).toEqual(["d"]);
    expect(ids(filterFeed(rows, "ready", "all", now).ranked)).toEqual(["a"]);
    expect(ids(filterFeed(rows, "decided", "all", now).ranked)).toEqual(["c", "f"]);
    expect(ids(filterFeed(rows, "all", 1, now).ranked)).toEqual(["a", "c", "e"]);
  });
});

test("stepSelection clamps and resumes from the top", () => {
  expect(stepSelection(["a", "b", "c"], "a", 1)).toBe("b");
  expect(stepSelection(["a", "b", "c"], "c", 1)).toBe("c");
  expect(stepSelection(["a", "b", "c"], "a", -1)).toBe("a");
  expect(stepSelection(["a", "b"], "gone", 1)).toBe("a");
  expect(stepSelection([], "a", 1)).toBeNull();
});

test("edgeWord: sign, costs exceed, non-directional", () => {
  expect(edgeWord({ netEdgeBps: 38, edgeBasis: "unvalidated", tradeType: "directional" })).toMatchObject({ text: "+38bp", tone: "green", unvalidated: true, costsExceed: false });
  expect(edgeWord({ netEdgeBps: -12, edgeBasis: "ledger", tradeType: "directional" })).toMatchObject({ text: "−12bp", costsExceed: true, unvalidated: false });
  expect(edgeWord({ netEdgeBps: null, edgeBasis: "unvalidated", tradeType: "directional" })).toMatchObject({ text: "—", title: "no cost model for directional" });
});

test("fmtSigned: one signed formatter for bp and %", () => {
  expect(fmtSigned(38, "bp")).toBe("+38bp");
  expect(fmtSigned(-12, "bp")).toBe("−12bp");
  expect(fmtSigned(0, "bp")).toBe("0bp");
  expect(fmtSignedPct(-0.054, 1)).toBe("−5.4%");
  expect(fmtSigned(4.8, "%", 1)).toBe("+4.8%");
});

describe("liquidation map", () => {
  const bps = 25;
  const b = (idx: number, longUsd: number, shortUsd: number): LiqBucket => ({ idx, longUsd, shortUsd, ...bucketBounds(idx, bps) });
  const markIdx = bucketIndex(100, bps);
  const buckets = [b(markIdx - 8, 10e6, 0), b(markIdx - 3, 1e6, 0), b(markIdx - 1, 0.5e6, 0), b(markIdx + 2, 0, 3e6), b(markIdx + 6, 0, 6e6)];

  test("denseBuckets fills the grid, highest price first", () => {
    const d = denseBuckets(buckets, bps);
    expect(d).toHaveLength(15);
    expect(d[0]!.idx).toBe(markIdx + 6);
    expect(d.at(-1)!.idx).toBe(markIdx - 8);
    expect(d.every((x, i) => i === 0 || x.idx === d[i - 1]!.idx - 1)).toBe(true);
  });

  test("coverage thresholds", () => {
    expect(coverageTreatment(0.31)).toBe("full");
    expect(coverageTreatment(0.25)).toBe("full");
    expect(coverageTreatment(0.18)).toBe("partial");
    expect(coverageTreatment(0.05)).toBe("partial");
    expect(coverageTreatment(0.049)).toBe("none");
  });

  test("p95 and alpha steps", () => {
    expect(p95([])).toBe(0);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(alphaStep(0, 10)).toBe(0);
    expect(alphaStep(1, 10)).toBe(1);
    expect(alphaStep(10, 10)).toBe(5);
    expect(alphaStep(50, 10)).toBe(5); // clipped
  });

  test("cellRow maps log-grid idx to rows that tile the axis", () => {
    const lo = bucketBounds(markIdx - 4, bps).priceLo;
    const hi = bucketBounds(markIdx + 3, bps).priceHi;
    const H = 800;
    const top = cellRow(markIdx + 3, bps, lo, hi, H);
    const bottom = cellRow(markIdx - 4, bps, lo, hi, H);
    expect(top.y).toBeCloseTo(0, 6);
    expect(bottom.y + bottom.h).toBeCloseTo(H, 6);
    expect(top.h).toBeCloseTo(H / 8, 6); // equal rows: the grid is uniform in log price
    const next = cellRow(markIdx + 2, bps, lo, hi, H);
    expect(next.y).toBeCloseTo(top.y + top.h, 6);
    expect(priceY(100, 50, 200, 100)).toBeCloseTo(50, 6);
    expect(cellSide({ idx: markIdx + 2, longUsd: 0, shortUsd: 1 }, bps, 100)).toBe("short");
    expect(cellSide({ idx: markIdx - 2, longUsd: 1, shortUsd: 0 }, bps, 100)).toBe("long");
  });
});

describe("healthItems", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  const h = (over: Partial<PlatformHealth>): PlatformHealth => ({
    ok: true, ts: ago(0), store: "pg",
    loops: [{ name: "scanner", lastBeatAt: ago(30), expectedIntervalSec: 60, ok: true, error: null }],
    ws: { state: "open", lastMessageAgeSec: 2 }, scanAgeSec: 41, crawler: { pollsPerMin: 388, addresses: 9400 }, llmSpendUsdToday: 0.42, ...over,
  });
  const lv = (x: PlatformHealth) => Object.fromEntries(healthItems(x, now).map((i) => [i.key, i.level]));

  test("all green", () => {
    expect(lv(h({}))).toEqual({ WS: "ok", SCAN: "ok", CRAWL: "ok", LOOPS: "ok", LLM: "unknown" });
    expect(healthItems(h({}), now).find((i) => i.key === "CRAWL")!.value).toBe("388/MIN · 9,400 ADDR");
  });
  test("warn and critical thresholds", () => {
    expect(lv(h({ ws: { state: "open", lastMessageAgeSec: 11 }, scanAgeSec: 91, crawler: { pollsPerMin: 50, addresses: 1 } }))).toMatchObject({ WS: "warn", SCAN: "warn", CRAWL: "warn" });
    expect(lv(h({ ws: { state: "closed", lastMessageAgeSec: 1 }, scanAgeSec: 121, crawler: { pollsPerMin: 0, addresses: 1 } }))).toMatchObject({ WS: "critical", SCAN: "critical", CRAWL: "critical" });
    expect(lv(h({ loops: [{ name: "a", lastBeatAt: ago(150), expectedIntervalSec: 60, ok: true, error: null }] })).LOOPS).toBe("warn");
    expect(lv(h({ loops: [{ name: "a", lastBeatAt: ago(400), expectedIntervalSec: 60, ok: true, error: null }] })).LOOPS).toBe("critical");
    expect(lv(h({ loops: [{ name: "a", lastBeatAt: ago(1), expectedIntervalSec: 60, ok: false, error: "boom" }] })).LOOPS).toBe("critical");
    expect(lv(h({ scanAgeSec: null })).SCAN).toBe("unknown");
    expect(worstItem(healthItems(h({ scanAgeSec: 200 }), now)).key).toBe("SCAN");
  });
});

describe("keyAction", () => {
  const k = (key: string, over: Partial<Parameters<typeof keyAction>[0]> = {}) => keyAction({ key, dialogOpen: false, snoozeOpen: false, ...over });
  test("the C3 map", () => {
    expect(k("j")).toEqual({ type: "next" });
    expect(k("k")).toEqual({ type: "prev" });
    expect(k("Enter")).toEqual({ type: "open" });
    expect(k("a")).toEqual({ type: "approve" });
    expect(k("r")).toEqual({ type: "reject" });
    expect(k("s")).toEqual({ type: "snoozeMenu" });
    expect(k("d")).toEqual({ type: "research" });
    expect(k("x")).toEqual({ type: "kill" });
    expect(k("?")).toEqual({ type: "help" });
    expect(k("q")).toBeNull();
  });
  test("ignored while typing, in a dialog, or with a modifier", () => {
    expect(k("j", { target: "input" })).toBeNull();
    expect(k("j", { target: "TEXTAREA" })).toBeNull();
    expect(k("j", { editable: true })).toBeNull();
    expect(k("j", { dialogOpen: true })).toBeNull();
    expect(k("j", { ctrlKey: true })).toBeNull();
    expect(k("a", { metaKey: true })).toBeNull();
  });
  test("snooze menu owns 1/2/3 and Esc", () => {
    expect(k("1", { snoozeOpen: true })).toEqual({ type: "snooze", minutes: 15 });
    expect(k("2", { snoozeOpen: true })).toEqual({ type: "snooze", minutes: 60 });
    expect(k("3", { snoozeOpen: true })).toEqual({ type: "snooze", minutes: 240 });
    expect(k("Escape", { snoozeOpen: true })).toEqual({ type: "closeMenu" });
    expect(k("j", { snoozeOpen: true })).toBeNull();
  });
});
