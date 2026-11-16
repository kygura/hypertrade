import { describe, expect, test } from "bun:test";
import type { DeskPlanInput } from "../../shared/deskPlan.js";
import { loadDeskConfig } from "./config.js";
import type { Broker, ExecutionResult } from "./paper.js";
import { DeskService } from "./service.js";
import { makeService } from "./testkit.js";
import type { AccountState, OperatorOrder, Position, TradeProposal } from "./types.js";
import { tick } from "./watch.js";

// DeskService plans end to end on the paper venue (one entry at the mark), the cooldown a stop-out starts, and the
// watch tick's stop-out detection for a live venue (a position gone while the bars touched its stop).

const BY = "operator:plan";
const plan: DeskPlanInput = { coin: "eth", side: "long", rungs: [{ px: 4000, size: 0.1 }], stopPx: 3800, targetPx: 4500, note: "retest" };
const limits = loadDeskConfig({}).limits;

describe("plans on paper", () => {
  test("check writes nothing; the metrics are the plan's own", async () => {
    const { service, store } = makeService();
    const c = await service.checkPlan(plan);
    expect(c.blockers).toEqual([]);
    expect(c.metrics).toMatchObject({ totalSize: 0.1, notionalUsd: 400, avgEntryPx: 4000, lossAtStopUsd: 20, lossAtStopPct: 0.2, rrFull: 2.5, rrTopOnly: 2.5, dailyLimitUsedPct: 10, drawdownUsedPct: 2, markPx: 4000 });
    expect(await store.listPlans(5)).toEqual([]);
  });

  test("place:false journals the plan and places nothing", async () => {
    const { service, store } = makeService();
    const out = await service.submitPlan(plan, { place: false, by: BY });
    expect(out).toMatchObject({ placed: false, record: { source: "plan", venue: "paper", placed: false, placement: null, input: { coin: "ETH", note: "retest" } } });
    expect(await store.listPlans(5)).toHaveLength(1);
    expect(await store.listProposals({ limit: 5 })).toEqual([]);
  });

  test("place:true fills the plan's size at the mark through the governor, linked both ways", async () => {
    const { service, store } = makeService();
    const out = await service.submitPlan(plan, { place: true, by: BY });
    expect(out.placed).toBe(true);
    const [prop] = await store.listProposals({ limit: 5 });
    expect(prop).toMatchObject({ status: "executed", decidedBy: BY, proposal: { source: "plan", planId: out.record.id, coin: "ETH", stop: 3800, target: 4500, resolvedRiskPct: 0.2 }, verdict: { approved: true } });
    expect(out.record).toMatchObject({ placed: true, placement: { proposalId: prop!.id, status: "executed", error: null, dryRun: false } });
    expect(await store.getPlan(out.record.id)).toEqual(out.record);
    expect(await store.paperPositions()).toMatchObject([{ coin: "ETH", size: 0.1, stopPx: 3800, tpPx: 4500, proposalId: prop!.id }]);
  });

  test.each([
    ["a ladder (paper rests no limits)", { rungs: [{ px: 4000, size: 0.05 }, { px: 3900, size: 0.05 }] }, "cannot rest a 2-rung ladder"],
    ["a rung away from the mark", { rungs: [{ px: 3900, size: 0.1 }] }, "the rung at 3900.0 is 2.5% away"],
    ["a size off the venue's step", { rungs: [{ px: 4000, size: 0.105 }] }, "not a multiple of ETH's size step"],
    ["no target", { targetPx: null }, "no target"],
    ["an unlisted coin", { coin: "NOPE" }, "not a listed Hyperliquid perp"],
  ] as Array<[string, Partial<DeskPlanInput>, string]>)("refused, journaled, never placed: %s", async (_n, over, want) => {
    const { service, store } = makeService();
    const out = await service.submitPlan({ ...plan, ...over }, { place: true, by: BY });
    expect(out.placed).toBe(false);
    expect(out.check.blockers.join("|")).toContain(want);
    expect(out.record.blockers).toEqual(out.check.blockers);
    expect(await store.listProposals({ limit: 5 })).toEqual([]);
  });

  test("a plan the governor would shrink is blocked, never placed smaller", async () => {
    const { service } = makeService({ config: { limits: { ...limits, maxOpenRiskPct: 0.1 } } }); // 10 USD of room for a 20 USD stop
    const c = await service.checkPlan(plan);
    expect(c.blockers.join()).toContain("the governor would risk at most 10 USD here, the plan's stop loses 20 USD");
  });

  test("the governor's own refusals are the plan's blockers (the kill switch)", async () => {
    const { service } = makeService();
    await service.setKillSwitch(true, "test", "op");
    expect((await service.checkPlan(plan)).blockers).toContain("kill switch is on: no new entries");
  });
});

describe("a stop-out starts a cooldown every entry path respects", () => {
  const proposal: TradeProposal = {
    coin: "ETH", side: "long", setup: "breakout retest", thesis: "Spot-led rally with OI flat and funding neutral, retest held.", horizon: "swing", confidence: "medium",
    stop: 3800, target: 4500, riskPct: 0.5, invalidation: "close under 3850", evidence: [{ source: "a", point: "one" }, { source: "b", point: "two" }],
  };
  const order: OperatorOrder = { coin: "ETH", side: "long", stop: 3700, target: 4500, notionalUsd: 400, source: "copilot" };

  test("paper settle → ETH locked 4h with the plan as its journal entry; other coins open; two stop-outs lock everything", async () => {
    const t = { now: new Date("2026-10-05T12:00:00Z") };
    const { service, data, notifier } = makeService({ now: () => t.now });
    const placed = await service.submitPlan(plan, { place: true, by: BY });
    data.setMark("ETH", 3790);
    t.now = new Date("2026-10-05T12:15:00Z");
    const r = await tick(service, { runCycle: false });
    expect(r.settled).toMatchObject([{ coin: "ETH", kind: "stop" }]);
    expect(notifier.sent.find((a) => a.title === "ETH stopped out")!.body).toContain("New ETH entries locked until 16:15 UTC.");

    const cd = await service.cooldown();
    expect(cd).toMatchObject({ all: null, stopOutsToday: 1, coins: [{ coin: "ETH", until: "2026-10-05T16:15:00.000Z", ref: { source: "paper", planId: placed.record.id, fill: { px: 3800 } }, plan: { id: placed.record.id, placed: true } }] });

    data.setMark("ETH", 4000);
    expect((await service.checkPlan(plan)).blockers.join()).toContain("cooldown: ETH stopped out");
    expect((await service.submitOpen(proposal, null)).status).toBe("blocked");
    const pv = await service.previewOperatorOrder(order);
    expect(pv.verdict.reasons.join()).toContain("cooldown");
    expect((await service.submitOperatorOrder(order, pv, "operator:copilot")).status).toBe("blocked");
    expect((await service.placeOperatorOrder(order, "platform")).status).toBe("blocked");
    // Another coin is open.
    expect((await service.checkPlan({ ...plan, coin: "SOL", rungs: [{ px: 200, size: 1 }], stopPx: 190, targetPx: 230 })).blockers).toEqual([]);

    // Second stop-out today (SOL) → everything locked until 00:00 UTC.
    await service.submitPlan({ ...plan, coin: "SOL", rungs: [{ px: 200, size: 1 }], stopPx: 190, targetPx: 230 }, { place: true, by: BY });
    data.setMark("SOL", 189);
    t.now = new Date("2026-10-05T12:30:00Z");
    await tick(service, { runCycle: false });
    const all = await service.cooldown();
    expect(all.all).toEqual({ until: "2026-10-06T00:00:00.000Z", reason: "2 stop-outs today (ETH, SOL): no new entries until 00:00 UTC" });
    expect((await service.checkPlan({ ...plan, coin: "BTC", rungs: [{ px: 100_000, size: 0.002 }], stopPx: 98_000, targetPx: 105_000 })).blockers.join()).toContain("2 stop-outs today");
    // Past the reset, BTC is open again.
    t.now = new Date("2026-10-06T00:00:00Z");
    expect((await service.checkPlan({ ...plan, coin: "BTC", rungs: [{ px: 100_000, size: 0.002 }], stopPx: 98_000, targetPx: 105_000 })).blockers).toEqual([]);
  });

  test("a target hit is not a stop-out", async () => {
    const { service, data } = makeService();
    await service.submitPlan(plan, { place: true, by: BY });
    data.setMark("ETH", 4510);
    await tick(service, { runCycle: false });
    expect(await service.cooldown()).toMatchObject({ coins: [], all: null, stopOutsToday: 0 });
  });
});

describe("live venue stop-out detection on the watch tick", () => {
  /** A live venue whose positions the test sets; it holds stops on the exchange (no settle). */
  class FakeLive implements Broker {
    readonly venue = "fake-live";
    readonly live = true;
    positions: Position[] = [];
    available = true;
    async account(): Promise<AccountState> {
      return { venue: this.venue, equityUsd: 10_000, dayPnlUsd: 0, positions: this.available ? this.positions : [], available: this.available };
    }
    async open(): Promise<ExecutionResult> {
      return { ok: false, venue: this.venue, fills: [], error: "n/a" };
    }
    async exit(): Promise<ExecutionResult> {
      return { ok: false, venue: this.venue, fills: [], error: "n/a" };
    }
  }
  const pos: Position = { coin: "ETH", side: "long", size: 0.5, entryPx: 4000, markPx: 3900, stopPx: 3850, tpPx: 4400, unrealizedPnl: -50, notionalUsd: 1950 };
  const bar = (t: number, l: number) => ({ t, T: t + 299_999, o: 3900, h: 3910, l, c: 3880, v: 1 });

  function build() {
    const t = { now: new Date("2026-10-05T12:00:00Z") };
    const broker = new FakeLive();
    const kit = makeService({ now: () => t.now });
    const service = new DeskService({ config: kit.config, store: kit.store, data: kit.data, notifier: kit.notifier, now: () => t.now, broker });
    return { ...kit, service, broker, t };
  }

  test("a position gone while the bars touched its stop is a stop-out; gone without touching is not", async () => {
    const { service, broker, data, t, notifier } = build();
    broker.positions = [pos, { ...pos, coin: "SOL", entryPx: 200, markPx: 198, stopPx: 190, size: 5, notionalUsd: 990 }];
    await tick(service, { runCycle: false });
    t.now = new Date("2026-10-05T12:15:00Z");
    broker.positions = [];
    data.candleMap.set("ETH", [bar(Date.parse("2026-10-05T12:05:00Z"), 3845)]);
    data.candleMap.set("SOL", [{ ...bar(Date.parse("2026-10-05T12:05:00Z"), 195), o: 198, h: 199, c: 197 }]); // closed by hand above its stop
    data.setMark("SOL", 197);
    const r = await tick(service, { runCycle: false });
    expect(r.settled).toEqual([{ coin: "ETH", kind: "stop", pnl: 0 }]);
    const cd = await service.cooldown();
    expect(cd.coins).toMatchObject([{ coin: "ETH", until: "2026-10-05T16:15:00.000Z", ref: { source: "watch", proposalId: null, planId: null, fill: { side: "long", size: 0.5, px: 3850, pnl: null } }, plan: null }]);
    expect(notifier.sent.find((a) => a.title === "ETH stopped out")!.body).toContain("touched its stop");
  });

  test("an unreadable account is never read as every position gone", async () => {
    const { service, broker, data, t } = build();
    broker.positions = [pos];
    await tick(service, { runCycle: false });
    t.now = new Date("2026-10-05T12:15:00Z");
    broker.available = false;
    data.candleMap.set("ETH", [bar(Date.parse("2026-10-05T12:05:00Z"), 3800)]);
    await tick(service, { runCycle: false });
    expect((await service.cooldown()).coins).toEqual([]);
  });
});
