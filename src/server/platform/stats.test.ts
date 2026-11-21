import { describe, expect, test } from "bun:test";
import { evidenceLine, groupStats, setupTradeStats } from "./stats.js";
import { SCORE_VERSION } from "./score.js";
import type { OutcomeRow } from "./store.js";

let seq = 0; // default: each row in its own 2-day-apart bucket
const row = (netReturn: number, o: Partial<OutcomeRow> = {}): OutcomeRow => ({
  opportunityId: crypto.randomUUID(), setupKind: "squeeze", regime: "trend", scoreVersion: SCORE_VERSION, liquidityTier: 1, horizon: "1h", createdAtMs: seq++ * 2 * 86_400_000, grossReturn: netReturn, netReturn, hasCosts: true, ...o,
});

describe("groupStats", () => {
  test("rows without a cost breakdown are excluded", () => {
    const [s] = groupStats([row(0.01), row(0.5, { hasCosts: false })]);
    expect(s.n).toBe(1);
    expect(s.meanNet).toBeCloseTo(0.01, 12);
  });
  test("n >= 5: hitRate, mean and t-interval (df 4, t = 2.776)", () => {
    const [s] = groupStats([0.01, 0.02, 0.03, 0.04, 0.05].map((x) => row(x)));
    // mean .03, sd = sqrt(2.5e-4) = .0158114, half-width = 2.776 * .0158114 / sqrt(5) = .019630
    expect(s.n).toBe(5);
    expect(s.hitRate).toBe(1);
    expect(s.meanNet).toBeCloseTo(0.03, 12);
    expect(s.ci95![0]).toBeCloseTo(0.03 - 0.01963, 4);
    expect(s.ci95![1]).toBeCloseTo(0.03 + 0.01963, 4);
    expect(s.regime).toBeNull();
    expect(s.tier).toBeNull();
  });
  test("n < 5 has no interval; hit means net > 0 strictly", () => {
    const [s] = groupStats([row(0.02), row(0), row(-0.01), row(0.01)]);
    expect(s.n).toBe(4);
    expect(s.hitRate).toBe(0.5);
    expect(s.meanNet).toBeCloseTo(0.005, 12);
    expect(s.ci95).toBeNull();
  });
  test("20 outcomes on one UTC day are 1 cluster: no interval; clusters count buckets", () => {
    const day = Date.UTC(2026, 0, 5);
    const [s] = groupStats(Array.from({ length: 20 }, (_, i) => row(i % 2 ? 0.02 : 0.04, { createdAtMs: day + i * 3_600_000 })));
    expect(s.n).toBe(20);
    expect(s.clusters).toBe(1);
    expect(s.meanNet).toBeCloseTo(0.03, 12);
    expect(s.ci95).toBeNull();
  });
  test("interval runs over cluster means; the bucket is max(1 day, horizon)", () => {
    const day = Date.UTC(2026, 0, 5);
    // 5 days, 2 rows each with mean .01..05: interval equals the unclustered 5-point case
    const rows = [1, 2, 3, 4, 5].flatMap((d) => [row(d / 100 - 0.005, { createdAtMs: day + d * 86_400_000 }), row(d / 100 + 0.005, { createdAtMs: day + d * 86_400_000 + 1000 })]);
    const [s] = groupStats(rows);
    expect(s.n).toBe(10);
    expect(s.clusters).toBe(5);
    expect(s.ci95![1]).toBeCloseTo(0.03 + 0.01963, 4);
    // a 3-day horizon buckets 3 days together: days 1..5 -> buckets 6819,6820,6820,6820,6821
    expect(groupStats(rows.map((r) => ({ ...r, horizon: "72h" })))[0]!.clusters).toBe(3);
  });
  test("df above 30 uses 1.96", () => {
    const xs = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.01 : -0.01)); // mean 0, sd = .01 * sqrt(40/39)
    const [s] = groupStats(xs.map((x) => row(x)));
    const h = (1.96 * 0.01 * Math.sqrt(40 / 39)) / Math.sqrt(40);
    expect(s.ci95![1]).toBeCloseTo(h, 10);
  });
  test("groups by setupKind and horizon; regime and tier only when asked", () => {
    const rows = [row(0.01), row(0.03, { horizon: "4h" }), row(0.05, { setupKind: "fade" }), row(0.07, { regime: "chop", liquidityTier: 3 })];
    expect(groupStats(rows)).toHaveLength(3);
    const split = groupStats(rows, { regime: true, tier: true });
    expect(split).toHaveLength(4);
    expect(split.find((s) => s.regime === "chop")!.tier).toBe(3);
  });
  test("by regime, only current-score-version rows count; without regime, every version pools", () => {
    const rows = [row(0.01, { regime: "range" }), row(0.02, { regime: "range", scoreVersion: "score-v1" }), row(0.03, { regime: "new_longs", scoreVersion: "score-v1" })];
    expect(groupStats(rows, { regime: true }).map((s) => [s.regime, s.n])).toEqual([["range", 1]]);
    expect(groupStats(rows).map((s) => s.n)).toEqual([3]);
    expect(groupStats(rows, { tier: true }).map((s) => s.n)).toEqual([3]);
  });
  test("ungraded rows are counted beside the numbers, never in them; a group of only those has n 0 and null numbers", () => {
    const lost = (o: Partial<OutcomeRow> = {}) => row(NaN, { ungraded: "no_candles", ...o });
    const [s, only] = groupStats([row(0.01), row(0.03), lost(), lost({ hasCosts: false }), lost({ horizon: "4h" })]);
    expect(s).toMatchObject({ n: 2, ungraded: 1, hitRate: 1 });
    expect(s!.meanNet).toBeCloseTo(0.02, 12);
    expect(only).toMatchObject({ horizon: "4h", n: 0, clusters: 0, ungraded: 1, hitRate: null, meanNet: null, ci95: null, trade: null });
    expect(evidenceLine(s!, "unvalidated", "1h")).toBe("ledger 1h hold (no stop/target): n 2 \u00b7 2 clusters \u00b7 +2.00% \u00b7 1 ungraded \u00b7 edge unvalidated");
    expect(evidenceLine(only!, "unvalidated", "4h")).toBe("ledger 4h hold (no stop/target): n 0 \u00b7 0 clusters \u00b7 1 ungraded \u00b7 edge unvalidated");
  });
  test("non-finite returns are skipped; empty input is empty", () => {
    expect(groupStats([row(NaN)])).toEqual([]);
    expect(groupStats([])).toEqual([]);
  });
});

describe("stop/target trade stat", () => {
  const trade = (r: number, exit: "stop" | "target" | "horizon" = r > 0 ? "target" : "stop", ambiguous = false) =>
    ({ exit, exitPx: 1, exitAt: "2026-01-01T00:00:00.000Z", stopPx: 1, targetPx: 1, grossReturn: r / 50, netReturn: r / 50, r, ambiguous });
  test("a separate stat beside the fixed-horizon one: R over cluster means, exits counted, null without trades", () => {
    const rs = [-1, -1, 2, 2, 0.5].map((r, i) => row(0.01, { horizon: "72h", createdAtMs: i * 6 * 86_400_000, trade: trade(r, i === 4 ? "horizon" : undefined, i === 0) }));
    const [s, h1] = groupStats([...rs, row(0.01, { horizon: "72h", createdAtMs: 60 * 86_400_000 }), row(0.02)]);
    expect(s).toMatchObject({ horizon: "72h", n: 6, hitRate: 1 }); // hold-to-horizon: every row won
    expect(s!.trade).toMatchObject({ n: 5, clusters: 5, hitRate: 0.6, stops: 2, targets: 2, timeouts: 1, ambiguous: 1 });
    expect(s!.trade!.meanR).toBeCloseTo(0.5, 12);
    expect(s!.trade!.meanNet).toBeCloseTo(0.01, 12);
    expect(s!.trade!.ci95).not.toBeNull();
    expect(h1!.trade).toBeNull();
    expect(groupStats(rs.slice(0, 4))[0]!.trade!.ci95).toBeNull(); // under 5 clusters
    expect(setupTradeStats("squeeze", rs)).toMatchObject({ horizon: "72h", trade: { n: 5 } });
    expect(setupTradeStats("squeeze", [row(0.01)])).toBeNull();
  });
  test("the evidence line names both: the hold and the trade as ticketed", () => {
    const rs = [-1, -1, 2, 2, 0.5].map((r, i) => row(0.01, { horizon: "72h", createdAtMs: i * 6 * 86_400_000, trade: trade(r, i === 4 ? "horizon" : undefined) }));
    expect(evidenceLine(null, "unvalidated", "24h", setupTradeStats("squeeze", rs))).toBe(
      "ledger 24h hold (no stop/target): n 0 \u00b7 0 clusters \u00b7 edge unvalidated\nledger stop/target (72h max): n 5 \u00b7 5 clusters \u00b7 +0.50R (\u22121.4\u2026+2.4) \u00b7 2 stop / 2 target / 1 time",
    );
  });
});

describe("evidenceLine", () => {
  test("full line with interval", () => {
    const [s] = groupStats([0.01, 0.02, 0.03, 0.04, 0.05].map((x) => row(x, { horizon: "24h" })));
    expect(evidenceLine(s!, "ledger")).toBe("ledger 24h hold (no stop/target): n 5 \u00b7 5 clusters \u00b7 +3.00% (+1.0\u2026+5.0) \u00b7 edge ledger");
  });
  test("null interval below 5 clusters, negative mean uses a minus sign", () => {
    const [s] = groupStats([row(-0.012), row(-0.004)]);
    expect(evidenceLine(s!, "unvalidated", "4h")).toBe("ledger 4h hold (no stop/target): n 2 \u00b7 2 clusters \u00b7 \u2212" + "0.80% \u00b7 edge unvalidated");
  });
  test("no stats", () => {
    expect(evidenceLine(null, "unvalidated")).toBe("ledger 24h hold (no stop/target): n 0 \u00b7 0 clusters \u00b7 edge unvalidated");
  });
});
