import { describe, expect, test } from "bun:test";
import { journalTrips, postmortemFacts, unreviewed } from "./review.js";
import type { Setup } from "./schema.js";

const H = 3_600_000;
const T0 = Date.parse("2026-10-10T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// Long: entry 100–102 (mid 101), invalidation 96 (risk 5 = 4.95%), target 111.
function setup(over: Partial<Setup> = {}): Setup {
  return {
    id: "BTC-long-20261010-1",
    setup_id: "htf_pullback",
    levels_source: "menu",
    asset: "BTC",
    direction: "long",
    horizon: "swing",
    timeframe: "1d",
    thesis: "t",
    regime_alignment: "with",
    trigger: "x",
    entry: { low: 100, high: 102 },
    invalidation: 96,
    invalidation_reason: "r",
    targets: [111],
    rr: 2,
    conviction: "medium",
    evidence: ["e"],
    status: "target_hit",
    status_note: null,
    r_result: 2,
    triggered_at: iso(T0 + H),
    created_at: iso(T0),
    updated_at: iso(T0 + 4 * H),
    expires_at: iso(T0 + 10 * 24 * H),
    ...over,
  };
}
const bar = (i: number, h: number, l: number) => ({ t: T0 + i * H, h, l });

describe("postmortem facts", () => {
  test("excursions in R from the entry midpoint, only while triggered", () => {
    // Dips to 98.5 (−0.5R), runs to 111 (+2R); the bar after close is ignored.
    const f = postmortemFacts(setup(), [bar(1, 102, 98.5), bar(2, 106, 101), bar(3, 111, 105), bar(5, 130, 90)], new Date(T0 + 48 * H));
    expect(f).toMatchObject({ id: "BTC-long-20261010-1", status: "target_hit", r: 2, maeR: 0.5, mfeR: 2 });
  });

  test("short direction flips the sides", () => {
    // Short: entry 98–100 (mid 99), invalidation 104 (risk 5). High 101.5 = −0.5R, low 94 = +1R.
    const f = postmortemFacts(setup({ direction: "short", entry: { low: 98, high: 100 }, invalidation: 104 }), [bar(1, 101.5, 94)], new Date(T0 + 48 * H));
    expect(f.maeR).toBe(0.5);
    expect(f.mfeR).toBe(1);
  });

  test("never triggered → no excursions", () => {
    const f = postmortemFacts(setup({ status: "expired", triggered_at: null, r_result: null }), [bar(1, 120, 80)], new Date(T0 + 48 * H));
    expect(f.maeR).toBeNull();
    expect(f.mfeR).toBeNull();
  });

  test("unreviewed skips setups already named in a post-mortem", () => {
    const a = setup(), b = setup({ id: "ETH-short-20261011-1" });
    expect(unreviewed([a, b], "### BTC-long-20261010-1 · htf_pullback").map((s) => s.id)).toEqual(["ETH-short-20261011-1"]);
  });
});

describe("journal trips", () => {
  const fill = (tid: number, time: number, dir: string, px: number, closedPnl = 0) => ({ coin: "BTC", px: String(px), sz: "1", time, dir, closedPnl: String(closedPnl), fee: "0.1", tid });

  test("round trips from fills; recent = closed within the window", () => {
    const now = new Date(T0 + 20 * 24 * H);
    const raw = [
      fill(1, T0, "Open Long", 100),
      fill(2, T0 + H, "Close Long", 110, 10), // closed 20 days ago: not recent
      fill(3, now.getTime() - 2 * 24 * H, "Open Short", 120),
      fill(4, now.getTime() - 24 * H, "Close Short", 115, 5),
      { coin: "BTC", dir: "Settlement" }, // unparseable rows are counted, not thrown
    ];
    const j = journalTrips(raw, now, 7);
    expect(j.trips).toHaveLength(2);
    expect(j.recent.map((t) => t.side)).toEqual(["short"]);
    expect(j.skipped).toBe(1);
  });
});
