import { describe, expect, test } from "bun:test";
import { protectiveHit } from "./paper.js";
import { DeskError } from "./service.js";
import { makeService } from "./testkit.js";
import type { OperatorOrder, TradeProposal } from "./types.js";

const proposal: TradeProposal = {
  coin: "eth",
  side: "long",
  setup: "spot-led breakout retest",
  thesis: "Spot-led rally with OI flat and funding neutral; the retest held.",
  horizon: "swing",
  confidence: "medium",
  stop: 3800,
  target: 4500,
  riskPct: 0.5,
  invalidation: "daily close under 3850",
  evidence: [
    { source: "flow_diagnostics", point: "spot_led_rally" },
    { source: "macro", point: "liquidity rising" },
  ],
};

describe("protectiveHit", () => {
  test("stop wins when a bar spans both", () => {
    expect(protectiveHit({ side: "long", stopPx: 90, tpPx: 110 }, 89, 111)).toEqual({ kind: "stop", px: 90 });
    expect(protectiveHit({ side: "long", stopPx: 90, tpPx: 110 }, 95, 111)).toEqual({ kind: "target", px: 110 });
    expect(protectiveHit({ side: "short", stopPx: 110, tpPx: 90 }, 89, 105)).toEqual({ kind: "target", px: 90 });
    expect(protectiveHit({ side: "short", stopPx: 110, tpPx: 90 }, 95, 105)).toBeNull();
  });
});

describe("DeskService", () => {
  test("auto approval executes on paper, resolving the coin's case", async () => {
    const { service, store, notifier } = makeService();
    const rec = await service.submitOpen(proposal, null);
    expect(rec.status).toBe("executed");
    expect((rec.proposal as TradeProposal).coin).toBe("ETH");
    const [pos] = await store.paperPositions();
    expect(pos).toMatchObject({ coin: "ETH", side: "long", size: 0.25, stopPx: 3800, tpPx: 4500 });
    expect(pos!.entryPx).toBeCloseTo(4002, 3); // 5 bp slippage
    expect(notifier.sent.at(-1)!.title).toContain("Opened long ETH");
    const acc = await service.account();
    expect(acc.equityUsd).toBeLessThan(10_000); // fee + slippage
  });

  test("manual approval queues, alerts with buttons, and re-checks on approve", async () => {
    const { service, data, notifier } = makeService({ env: { DESK_APPROVAL: "manual" } });
    const rec = await service.submitOpen(proposal, null);
    expect(rec.status).toBe("pending");
    expect(rec.expiresAt).not.toBeNull();
    expect(notifier.sent.at(-1)!.actions?.map((a) => a.data)).toEqual([`approve:${rec.id}`, `reject:${rec.id}`]);

    // Price fell through the stop before the operator approved: blocked, not filled.
    data.setMark("ETH", 3790);
    const out = await service.approve(rec.id, "operator");
    expect(out.status).toBe("blocked");
    expect(out.verdict.reasons.join()).toContain("wrong side");
    await expect(service.approve(rec.id, "operator")).rejects.toBeInstanceOf(DeskError);
  });

  test("reject and expiry", async () => {
    const t = { now: new Date("2026-10-05T12:00:00Z") };
    const { service } = makeService({ env: { DESK_APPROVAL: "manual", DESK_APPROVAL_TTL_MIN: "30" }, now: () => t.now });
    const a = await service.submitOpen(proposal, null);
    expect((await service.reject(a.id, "operator")).status).toBe("rejected");
    const b = await service.submitOpen({ ...proposal, coin: "SOL", stop: 190, target: 230 }, null);
    t.now = new Date("2026-10-05T13:00:00Z");
    expect(await service.expirePending()).toBe(1);
    await expect(service.approve(b.id, "operator")).rejects.toThrow("proposal is expired");
  });

  test("blocked proposals are recorded with reasons; the kill switch blocks entries but not exits", async () => {
    const { service } = makeService();
    expect((await service.submitOpen({ ...proposal, target: 4100 }, null)).status).toBe("blocked");
    await service.submitOpen(proposal, null);
    await service.setKillSwitch(true, "test", "operator");
    const blocked = await service.submitOpen({ ...proposal, coin: "SOL", stop: 190, target: 230 }, null);
    expect(blocked.verdict.reasons.join()).toContain("kill switch");
    const exit = await service.submitExit({ coin: "ETH", fraction: 1, reason: "flatten under the kill switch" }, null);
    expect(exit.status).toBe("executed");
    expect(await service.store.paperPositions()).toHaveLength(0);
  });

  test("reviewEveryHours: an operator override beats the env default; no override falls back to it", async () => {
    const { service } = makeService({ env: { DESK_REVIEW_HOURS: "8" } });
    expect(await service.reviewEveryHours()).toEqual({ hours: 8, source: "env" });
    await service.setReviewEveryHours(24, "operator");
    expect(await service.reviewEveryHours()).toEqual({ hours: 24, source: "ui" });
    await service.setReviewEveryHours(0, "operator");
    expect(await service.reviewEveryHours()).toEqual({ hours: 0, source: "ui" }); // 0 = scheduled reviews off
  });

  test("paper PnL: a target fill books profit net of fees", async () => {
    const { service, store } = makeService();
    await service.submitOpen(proposal, null);
    const settled = await service.broker.settle!(new Map([["ETH", { low: 4400, high: 4510 }]]), service.now());
    expect(settled[0]!.kind).toBe("target");
    const fill = settled[0]!.result.fills[0]!;
    expect(fill.px).toBe(4500);
    expect(fill.pnl).toBeCloseTo((4500 - 4002) * 0.25, 6);
    expect(await store.paperPositions()).toHaveLength(0);
    const acc = await service.account();
    expect(acc.equityUsd).toBeCloseTo(10_000 + fill.pnl - 0.25 * 4002 * 0.00045 - fill.fee, 6);
  });

  test("the day-loss anchor resets at 00:00 UTC", async () => {
    const t = { now: new Date("2026-10-05T23:00:00Z") };
    const { service, data } = makeService({ now: () => t.now });
    await service.submitOpen(proposal, null);
    data.setMark("ETH", 3900);
    const before = await service.account();
    expect(before.dayPnlUsd).toBeLessThan(0);
    t.now = new Date("2026-10-06T00:05:00Z");
    expect((await service.account()).dayPnlUsd).toBe(0);
  });
});

describe("operator orders (copilot)", () => {
  const order: OperatorOrder = { coin: "eth", side: "long", stop: 3800, target: 4500, notionalUsd: 800, source: "copilot" };
  const BY = "operator:copilot";
  const status = (p: Promise<unknown>) =>
    p.then(
      () => 0,
      (e) => (e instanceof DeskError ? e.status : -1),
    );

  test("preview then submit fills on paper, decided by operator:copilot", async () => {
    const { service, store, notifier } = makeService();
    const pv = await service.previewOperatorOrder(order);
    expect(pv).toMatchObject({ markPx: 4000, venue: "paper", verdict: { approved: true }, expiresAt: "2026-10-05T12:01:00.000Z" });
    expect(pv.verdict.sizing).toMatchObject({ size: 0.2, notionalUsd: 800, riskUsd: 40, rr: 2.5 });
    expect(pv.verdict.warnings.join()).toContain("800 USD notional");

    const rec = await service.submitOperatorOrder(order, { previewHash: pv.previewHash }, BY);
    expect(rec).toMatchObject({ kind: "open", status: "executed", venue: "paper", decidedBy: "operator:copilot", proposal: { coin: "ETH", source: "copilot", resolvedRiskPct: 0.4 } });
    expect("riskPct" in rec.proposal).toBe(false);
    const fills = await store.listFills(10);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ coin: "ETH", side: "buy", size: 0.2, reason: "entry", proposalId: rec.id });
    expect(await store.paperPositions()).toMatchObject([{ coin: "ETH", stopPx: 3800, tpPx: 4500, proposalId: rec.id }]);
    expect(notifier.sent.at(-1)!.title).toContain("Opened long ETH (paper)");
    // One submit per preview.
    expect(await status(service.submitOperatorOrder(order, { previewHash: pv.previewHash }, BY))).toBe(409);
  });

  test("two concurrent submits of one preview: exactly one executes", async () => {
    const { service, store } = makeService();
    const pv = await service.previewOperatorOrder(order);
    const out = await Promise.allSettled([service.submitOperatorOrder(order, pv, BY), service.submitOperatorOrder(order, pv, BY)]);
    expect(out.filter((r) => r.status === "fulfilled" && r.value.status === "executed")).toHaveLength(1);
    expect(out.filter((r) => r.status === "rejected" && r.reason instanceof DeskError && r.reason.status === 409)).toHaveLength(1);
    expect(await store.listFills(10)).toHaveLength(1);
  });

  test("takeState hands a preview to one caller only (MemoryStore)", async () => {
    const { store } = makeService();
    await store.setState("k", { hash: "h", v: 1 });
    expect(await store.takeState("k", "other")).toBeNull();
    const [a, b] = await Promise.all([store.takeState<{ hash: string; v: number }>("k", "h"), store.takeState<{ hash: string; v: number }>("k", "h")]);
    expect([a, b].filter(Boolean)).toEqual([{ hash: "h", v: 1 }]);
    expect(await store.getState("k")).toBeNull();
  });

  test("records the confirming operator as the decision", async () => {
    const { service } = makeService();
    const pv = await service.previewOperatorOrder(order);
    expect((await service.submitOperatorOrder(order, pv, "operator:test")).decidedBy).toBe("operator:test");
  });

  test("an order without a target fills with no take-profit", async () => {
    const { service, store } = makeService();
    const { target: _t, ...noTarget } = order;
    const pv = await service.previewOperatorOrder(noTarget);
    expect(pv.verdict.warnings).toContain("no target: reward:risk not checked");
    expect((await service.submitOperatorOrder(noTarget, pv, BY)).status).toBe("executed");
    expect(await store.paperPositions()).toMatchObject([{ coin: "ETH", tpPx: null }]);
  });

  test("409 on a wrong hash, an order changed after the preview, or a preview over 60 s old", async () => {
    const t = { now: new Date("2026-10-05T12:00:00Z") };
    const { service, store } = makeService({ now: () => t.now });
    const pv = await service.previewOperatorOrder(order);
    expect(await status(service.submitOperatorOrder(order, { previewHash: "0".repeat(64) }, BY))).toBe(409);
    expect(await status(service.submitOperatorOrder({ ...order, notionalUsd: 8000 }, pv, BY))).toBe(409);
    t.now = new Date("2026-10-05T12:01:01Z");
    expect(await status(service.submitOperatorOrder(order, pv, BY))).toBe(409);
    expect(await store.listFills(10)).toHaveLength(0);
    expect(await store.listProposals({ limit: 10 })).toHaveLength(0);
  });

  test("409 when the mark moved more than 0.5% since the preview", async () => {
    const { service, store, data } = makeService();
    const pv = await service.previewOperatorOrder(order);
    data.setMark("ETH", 4030); // +0.75%
    expect(await status(service.submitOperatorOrder(order, pv, BY))).toBe(409);
    expect(await store.listFills(10)).toHaveLength(0);

    const pv2 = await service.previewOperatorOrder(order);
    data.setMark("ETH", 4040); // +0.25% from the new preview: still within bounds
    expect((await service.submitOperatorOrder(order, pv2, BY)).status).toBe("executed");
  });

  test("a governor reject is recorded as blocked and never fills", async () => {
    const { service, store } = makeService();
    const bad = { ...order, stop: 4100 };
    const pv = await service.previewOperatorOrder(bad);
    expect(pv.verdict.approved).toBe(false);
    const rec = await service.submitOperatorOrder(bad, pv, BY);
    expect(rec).toMatchObject({ status: "blocked", decidedBy: "governor (at operator:copilot)" });
    expect(rec.verdict.reasons.join()).toContain("wrong side");
    expect(await store.listFills(10)).toHaveLength(0);
  });

  test("the kill switch blocks it", async () => {
    const { service, store } = makeService();
    const pv = await service.previewOperatorOrder(order);
    await service.setKillSwitch(true, "test", "operator");
    const rec = await service.submitOperatorOrder(order, pv, BY);
    expect(rec.status).toBe("blocked");
    expect(rec.verdict.reasons.join()).toContain("kill switch");
    expect(await store.listFills(10)).toHaveLength(0);
    expect((await service.previewOperatorOrder(order)).verdict.approved).toBe(false);
  });

  test("manual approval mode: the confirm is the approval, so it executes", async () => {
    const { service } = makeService({ env: { DESK_APPROVAL: "manual" } });
    const pv = await service.previewOperatorOrder(order);
    expect((await service.submitOperatorOrder(order, pv, BY)).status).toBe("executed");
  });

  test("a preview alone executes nothing and records nothing", async () => {
    const { service, store } = makeService();
    await service.previewOperatorOrder(order);
    await service.previewOperatorOrder({ ...order, side: "short", stop: 4200, target: 3500 });
    expect(await store.listFills(10)).toHaveLength(0);
    expect(await store.paperPositions()).toHaveLength(0);
    expect(await store.listProposals({ limit: 10 })).toHaveLength(0);
  });

  test("notional over the risk limit is clipped, with a warning", async () => {
    const { service } = makeService();
    const pv = await service.previewOperatorOrder({ ...order, notionalUsd: 20_000 });
    expect(pv.verdict.sizing).toMatchObject({ size: 0.25, riskUsd: 50 });
    expect(pv.verdict.warnings.join()).toContain("clipped to the 0.5% per-trade limit");
  });

  test("invalid orders are a 400", async () => {
    const { service } = makeService();
    const { notionalUsd: _n, ...unsized } = order;
    expect(await status(service.previewOperatorOrder(unsized))).toBe(400);
    expect(await status(service.previewOperatorOrder({ ...order, stop: -1 }))).toBe(400);
    expect(await status(service.previewOperatorOrder({ ...order, source: "agent" } as never))).toBe(400);
  });

  test("placeOperatorOrder previews and submits in one step; two at once both run, one after the other", async () => {
    const { service, store } = makeService();
    const [a, b] = await Promise.all([service.placeOperatorOrder(order, BY), service.placeOperatorOrder({ ...order, coin: "BTC", stop: 95_000, target: 110_000 }, BY)]);
    expect([a.status, b.status]).toEqual(["executed", "executed"]);
    expect(await store.listFills(10)).toHaveLength(2);
  });

  test("a copilot preview concurrent with placeOperatorOrder cannot slip between its preview and submit", async () => {
    const { service } = makeService();
    const short = { ...order, side: "short" as const, stop: 4200, target: 3500 };
    const [, rec] = await Promise.all([service.previewOperatorOrder(short), service.placeOperatorOrder(order, BY), service.previewOperatorOrder(short)]);
    expect(rec.status).toBe("executed");
  });

  test("a fill whose record write throws still returns executed (never failed with a position open)", async () => {
    const { service, store } = makeService();
    const orig = store.updateProposal.bind(store);
    store.updateProposal = async () => { throw new Error("db down"); };
    const err = console.error;
    console.error = () => {};
    const rec = await service.placeOperatorOrder(order, BY);
    console.error = err;
    store.updateProposal = orig;
    expect(rec).toMatchObject({ status: "executed", decidedBy: BY });
    expect(await store.paperPositions()).toMatchObject([{ coin: "ETH", proposalId: rec.id }]);
  });

  test("mainnet is still refused: a mainnet venue request trades paper", async () => {
    const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
    const { service, store } = makeService({ env: { DESK_VENUE: "hl-mainnet", DESK_HL_SECRET_KEY: KEY } });
    expect(service.broker).toMatchObject({ venue: "paper", live: false });
    const pv = await service.previewOperatorOrder(order);
    expect(pv.venue).toBe("paper");
    const rec = await service.submitOperatorOrder(order, pv, BY);
    expect(rec).toMatchObject({ status: "executed", venue: "paper" });
    expect(await store.listFills(10)).toHaveLength(1);
  });
});
