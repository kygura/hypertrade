import { describe, expect, test } from "bun:test";
import { batchSize, capBatch, createBatchSink, emptyBatch, flushBatch, mergeBatches, type BatchWriter } from "./batch.js";

const snap = (asset: string, ts: string, price = 1) => ({
  asset, ts, price, vol24h: null, funding: null, oiUsd: null, premium: null, basis: null,
  depthBid1: null, depthAsk1: null, depthBid2: null, depthAsk2: null, spreadBps: null,
});

function writer(over: Partial<BatchWriter> = {}): BatchWriter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensureSeries: async () => void calls.push("series"),
    upsertObservations: async (rows) => (calls.push(`obs:${rows.length}`), rows.length),
    insertSnapshots: async (rows) => (calls.push("snapshots"), rows.length),
    recordStops: async (rows) => (calls.push("stops"), rows.length),
    insertCollectorRuns: async (rows) => (calls.push("runs"), rows.length),
    ...over,
  };
}

function filled() {
  const sink = createBatchSink(() => new Date("2026-10-17T12:00:05Z"));
  const ts = new Date("2026-10-17T12:00:00Z");
  void sink.db.ensureSeries([{ id: "a" }, { id: "b" }]);
  void sink.db.upsertObservations([{ seriesId: "a", ts, value: 1 }, { seriesId: "b", ts, value: 2 }]);
  void sink.db.recordCollectorRun("hyperliquid", ts, true);
  void sink.store.insertSnapshots([snap("BTC", ts.toISOString())]);
  return sink.batch;
}

describe("createBatchSink", () => {
  test("buffers every write as serialisable rows", () => {
    const b = filled();
    expect(b.observations).toEqual([{ seriesId: "a", ts: "2026-10-17T12:00:00.000Z", value: 1 }, { seriesId: "b", ts: "2026-10-17T12:00:00.000Z", value: 2 }]);
    expect(b.runs).toEqual([{ collector: "hyperliquid", startedAt: "2026-10-17T12:00:00.000Z", finishedAt: "2026-10-17T12:00:05.000Z", ok: true, error: null }]);
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });
});

describe("flushBatch", () => {
  test("writes everything, data before bookkeeping, and spills nothing", async () => {
    const w = writer();
    const r = await flushBatch(filled(), w, 1_000);
    expect(w.calls).toEqual(["series", "obs:2", "snapshots", "runs"]);
    expect(r.written).toEqual({ observations: 2, snapshots: 1, stops: 0, runs: 1 });
    expect(r.errors).toEqual([]);
    expect(batchSize(r.spill)).toBe(0);
    expect(r.spill.since).toBeUndefined();
  });

  test("a failed series write spills its observations (FK) but not the independent tables", async () => {
    const r = await flushBatch(filled(), writer({ ensureSeries: async () => Promise.reject(new Error("boom")) }), 1_000);
    expect(r.spill.observations).toHaveLength(2);
    expect(r.spill.series.map((s) => s.id)).toEqual(["a", "b"]);
    expect(r.written.snapshots).toBe(1);
    expect(r.errors).toEqual(["series: boom"]);
    expect(r.spill.since).toBeDefined();
  });

  test("a spill keeps the time it was first spilled, not its rows' (days-old FRED dates must not trip the alarm)", async () => {
    const replay = { ...filled(), since: "2026-10-17T06:00:00.000Z" };
    const r = await flushBatch(replay, writer({ insertSnapshots: async () => Promise.reject(new Error("down")) }), 1_000, () => Date.parse("2026-10-17T12:00:00Z"));
    expect(r.spill.since).toBe("2026-10-17T06:00:00.000Z");
    const fresh = await flushBatch({ ...filled(), observations: [{ seriesId: "a", ts: "2026-10-14T00:00:00.000Z", value: 4 }] }, writer({ ensureSeries: async () => Promise.reject(new Error("down")) }), 1_000, () => Date.parse("2026-10-17T12:00:00Z"));
    expect(fresh.spill.since).toBe("2026-10-17T12:00:00.000Z");
  });

  test("stops waiting at the budget and spills the in-flight and unstarted writes", async () => {
    const hang = () => new Promise<never>(() => {});
    const t0 = Date.now();
    const r = await flushBatch(filled(), writer({ upsertObservations: hang }), 50);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.spill.observations).toHaveLength(2);
    expect(r.spill.snapshots).toHaveLength(1);
    expect(r.spill.runs).toHaveLength(1);
    expect(r.errors).toEqual(["observations: flush budget spent", "snapshots: flush budget spent", "collector_runs: flush budget spent"]);
  });
});

describe("mergeBatches / capBatch", () => {
  test("the newer batch wins on the same point; distinct points are kept", () => {
    const older = { ...emptyBatch(), observations: [{ seriesId: "a", ts: "2026-10-17T12:00:00Z", value: 1 }, { seriesId: "a", ts: "2026-10-17T11:45:00Z", value: 5 }] };
    const newer = { ...emptyBatch(), observations: [{ seriesId: "a", ts: "2026-10-17T12:00:00.000Z", value: 2 }] };
    expect(mergeBatches(older, newer).observations).toEqual([
      { seriesId: "a", ts: "2026-10-17T12:00:00.000Z", value: 2 },
      { seriesId: "a", ts: "2026-10-17T11:45:00Z", value: 5 },
    ]);
  });

  test("keeps the newest rows and the series they reference", () => {
    const b = {
      ...emptyBatch(),
      series: [{ id: "old" }, { id: "new" }],
      observations: [{ seriesId: "old", ts: "2026-10-16T00:00:00Z", value: 1 }, { seriesId: "new", ts: "2026-10-17T00:00:00Z", value: 2 }],
    };
    const capped = capBatch(b, { observations: 1, snapshots: 1, stops: 1, runs: 1 });
    expect(capped.observations.map((o) => o.seriesId)).toEqual(["new"]);
    expect(capped.series).toEqual([{ id: "new" }]);
  });
});
