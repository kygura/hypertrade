import { describe, expect, test } from "bun:test";
import { gateProposals, makeSetupId, type GateContext } from "./gate.js";
import type { HtfView, Setup, SetupProposal } from "./schema.js";

const now = new Date("2026-10-18T12:00:00Z");
const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();
const view = { stance: "trend_long", regime: "risk_on" } as HtfView;

// Long BTC: entry 80,000–81,000 (mid 80,500), invalidation 78,000 (3.1%), target 86,000 (2.2R).
const good = (over: Partial<SetupProposal> = {}): SetupProposal => ({
  asset: "BTC",
  direction: "long",
  horizon: "swing",
  thesis: "holds the True Market Mean",
  regime_alignment: "with",
  trigger: "daily close back above 81,000",
  entry: { low: 80_000, high: 81_000 },
  invalidation: 78_000,
  invalidation_reason: "daily close below the STH cost basis",
  targets: [86_000, 90_000],
  conviction: "medium",
  evidence: ["htf.BTC.sma200d"],
  expires_at: inDays(10),
  ...over,
});
const goodShort = (over: Partial<SetupProposal> = {}): SetupProposal =>
  good({ asset: "ETH", direction: "short", entry: { low: 2400, high: 2440 }, invalidation: 2500, targets: [2250, 2100], ...over });

const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  mode: "pulse",
  now,
  marks: new Map([
    ["BTC", 82_000],
    ["ETH", 2420],
    ["SOL", 104],
  ]),
  open: [],
  usedIds: new Set(),
  htf: view,
  ...over,
});
const openSetup = (over: Partial<Setup>): Setup => ({ ...(good() as unknown as Setup), id: "x", rr: 2, status: "watching", status_note: null, r_result: null, created_at: "", updated_at: "", ...over });

const rule = (p: SetupProposal, c: GateContext = ctx()) => gateProposals([p], c).rejected[0]?.rule ?? null;

describe("gate", () => {
  test("a good long and a good short pass; rr and id are computed by code", () => {
    const { accepted, rejected } = gateProposals([good(), goodShort()], ctx());
    expect(rejected).toEqual([]);
    expect(accepted.map((s) => s.id)).toEqual(["BTC-long-20261018-1", "ETH-short-20261018-1"]);
    expect(accepted[0]).toMatchObject({ status: "watching", rr: 2.2, r_result: null, created_at: now.toISOString() });
    expect(accepted[1]!.rr).toBe(2.13); // mid 2420, risk 80, gain 170
  });

  test("each rule rejects its crafted bad proposal", () => {
    expect(rule(good({ asset: "NOPE" }))).toBe("unknown_asset");
    expect(rule(good({ asset: "btc" }))).toBe("unknown_asset"); // case-sensitive
    expect(rule(good({ invalidation: 80_500 }))).toBe("levels_order");
    expect(rule(good({ targets: [90_000, 86_000] }))).toBe("levels_order");
    expect(rule(goodShort({ targets: [2100, 2250] }))).toBe("levels_order");
    expect(rule(good({ invalidation: 77_000, entry: { low: 82_500, high: 83_000 }, targets: [95_000] }), ctx({ marks: new Map([["BTC", 76_000]]) }))).toBe("already_invalid");
    expect(rule(good({ entry: { low: 78_500, high: 82_000 }, invalidation: 77_000, targets: [95_000] }))).toBe("zone_width");
    expect(rule(good({ invalidation: 79_900, targets: [86_000] }))).toBe("invalidation_distance"); // 0.75%
    expect(rule(good({ invalidation: 50_000, targets: [200_000] }))).toBe("invalidation_distance"); // 38%
    expect(rule(good({ targets: [84_000] }))).toBe("rr"); // 1.4R
    expect(rule(good({ expires_at: inDays(15) }))).toBe("expiry");
    expect(rule(good({ horizon: "position", expires_at: inDays(40) }))).toBeNull();
    expect(rule(good({ horizon: "position", expires_at: inDays(46) }))).toBe("expiry");
    expect(rule(good({ expires_at: inDays(-1) }))).toBe("expiry");
    expect(rule(good({ expires_at: "soon" }))).toBe("expiry");
    expect(rule(good(), ctx({ open: [openSetup({ asset: "BTC", direction: "long" })] }))).toBe("duplicate");
    expect(rule(good({ regime_alignment: "counter", conviction: "medium" }))).toBe("counter_conviction");
    expect(rule(good({ regime_alignment: "counter", conviction: "low" }), ctx({ open: [openSetup({ asset: "SOL", regime_alignment: "counter" })] }))).toBe("counter_cap");
    expect(rule(good({ regime_alignment: "counter", conviction: "low" }))).toBeNull();
    expect(rule(good(), ctx({ htf: { ...view, stance: "stand_aside" } }))).toBe("htf_stand_aside");
    expect(rule(good(), ctx({ htf: null }))).toBe("htf_missing");
  });

  test("caps: new per mode, open total, duplicates within one batch", () => {
    const sol = good({ asset: "SOL", entry: { low: 100, high: 102 }, invalidation: 96, targets: [115] });
    const three = gateProposals([good(), goodShort(), sol], ctx());
    expect(three.accepted).toHaveLength(2);
    expect(three.rejected[0]!.rule).toBe("cap_new");
    expect(gateProposals([good(), goodShort(), sol], ctx({ mode: "daily" })).accepted).toHaveLength(3);
    expect(gateProposals([good()], ctx({ mode: "htf" })).rejected[0]!.rule).toBe("cap_new");
    const five = ["A", "B", "C", "D", "E"].map((a) => openSetup({ asset: a }));
    expect(rule(good(), ctx({ open: five }))).toBe("cap_open");
    expect(gateProposals([good(), good()], ctx()).rejected[0]!.rule).toBe("duplicate");
  });

  test("ids never collide with used ones", () => {
    expect(makeSetupId("BTC", "long", now, new Set(["BTC-long-20261018-1"]))).toBe("BTC-long-20261018-2");
  });
});
