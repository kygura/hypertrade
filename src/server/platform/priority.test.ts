import { describe, expect, test } from "bun:test";
import { priority, rankCandidates, type Candidate } from "./priority.js";

const NOW = Date.UTC(2026, 9, 15, 12);
const MIN = 60_000;
const iso = (agoMin: number) => new Date(NOW - agoMin * MIN).toISOString();
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const c = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  address: addr(n), lastSeenAt: iso(120), polledAt: iso(5), notionalUsd: 1e6, positionCount: 1, minLiqDistance: 0.2, ...over,
});
const rank = (xs: Candidate[]) => rankCandidates(xs, NOW, { maxAgeMin: 30 }).map((x) => x.address);

describe("rankCandidates", () => {
  test("orders by notional x proximity x staleness", () => {
    const big = c(1, { notionalUsd: 1e7 });
    const small = c(2, { notionalUsd: 1e6 });
    expect(rank([small, big])).toEqual([big.address, small.address]);
    // closer to liquidation outranks farther at equal notional and age
    const near = c(3, { minLiqDistance: 0.01 });
    const far = c(4, { minLiqDistance: 0.3 });
    expect(rank([far, near])).toEqual([near.address, far.address]);
    // a 1% distance (capped) beats a 30% one even with a tenth of the notional x 20
    expect(priority(near, NOW)).toBeGreaterThan(priority(far, NOW));
    // staler wins at equal everything else
    const stale = c(5, { polledAt: iso(20) });
    const fresh = c(6, { polledAt: iso(2) });
    expect(rank([fresh, stale])).toEqual([stale.address, fresh.address]);
  });

  test("distance below 1% is capped, not unbounded", () => {
    expect(priority(c(1, { minLiqDistance: 0.0001 }), NOW)).toBe(priority(c(1, { minLiqDistance: 0.01 }), NOW));
  });

  test("max-age floor: an overdue small account outranks a fresh huge one", () => {
    const huge = c(1, { notionalUsd: 1e9, minLiqDistance: 0.01, polledAt: iso(1) });
    const overdue = c(2, { notionalUsd: 100, polledAt: iso(31) });
    expect(rank([huge, overdue])).toEqual([overdue.address, huge.address]);
  });

  test("unpolled first, biggest known notional first", () => {
    const polled = c(1, { notionalUsd: 1e9, polledAt: iso(90) });
    const newSmall = c(2, { polledAt: null, notionalUsd: 0, lastSeenAt: iso(1) });
    const newBig = c(3, { polledAt: null, notionalUsd: 5, lastSeenAt: iso(10) });
    expect(rank([polled, newSmall, newBig])).toEqual([newBig.address, newSmall.address, polled.address]);
  });

  test("idle accounts wait for their hourly interval, then rank last", () => {
    const idleSoon = c(1, { positionCount: 0, notionalUsd: 0, minLiqDistance: null, polledAt: iso(59) });
    const idleDue = c(2, { positionCount: 0, notionalUsd: 0, minLiqDistance: null, polledAt: iso(61) });
    const active = c(3, { polledAt: iso(1) });
    expect(rank([idleSoon, idleDue, active])).toEqual([active.address, idleDue.address]);
  });

  test("an idle account that traded after its last poll is active again", () => {
    const back = c(1, { positionCount: 0, notionalUsd: 0, minLiqDistance: null, polledAt: iso(10), lastSeenAt: iso(2) });
    expect(rank([back])).toEqual([back.address]);
  });

  test("NaN exchange data never breaks the order", () => {
    const bad = c(1, { notionalUsd: NaN, minLiqDistance: NaN });
    expect(Number.isFinite(priority(bad, NOW))).toBe(true);
    expect(rank([bad, c(2)])).toHaveLength(2);
  });
});
