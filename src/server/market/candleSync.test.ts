import { describe, expect, test } from "bun:test";
import type { Timeframe } from "../../shared/timeframes.js";
import {
  fillOlder,
  isGap,
  monthStart,
  nextBarT,
  readPage,
  resampleDaily,
  seamOk,
  syncHead,
  type Bar,
  type SyncDeps,
  type SyncState,
} from "./candleSync.js";
import type { ExtBar, ExternalSource } from "./sources.js";

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2024, 0, 1); // a Monday

const bar = (t: number, c = 100, src = "hl"): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1, src });

/** In-memory store + fake HL window + fake external venues. */
function harness(opts: {
  now: number;
  /** Every bar HL "has", per timeframe; hlCandles serves the slice in range. */
  hl: Partial<Record<Timeframe, Bar[]>>;
  sources?: ExternalSource[];
}) {
  const store = new Map<string, Map<number, Bar>>();
  const states = new Map<string, SyncState>();
  const calls: string[] = [];
  const key = (coin: string, tf: string) => `${coin}|${tf}`;
  const series = (coin: string, tf: string) => {
    let m = store.get(key(coin, tf));
    if (!m) store.set(key(coin, tf), (m = new Map()));
    return m;
  };
  const sorted = (coin: string, tf: string) => [...series(coin, tf).values()].sort((a, b) => a.t - b.t);
  const deps: SyncDeps = {
    now: () => opts.now,
    async hlCandles(_coin, tf, start, end) {
      calls.push(`hl:${tf}:${start}:${end}`);
      return (opts.hl[tf] ?? []).filter((b) => b.t >= start && b.t <= end).map(({ src: _s, ...rest }) => rest);
    },
    sources: opts.sources ?? [],
    async getState(coin, s) {
      return structuredClone(states.get(key(coin, s)) ?? { coin, series: s, hlFloor: null, ext: {}, syncedAt: null, accessedAt: null, error: null });
    },
    async saveState(s) {
      states.set(key(s.coin, s.series), structuredClone(s));
    },
    async bounds(coin, tf) {
      const rows = sorted(coin, tf);
      return rows.length ? { min: rows[0]!.t, max: rows[rows.length - 1]!.t } : null;
    },
    async between(coin, tf, from, to) {
      return sorted(coin, tf).filter((b) => b.t >= from && b.t < to);
    },
    async before(coin, tf, before, limit) {
      const rows = sorted(coin, tf).filter((b) => b.t < before);
      return rows.slice(Math.max(0, rows.length - limit));
    },
    async upsert(coin, tf, bars) {
      for (const b of bars) series(coin, tf).set(b.t, b);
    },
  };
  return { deps, store: (tf: string, coin = "BTC") => sorted(coin, tf), states, calls };
}

/** A venue serving `bars` backwards, `pageSize` at a time. */
function venue(id: "binance" | "bitstamp", bars: ExtBar[] | "unsupported", tfs: Timeframe[] = ["1h", "1d"], pageSize = 3): ExternalSource & { calls: number[] } {
  const calls: number[] = [];
  return {
    id,
    pageSize,
    calls,
    supports: (tf) => tfs.includes(tf),
    async fetchBefore(_coin, _tf, endTime, limit) {
      calls.push(endTime);
      if (bars === "unsupported") return { kind: "unsupported" };
      const upTo = bars.filter((b) => b.t <= endTime);
      return { kind: "ok", bars: upTo.slice(Math.max(0, upTo.length - limit)) };
    },
  };
}

const ext = (t: number, c = 100): ExtBar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 2 });

describe("pure helpers", () => {
  test("monthStart / nextBarT handle calendar months", () => {
    expect(monthStart(Date.UTC(2024, 1, 17, 5))).toBe(Date.UTC(2024, 1, 1));
    expect(nextBarT(Date.UTC(2024, 0, 1), "1M")).toBe(Date.UTC(2024, 1, 1));
    expect(nextBarT(Date.UTC(2024, 11, 1), "1M")).toBe(Date.UTC(2025, 0, 1));
    expect(nextBarT(T0, "4h")).toBe(T0 + 4 * H);
  });

  test("isGap tolerates exactly one bar and flags a hole", () => {
    expect(isGap(T0, T0 + H, "1h")).toBe(false);
    expect(isGap(T0, T0 + 3 * H, "1h")).toBe(true);
    expect(isGap(Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1), "1M")).toBe(false); // 31-day month
    expect(isGap(Date.UTC(2024, 0, 1), Date.UTC(2024, 3, 1), "1M")).toBe(true);
  });

  test("seamOk accepts a matching venue and rejects an impostor", () => {
    const ref = [bar(T0, 100), bar(T0 + H, 101)];
    expect(seamOk([ext(T0 - H, 99), ext(T0, 100.5), ext(T0 + H, 101.2)], ref, "1h")).toBe(true);
    expect(seamOk([ext(T0, 50), ext(T0 + H, 51)], ref, "1h")).toBe(false); // same ticker, different asset
    expect(seamOk([], ref, "1h")).toBe(false);
  });

  test("seamOk without overlap compares the adjacent bars", () => {
    const ref = [bar(T0, 100)];
    expect(seamOk([ext(T0 - 2 * H, 97)], ref, "1h")).toBe(true);
    expect(seamOk([ext(T0 - 2 * H, 150)], ref, "1h")).toBe(false);
    expect(seamOk([ext(T0 - 10 * H, 100)], ref, "1h")).toBe(false); // too far apart to vouch for
  });

  test("resampleDaily builds complete weeks on the given phase and drops partial buckets", () => {
    const days = Array.from({ length: 17 }, (_, i) => bar(T0 + i * D, 100 + i, i < 7 ? "bitstamp" : "binance"));
    const weeks = resampleDaily(days, "1w", T0 + 14 * D); // phase = a Monday two weeks on
    expect(weeks.map((w) => w.t)).toEqual([T0, T0 + 7 * D]); // third week has 3 days: dropped
    expect(weeks[0]).toMatchObject({ o: 100, c: 106, h: 107, l: 99, v: 7, src: "bitstamp" });
    expect(weeks[1]!.src).toBe("binance");
  });

  test("resampleDaily builds calendar months", () => {
    const jan = Array.from({ length: 31 }, (_, i) => bar(Date.UTC(2024, 0, 1) + i * D, 10 + i));
    const febPartial = [bar(Date.UTC(2024, 1, 1), 50)];
    const months = resampleDaily([...jan, ...febPartial], "1M", 0);
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ t: Date.UTC(2024, 0, 1), o: 10, c: 40 });
  });
});

describe("syncHead", () => {
  test("first sync stores HL's window and records the listing as HL's floor", async () => {
    const hl = Array.from({ length: 10 }, (_, i) => bar(T0 + i * D));
    const h = harness({ now: T0 + 9.5 * D, hl: { "1d": hl } });
    await syncHead("BTC", "1d", h.deps);
    expect(h.store("1d")).toHaveLength(10);
    expect(h.states.get("BTC|1d")!.hlFloor).toBe(T0);
  });

  test("leading zero-volume bars (HL's pre-trading padding) are not HL history", async () => {
    const hl = [...[0, 1, 2].map((i) => ({ ...bar(T0 + i * D), v: 0 })), ...[3, 4, 5].map((i) => bar(T0 + i * D))];
    hl[4]!.v = 0; // a quiet day mid-series stays
    const h = harness({ now: T0 + 5.5 * D, hl: { "1d": hl } });
    await syncHead("BTC", "1d", h.deps);
    expect(h.store("1d").map((b) => (b.t - T0) / D)).toEqual([3, 4, 5]);
    expect(h.states.get("BTC|1d")!.hlFloor).toBe(T0 + 3 * D);
  });

  test("is throttled, re-fetches the open bar, and can be forced", async () => {
    const hl = Array.from({ length: 5 }, (_, i) => bar(T0 + i * H));
    const h = harness({ now: T0 + 4.5 * H, hl: { "1h": hl } });
    await syncHead("BTC", "1h", h.deps);
    await syncHead("BTC", "1h", h.deps);
    expect(h.calls).toHaveLength(1);
    await syncHead("BTC", "1h", h.deps, true);
    expect(h.calls[1]).toBe(`hl:1h:${T0 + 4 * H}:${T0 + 4.5 * H}`); // from the last stored bar
  });

  test("a hole between the stored tail and HL's window is filled from an external venue", async () => {
    const h = harness({ now: T0 + 20.5 * H, hl: { "1h": [18, 19, 20].map((i) => bar(T0 + i * H)) } });
    await h.deps.upsert("BTC", "1h", [bar(T0), bar(T0 + H)]);
    await h.deps.saveState({ coin: "BTC", series: "1h", hlFloor: T0, ext: {}, syncedAt: 0, accessedAt: null, error: null });
    const bin = venue("binance", Array.from({ length: 21 }, (_, i) => ext(T0 + i * H)), ["1h"], 100);
    h.deps.sources = [bin];
    await syncHead("BTC", "1h", h.deps);
    const ts = h.store("1h").map((b) => (b.t - T0) / H);
    expect(ts).toEqual(Array.from({ length: 21 }, (_, i) => i));
    expect(h.store("1h").find((b) => b.t === T0 + 10 * H)!.src).toBe("binance");
    expect(h.store("1h").find((b) => b.t === T0 + H)!.src).toBe("hl"); // existing bars untouched
  });
});

describe("fillOlder", () => {
  // HL listed at T0+10h; Binance has T0..T0+12h; Bitstamp has T0-6h..T0+2h.
  const hlBars = Array.from({ length: 5 }, (_, i) => bar(T0 + (10 + i) * H));
  const binBars = Array.from({ length: 13 }, (_, i) => ext(T0 + i * H));
  const bsBars = Array.from({ length: 9 }, (_, i) => ext(T0 + (i - 6) * H));

  test("walks HL, then Binance below HL's floor, then Bitstamp below Binance's", async () => {
    const bin = venue("binance", binBars, ["1h"], 4);
    const bs = venue("bitstamp", bsBars, ["1h"], 4);
    const h = harness({ now: T0 + 14.5 * H, hl: { "1h": hlBars }, sources: [bin, bs] });
    await syncHead("BTC", "1h", h.deps);
    let r = await fillOlder("BTC", "1h", T0 + 10 * H, 100, h.deps, { extPages: 20, deadline: Infinity });
    expect(r.exhausted).toBe(true);
    const rows = h.store("1h");
    expect(rows.map((b) => (b.t - T0) / H)).toEqual(Array.from({ length: 21 }, (_, i) => i - 6));
    expect(rows.filter((b) => b.src === "hl").map((b) => (b.t - T0) / H)).toEqual([10, 11, 12, 13, 14]); // HL wins the overlap
    expect(rows.filter((b) => b.src === "binance")).toHaveLength(10);
    expect(rows.filter((b) => b.src === "bitstamp")).toHaveLength(6);
    const st = h.states.get("BTC|1h")!;
    expect(st.hlFloor).toBe(T0 + 10 * H);
    expect(st.ext.binance).toEqual({ status: "ok", floor: T0, exhausted: true });
    expect(st.ext.bitstamp).toMatchObject({ status: "ok", floor: T0 - 6 * H, exhausted: true });

    r = await fillOlder("BTC", "1h", T0 - 6 * H, 100, h.deps);
    expect(r).toEqual({ added: 0, exhausted: true });
  });

  test("a venue that fails the seam check is never used", async () => {
    const impostor = venue("binance", binBars.map((b) => ({ ...b, c: b.c * 3 })), ["1h"], 50);
    const h = harness({ now: T0 + 14.5 * H, hl: { "1h": hlBars }, sources: [impostor] });
    await syncHead("BTC", "1h", h.deps);
    const r = await fillOlder("BTC", "1h", T0 + 10 * H, 100, h.deps);
    expect(r.exhausted).toBe(true);
    expect(h.store("1h").every((b) => b.src === "hl")).toBe(true);
    expect(h.states.get("BTC|1h")!.ext.binance!.status).toBe("none");
  });

  test("an unsupported symbol falls through to the next venue", async () => {
    const bs = venue("bitstamp", binBars, ["1h"], 50);
    const h = harness({ now: T0 + 14.5 * H, hl: { "1h": hlBars }, sources: [venue("binance", "unsupported", ["1h"]), bs] });
    await syncHead("BTC", "1h", h.deps);
    await fillOlder("BTC", "1h", T0 + 10 * H, 100, h.deps);
    expect(h.store("1h").filter((b) => b.src === "bitstamp")).toHaveLength(10);
    expect(h.states.get("BTC|1h")!.ext.binance!.status).toBe("none");
  });

  test("respects the page budget and resumes on the next call", async () => {
    const bin = venue("binance", binBars, ["1h"], 3);
    const h = harness({ now: T0 + 14.5 * H, hl: { "1h": hlBars }, sources: [bin] });
    await syncHead("BTC", "1h", h.deps);
    const r1 = await fillOlder("BTC", "1h", T0 + 10 * H, 100, h.deps, { extPages: 2, deadline: Infinity });
    expect(r1.exhausted).toBe(false);
    expect(bin.calls).toHaveLength(2);
    const r2 = await fillOlder("BTC", "1h", h.store("1h")[0]!.t, 100, h.deps);
    expect(r2.exhausted).toBe(true);
    expect(h.store("1h")[0]!.t).toBe(T0);
  });

  test("weekly history below HL's floor is resampled from daily bars on HL's weekly phase", async () => {
    // HL: weekly + daily from T0+28d. Binance daily from T0.
    const hlWeeks = [bar(T0 + 28 * D, 134), bar(T0 + 35 * D, 141)];
    const hlDays = Array.from({ length: 14 }, (_, i) => bar(T0 + (28 + i) * D, 128 + i));
    const binDays = Array.from({ length: 30 }, (_, i) => ext(T0 + i * D, 100 + i));
    const h = harness({ now: T0 + 41.5 * D, hl: { "1w": hlWeeks, "1d": hlDays }, sources: [venue("binance", binDays, ["1d"], 50)] });
    await syncHead("BTC", "1w", h.deps);
    await syncHead("BTC", "1d", h.deps);
    const r = await fillOlder("BTC", "1w", T0 + 28 * D, 50, h.deps);
    const weeks = h.store("1w");
    expect(weeks.map((w) => (w.t - T0) / D)).toEqual([0, 7, 14, 21, 28, 35]);
    expect(weeks[0]).toMatchObject({ o: 100, c: 106, src: "binance" });
    expect(r.exhausted).toBe(true);
  });
});

describe("readPage", () => {
  test("latest page syncs the head; hasMore stays true until every layer is exhausted", async () => {
    const hl = Array.from({ length: 6 }, (_, i) => bar(T0 + (4 + i) * H));
    const bin = venue("binance", Array.from({ length: 7 }, (_, i) => ext(T0 + i * H)), ["1h"], 50);
    const h = harness({ now: T0 + 9.5 * H, hl: { "1h": hl }, sources: [bin] });

    const p1 = await readPage("BTC", "1h", { limit: 4 }, h.deps);
    expect(p1.bars.map((b) => (b.t - T0) / H)).toEqual([6, 7, 8, 9]);
    expect(p1.hasMore).toBe(true);

    const p2 = await readPage("BTC", "1h", { before: p1.bars[0]!.t, limit: 4 }, h.deps);
    expect(p2.bars.map((b) => (b.t - T0) / H)).toEqual([2, 3, 4, 5]);
    expect(p2.bars.map((b) => b.src)).toEqual(["binance", "binance", "hl", "hl"]);

    const p3 = await readPage("BTC", "1h", { before: p2.bars[0]!.t, limit: 4 }, h.deps);
    expect(p3.bars.map((b) => (b.t - T0) / H)).toEqual([0, 1]);
    expect(p3.hasMore).toBe(false);
  });

  test("an upstream failure is reported and keeps hasMore true so the chart can retry", async () => {
    const h = harness({ now: T0, hl: {} });
    h.deps.hlCandles = async () => {
      throw new Error("HL 502");
    };
    const p = await readPage("BTC", "1h", { limit: 10 }, h.deps);
    expect(p.bars).toEqual([]);
    expect(p.error).toBe("HL 502");
  });
});
