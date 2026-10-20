import { describe, expect, test } from "bun:test";
import type { Candle } from "../../shared/types.js";
import { advanceSetup, cancelSetup, CLOSED_RETENTION_MS, ledgerStats, rMultiple, settleLedger } from "./ledger.js";
import type { Setup } from "./schema.js";

const H = 3_600_000;
const T0 = Date.parse("2026-10-10T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

// Long: entry 100–102 (mid 101), invalidation 96 (risk 5), targets 111 / 120.
function setup(over: Partial<Setup> = {}): Setup {
  return {
    id: "BTC-long-20261010-1",
    setup_id: null,
    levels_source: "model",
    asset: "BTC",
    direction: "long",
    horizon: "swing",
    thesis: "t",
    regime_alignment: "with",
    trigger: "x",
    entry: { low: 100, high: 102 },
    invalidation: 96,
    invalidation_reason: "r",
    targets: [111, 120],
    rr: 2,
    conviction: "medium",
    evidence: ["e"],
    status: "watching",
    status_note: null,
    r_result: null,
    triggered_at: null,
    created_at: iso(T0),
    updated_at: iso(T0),
    expires_at: iso(T0 + 10 * 24 * H),
    ...over,
  };
}
const short = (over: Partial<Setup> = {}) => setup({ id: "ETH-short-1", direction: "short", entry: { low: 98, high: 100 }, invalidation: 104, targets: [89], ...over });

/** Hourly candles from [o, h, l, c] tuples starting one hour after T0. */
const path = (...bars: Array<[number, number, number, number]>): Candle[] => bars.map(([o, h, l, c], i) => ({ t: T0 + (i + 1) * H, T: T0 + (i + 2) * H - 1, o, h, l, c, v: 1 }));
const now = new Date(T0 + 48 * H);

describe("advanceSetup", () => {
  test("R from the entry midpoint", () => {
    expect(rMultiple(setup(), 111)).toBe(2);
    expect(rMultiple(setup(), 96)).toBe(-1);
    expect(rMultiple(short(), 89)).toBe(2); // mid 99, risk 5, gain 10
  });

  test("watching → triggered when price trades into the zone; target not counted on the trigger candle", () => {
    const s = advanceSetup(setup(), path([105, 112, 101, 104]), now);
    expect(s.status).toBe("triggered");
    expect(s.triggered_at).toBe(iso(T0 + H));
    expect(s.r_result).toBeNull();
    expect(s.updated_at).toBe(now.toISOString());
  });

  test("triggered → target_hit records R", () => {
    const s = advanceSetup(setup(), path([105, 106, 101, 104], [104, 112, 103, 110]), now);
    expect(s).toMatchObject({ status: "target_hit", r_result: 2, triggered_at: iso(T0 + H) });
    expect(s.status_note).toContain("first target 111");
  });

  test("triggered → invalidated is −1R; same candle touching invalidation and target → invalidation wins", () => {
    expect(advanceSetup(setup(), path([105, 106, 101, 104], [103, 104, 95, 97]), now)).toMatchObject({ status: "invalidated", r_result: -1 });
    const both = advanceSetup(setup({ status: "triggered" }), path([104, 115, 95, 110]), now);
    expect(both).toMatchObject({ status: "invalidated", r_result: -1 });
    const shortBoth = advanceSetup(short({ status: "triggered" }), path([99, 105, 88, 95]), now);
    expect(shortBoth).toMatchObject({ status: "invalidated", r_result: -1 });
  });

  test("never filled: price below the zone reaches invalidation first", () => {
    // Breakout-style long with price under the zone: falls to invalidation without touching 100.
    const s = advanceSetup(setup(), path([98, 99, 97, 98], [98, 98.5, 95, 96]), now);
    expect(s).toMatchObject({ status: "invalidated", r_result: null });
    expect(s.status_note).toContain("never filled");
    // A gap open beyond invalidation also never fills.
    expect(advanceSetup(setup(), path([95, 103, 94, 95]), now)).toMatchObject({ status: "invalidated", r_result: null });
  });

  test("watching: one candle through the zone and invalidation counts as filled and stopped", () => {
    const s = advanceSetup(setup(), path([105, 106, 95, 96]), now);
    expect(s).toMatchObject({ status: "invalidated", r_result: -1 });
    expect(s.status_note).toContain("same candle");
  });

  test("candles closed before updated_at or opened after expires_at are ignored", () => {
    const old = advanceSetup(setup({ updated_at: iso(T0 + 10 * H) }), path([105, 106, 101, 104]), now);
    expect(old.status).toBe("watching");
    const late = advanceSetup(setup({ expires_at: iso(T0 + H) }), path([105, 106, 101, 104]), now);
    expect(late).toMatchObject({ status: "expired", r_result: null });
  });

  test("expiry: watching expires without R; triggered is marked to the last close", () => {
    const exp = iso(T0 + 3 * H);
    expect(advanceSetup(setup({ expires_at: exp }), path([105, 106, 103, 104]), now)).toMatchObject({ status: "expired", r_result: null });
    const trig = advanceSetup(setup({ expires_at: exp }), path([105, 106, 101, 104], [104, 105, 103, 106]), now);
    expect(trig).toMatchObject({ status: "expired", r_result: 1 }); // (106 − 101) / 5
  });

  test("closed setups are returned unchanged", () => {
    const done = setup({ status: "target_hit", r_result: 2 });
    expect(advanceSetup(done, path([90, 130, 80, 100]), now)).toBe(done);
  });

  test("cancel marks a triggered setup to the mark, a watching one without R", () => {
    expect(cancelSetup(setup({ status: "triggered" }), "thesis broke", 98.5, now)).toMatchObject({ status: "cancelled", r_result: -0.5, status_note: "thesis broke" });
    expect(cancelSetup(setup(), "x", 98.5, now).r_result).toBeNull();
  });
});

describe("ledger settle and stats", () => {
  test("moves closed out of open, keeps 90 days, computes hit rate and avg R over triggered only", () => {
    const t = (id: string, status: Setup["status"], r: number | null, ageMs = 0) => setup({ id, status, r_result: r, updated_at: iso(now.getTime() - ageMs) });
    const l = settleLedger([t("a", "watching", null), t("b", "target_hit", 2), t("c", "invalidated", -1)], [t("d", "expired", null), t("old", "target_hit", 3, CLOSED_RETENTION_MS + H)], now);
    expect(l.open.map((s) => s.id)).toEqual(["a"]);
    expect(l.closed.map((s) => s.id).sort()).toEqual(["b", "c", "d"]);
    expect(l.stats).toEqual({ closed_90d: 3, triggered_90d: 2, hit_rate: 0.5, avg_r: 0.5 });
    // A setup that triggered but could not be marked still counts as triggered; avg R skips it.
    const unmarked = setup({ id: "e", status: "cancelled", r_result: null, triggered_at: iso(T0) });
    expect(ledgerStats([t("b", "target_hit", 2), unmarked])).toEqual({ closed_90d: 2, triggered_90d: 2, hit_rate: 0.5, avg_r: 2 });
    expect(ledgerStats([])).toEqual({ closed_90d: 0, triggered_90d: 0, hit_rate: null, avg_r: null });
  });
});
