import { describe, expect, test } from "bun:test";
import type { EdgeType, FeedbackBucket } from "../../shared/intel.js";
import { feedbackReport, suggestAdjustment, worstBuckets } from "./feedback.js";
import { MemoryIntelStore } from "./store.js";

const T0 = Date.parse("2026-10-13T12:00:00Z");
const DAY = 86_400_000;

const bucket = (eventType: string | null, edgeType: EdgeType | null, hops: number, up: number, down: number): FeedbackBucket => ({
  eventType,
  edgeType,
  hops,
  up,
  down,
  total: up + down,
});

describe("worstBuckets / suggestAdjustment", () => {
  test("keeps net-negative buckets, worst share first, then more votes", () => {
    const worst = worstBuckets([
      bucket("exploit", "collateral", 1, 3, 1),
      bucket("governance", "narrative", 2, 0, 2),
      bucket("depeg", "depends_on_stable", 1, 1, 4),
      bucket("listing", null, 0, 0, 6),
      bucket("macro", "macro_beta", 1, 2, 2),
    ]);
    expect(worst.map((b) => b.eventType)).toEqual(["listing", "governance", "depeg"]);
  });

  test("code-written suggestions by hop depth and edge type", () => {
    expect(suggestAdjustment(bucket("governance", "narrative", 2, 0, 6))).toBe("drop hop-2 narrative edges for governance events. Pushes here are already batched (net ≤ -60%).");
    expect(suggestAdjustment(bucket("exploit", "bridge", 2, 1, 2))).toBe("limit exploit events to 1-hop paths through bridge edges (only 3 votes: watch before changing).");
    expect(suggestAdjustment(bucket("depeg", "depends_on_stable", 1, 2, 4), 0.35)).toBe(
      "lower the depends_on_stable edge weight (now 0.6) for depeg events, or raise INTEL_PUSH_MATERIALITY (now 0.35).",
    );
    expect(suggestAdjustment(bucket(null, null, 0, 0, 1))).toBe(
      "unclassified events that name a held/watched asset directly are rated noise: lower their extracted magnitude or raise INTEL_PUSH_MATERIALITY (only 1 vote: watch before changing).",
    );
  });
});

describe("feedbackReport", () => {
  test("stores a feedback_weekly report over the last 7 days of alerts", async () => {
    let t = T0 - 10 * DAY;
    const store = new MemoryIntelStore(() => new Date(t));
    const alert = async (ref: string, eventType: string, edgeType: EdgeType | null, hops: number, vote: 1 | -1 | null) => {
      const a = await store.insertAlert({
        kind: "mapper", ref, window: null, asset: "SOL", title: "t", eventType, line: { tag: "hypothesis", text: "x" },
        path: [], edgeType, hops, pathWeight: 1, sources: [], materiality: 0.5, pricedIn: null, route: "push",
      });
      if (vote) await store.setAlertFeedback(a!.id, vote);
    };
    await alert("old", "listing", null, 0, -1); // 10 days ago: outside the week
    t = T0 - DAY;
    await alert("g1", "governance", "narrative", 2, -1);
    await alert("g2", "governance", "narrative", 2, -1);
    await alert("e1", "exploit", "collateral", 1, 1);
    await alert("e2", "exploit", "collateral", 1, null);
    t = T0;

    const r = await feedbackReport({ store, now: () => new Date(T0), pushMateriality: 0.35 });
    expect(r.kind).toBe("feedback_weekly");
    expect(r.buckets).toEqual([
      {
        eventType: "governance",
        edgeType: "narrative",
        hops: 2,
        up: 0,
        down: 2,
        total: 2,
        suggestion: "drop hop-2 narrative edges for governance events (only 2 votes: watch before changing).",
      },
    ]);
    expect(await store.latestReport("feedback_weekly")).toEqual(r);
  });
});
