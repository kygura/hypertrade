import { describe, expect, test } from "bun:test";
import { payloadNumbers } from "../intel/numbers.js";
import { gateProposals } from "./gate.js";
import { checkWatchlist, resolveDraft, unanswered } from "./scan.js";
import type { SetupDraft, WatchItem } from "./schema.js";
import { row } from "./tripwires.test.js";

const NOW = new Date("2026-10-23T12:00:00Z");
const DAY = 86_400_000;

// Levels: mark 100, 1d.sma20 98, 1d.low20 90, 1d.high20 110, 4h.high20 104; 1d ATR 4, 4h ATR 1.5.
const sol = row("SOL", { tf: { "4h": { atr: 1.5 } } });
const shown = payloadNumbers(JSON.stringify(sol));

const long = (over: Partial<SetupDraft> = {}): SetupDraft => ({
  asset: "SOL",
  direction: "long",
  template: "htf_pullback",
  timeframe: "1d",
  imbalance: "shorts_pressing",
  thesis: "Funding 10.95% annualised sits at neutral while the mark holds 100 above the 1d SMA20 at 98; the other side sees a range top at 110.",
  trigger: "1d close holding above 98 after a test of the zone",
  entry: { low: { level: "1d.sma20" }, high: { level: "mark" } },
  invalidation: { level: "1d.low20", atr: 0.5 },
  invalidation_reason: "losing the 1d range low plus half an ATR breaks the pullback read",
  targets: [{ level: "R", r: 2 }, { level: "1d.high20", atr: 1 }],
  conviction: "medium",
  evidence: ["SOL.tf.1d.sma20", "SOL.pos.fundingAnnPct"],
  ...over,
});

describe("resolveDraft", () => {
  test("level keys and ATR offsets become prices; R targets are measured from the entry midpoint; code sets expiry and alignment", () => {
    const r = resolveDraft(long(), sol, NOW, shown);
    if (!r.ok) throw new Error(r.detail);
    expect(r.proposal).toMatchObject({
      entry: { low: 98, high: 100 },
      invalidation: 92, // 90 + 0.5 × 4
      targets: [113, 114], // mid 99 + 2 × 7; 110 + 1 × 4
      regime_alignment: "with",
      conviction: "medium",
      setup_id: "htf_pullback",
      timeframe: "1d",
      levels_source: "menu",
      expires_at: new Date(NOW.getTime() + 7 * DAY).toISOString(),
    });
    // The gate takes it from there: rr from code, the template and timeframe ride along.
    const { accepted } = gateProposals([r.proposal], { mode: "scan", now: NOW, marks: new Map([["SOL", 100]]), open: [], usedIds: new Set(), htf: null });
    expect(accepted[0]).toMatchObject({ id: "SOL-long-20261023-1", rr: 2, setup_id: "htf_pullback", timeframe: "1d", levels_source: "menu", status: "watching" });
  });

  test("a 4h plan uses the 4h ATR and expires in 3 days; against the weekly trend it is counter and capped at low conviction", () => {
    const up = row("SOL", { tf: { "4h": { atr: 1.5 }, "1w": { trend: "up" } } });
    const r = resolveDraft(
      long({
        direction: "short",
        timeframe: "4h",
        template: "failed_breakout",
        thesis: "A sweep of 104 with funding at 10.95% annualised; the other side sees a weekly uptrend.",
        trigger: "4h close back below 104",
        entry: { low: { level: "4h.high20", atr: -0.5 }, high: { level: "4h.high20" } },
        invalidation: { level: "4h.high20", atr: 1 },
        targets: [{ level: "R", r: 2 }],
      }),
      up,
      NOW,
      payloadNumbers(JSON.stringify(up)),
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.proposal).toMatchObject({ entry: { low: 103.25, high: 104 }, invalidation: 105.5, targets: [99.875], regime_alignment: "counter", conviction: "low" });
    expect(r.proposal.expires_at).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
    expect(r.notes[0]).toContain("conviction capped at low");
  });

  test("a level the market does not have, an unknown market and a number not on the board are dropped with the rule", () => {
    const fails = (d: SetupDraft) => {
      const x = resolveDraft(d, d.asset === "SOL" ? sol : undefined, NOW, shown);
      return x.ok ? null : x.rule;
    };
    expect(fails(long({ invalidation: { level: "1d.sma200" } }))).toBe("level_missing");
    expect(fails(long({ asset: "NOPE" }))).toBe("unknown_asset");
    expect(fails(long({ thesis: "Funding at 77.7% annualised is extreme." }))).toBe("unbacked_number");
    // A trigger may name the price its own zone resolved to (92 is the resolved invalidation, not a board number).
    expect(fails(long({ trigger: "1d close above 98, invalidation at 92" }))).toBeNull();
  });
});

describe("watchlist and tripwire accountability", () => {
  const item = (over: Partial<WatchItem> = {}): WatchItem => ({
    asset: "SOL",
    kind: "crowded_longs",
    skew: "down",
    timeframe: "1d",
    note: "Funding 10.95% annualised with the mark at 100",
    arms: "a 1d close below 98",
    evidence: ["SOL.pos.fundingAnnPct"],
    ...over,
  });

  test("items off the board or citing numbers it does not carry are dropped", () => {
    const board = new Map([["SOL", sol]]);
    const { kept, dropped } = checkWatchlist([item(), item({ asset: "DOGE" }), item({ note: "OI up 37.3% in a day" })], board, shown);
    expect(kept).toHaveLength(1);
    expect(dropped).toEqual(["DOGE: not on the board", "SOL crowded_longs: cites a number that is not on the board"]);
  });

  test("a hit is answered by a setup or a pass; anything else is listed", () => {
    const hits = [
      { asset: "SOL", setup_id: "htf_pullback" as const, direction: "long" },
      { asset: "HYPE", setup_id: "funding_fade" as const, direction: "short" },
      { asset: "ZEC", setup_id: "range_breakout" as const, direction: "long" },
    ];
    const scan = { setups: [long()], passes: [{ asset: "HYPE", template: "funding_fade" as const, direction: "short" as const, reason: "unlock on Friday" }] };
    expect(unanswered(hits, scan)).toEqual(["ZEC|range_breakout|long"]);
  });
});
