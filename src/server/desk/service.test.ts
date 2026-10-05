import { describe, expect, test } from "bun:test";
import { protectiveHit } from "./paper.js";
import { DeskError } from "./service.js";
import { makeService } from "./testkit.js";
import type { TradeProposal } from "./types.js";

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
