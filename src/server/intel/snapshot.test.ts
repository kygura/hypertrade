import { describe, expect, test } from "bun:test";
import type { AssetCtx } from "../../shared/types.js";
import { collectIntelSnapshots, fetchL2Book, focusAssets, parseL2Book, selectSnapshotAssets, snapshotRow, SNAPSHOT_COLLECTOR, type BookStats } from "./snapshot.js";
import { MemoryIntelStore } from "./store.js";

const BOOK = {
  coin: "SOL",
  time: 1760356800000,
  levels: [
    [
      { px: "100.0", sz: "2", n: 3 },
      { px: "99.5", sz: "1", n: 1 },
      { px: "98.5", sz: "4", n: 2 },
      { px: "97", sz: "10", n: 5 },
    ],
    [
      { px: "100.2", sz: "1", n: 1 },
      { px: "101", sz: "3", n: 2 },
      { px: "101.5", sz: "2", n: 1 },
      { px: "103", sz: "5", n: 4 },
    ],
  ],
};

function ctx(name: string, over: Partial<AssetCtx> = {}): AssetCtx {
  return {
    name, szDecimals: 2, markPx: 100, oraclePx: 99.5, midPx: 100, dayNtlVlm: 5e6, prevDayPx: 98, openInterest: 1000,
    funding: 1.25e-5, premium: 4e-4, dayChange: 0.02, isDelisted: false, ...over,
  };
}

describe("parseL2Book", () => {
  test("mid, spread and USD depth within ±1% / ±2%", () => {
    const b = parseL2Book(BOOK)!;
    expect(b.mid).toBeCloseTo(100.1, 12);
    expect(b.spreadBps).toBeCloseTo((0.2 / 100.1) * 1e4, 9);
    // ±1% of 100.1: bids ≥ 99.099, asks ≤ 101.101
    expect(b.depthBid1).toBeCloseTo(100 * 2 + 99.5, 9);
    expect(b.depthAsk1).toBeCloseTo(100.2 + 101 * 3, 9);
    // ±2%: bids ≥ 98.098, asks ≤ 102.102
    expect(b.depthBid2).toBeCloseTo(299.5 + 98.5 * 4, 9);
    expect(b.depthAsk2).toBeCloseTo(403.2 + 101.5 * 2, 9);
  });
  test("empty, crossed or malformed → null", () => {
    expect(parseL2Book({ levels: [[], BOOK.levels[1]] })).toBeNull();
    expect(parseL2Book({ levels: [[{ px: "101", sz: "1" }], [{ px: "100", sz: "1" }]] })).toBeNull();
    expect(parseL2Book({ nope: 1 })).toBeNull();
    expect(parseL2Book(null)).toBeNull();
  });
  test("fetchL2Book posts an l2Book info request", async () => {
    let sent: unknown;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify(BOOK), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await fetchL2Book("SOL", fetchFn))?.mid).toBeCloseTo(100.1, 12);
    expect(sent).toEqual({ type: "l2Book", coin: "SOL" });
  });
});

describe("snapshotRow", () => {
  test("price = mark, OI in USD, basis = (mark − oracle)/oracle, book fields from l2Book", () => {
    const ts = new Date("2026-10-13T12:00:00Z");
    const r = snapshotRow(ctx("SOL"), ts, parseL2Book(BOOK))!;
    expect(r).toMatchObject({ asset: "SOL", ts: ts.toISOString(), price: 100, vol24h: 5e6, funding: 1.25e-5, oiUsd: 100_000, premium: 4e-4 });
    expect(r.basis).toBeCloseTo(0.5 / 99.5, 12);
    expect(r.depthBid1).toBeCloseTo(299.5, 9);
    expect(snapshotRow(ctx("SOL"), ts)!.spreadBps).toBeNull();
    expect(snapshotRow(ctx("X", { markPx: 0 }), ts)).toBeNull();
    expect(snapshotRow(ctx("X", { oraclePx: 0 }), ts)!.basis).toBeNull();
  });
});

describe("selectSnapshotAssets", () => {
  const ctxs = [
    ...Array.from({ length: 22 }, (_, i) => ctx(`C${i}`, { openInterest: 1000 * (i + 1) })),
    ctx("DEAD", { isDelisted: true, openInterest: 1e9 }),
    ctx("THIN", { openInterest: 0 }),
  ];
  test("rows: held ∪ watched ∪ top-20 by OI; books: held ∪ watched only, ≤ 25", () => {
    const { rows, books } = selectSnapshotAssets(ctxs, ["THIN", "DEAD", "NOTLISTED", "C0"]);
    expect(rows.slice(0, 2)).toEqual(["THIN", "C0"]);
    expect(rows).toHaveLength(22); // THIN, C0 and the top 20 (C21..C2)
    expect(rows).not.toContain("DEAD");
    expect(rows).not.toContain("C1");
    expect(books).toEqual(["THIN", "C0"]);
    const many = selectSnapshotAssets(ctxs, ctxs.map((c) => c.name));
    expect(many.books).toHaveLength(23); // every listed, non-delisted coin (THIN included), under the cap
    expect(selectSnapshotAssets(Array.from({ length: 30 }, (_, i) => ctx(`X${i}`)), Array.from({ length: 30 }, (_, i) => `X${i}`)).books).toHaveLength(25);
  });
});

describe("focusAssets", () => {
  test("held from positions, watched from the list; failures are reported, not thrown", async () => {
    const res = await focusAssets(
      async () => ({
        positions: [{ asset: "SOL" }, { asset: "SOL" }, { asset: "ETH" }] as never,
        sources: [{ source: "hl", ok: false, error: "HTTP 429" }, { source: "desk", ok: false, error: "desk account not configured" }],
        totalNotionalUsd: 0,
      }),
      async () => Promise.reject(new Error("db down")),
    );
    expect(res).toEqual({ held: ["SOL", "ETH"], watched: [], errors: ["hl: HTTP 429", "watchlist: db down"] });
  });
});

describe("collectIntelSnapshots", () => {
  const ts = new Date("2026-10-13T12:00:00Z");
  const ctxs = [ctx("SOL"), ctx("ETH", { openInterest: 5000 }), ctx("kPEPE", { markPx: 0.01, openInterest: 1e8 })];

  test("writes rows; books only for held ∪ watched; one book failing leaves only that coin without depth", async () => {
    const store = new MemoryIntelStore();
    const runs: Array<{ collector: string; ok: boolean; error?: string | null }> = [];
    const asked: string[] = [];
    const res = await collectIntelSnapshots(
      {
        store,
        focus: async () => ({ held: ["SOL"], watched: ["kPEPE"], errors: [] }),
        l2Book: async (coin): Promise<BookStats | null> => {
          asked.push(coin);
          if (coin === "kPEPE") throw new Error("HL 429");
          return parseL2Book(BOOK);
        },
        recordRun: async (collector, _s, ok, error) => void runs.push({ collector, ok, error }),
      },
      ctxs,
      ts,
    );
    expect(res).toMatchObject({ ok: true, written: 3, assets: 3, books: 1, errors: ["kPEPE book: HL 429"] });
    expect(asked.sort()).toEqual(["SOL", "kPEPE"]);
    const sol = await store.nearestSnapshot("SOL", ts);
    expect(sol?.depthBid1).toBeCloseTo(299.5, 9);
    expect((await store.nearestSnapshot("kPEPE", ts))?.depthBid1).toBeNull();
    expect((await store.nearestSnapshot("ETH", ts))?.price).toBe(100); // top-20 by OI, no book
    expect(runs).toEqual([{ collector: SNAPSHOT_COLLECTOR, ok: true, error: "kPEPE book: HL 429" }]);
  });

  test("a failure is recorded and returned, never thrown", async () => {
    const runs: boolean[] = [];
    const res = await collectIntelSnapshots(
      {
        store: { insertSnapshots: async () => Promise.reject(new Error("relation intel_snapshots does not exist")) },
        focus: async () => ({ held: [], watched: [], errors: [] }),
        l2Book: async () => null,
        recordRun: async (_c, _s, ok) => void runs.push(ok),
      },
      ctxs,
      ts,
    );
    expect(res).toMatchObject({ ok: false, written: 0, error: "relation intel_snapshots does not exist" });
    expect(runs).toEqual([false]);
  });

  test("books past the deadline are skipped; rows still written", async () => {
    const store = new MemoryIntelStore();
    let books = 0;
    const res = await collectIntelSnapshots(
      { store, focus: async () => ({ held: ["SOL"], watched: [], errors: [] }), l2Book: async () => (books++, null), recordRun: async () => {}, deadline: 0 },
      ctxs,
      ts,
    );
    expect(books).toBe(0);
    expect(res).toMatchObject({ ok: true, written: 3, books: 0 });
    expect(res.errors[0]).toContain("deadline");
  });
});
