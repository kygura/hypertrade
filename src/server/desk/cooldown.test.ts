import { describe, expect, test } from "bun:test";
import type { StopOutRef } from "../../shared/deskPlan.js";
import { activeLocks, lockReasons, NO_LOCKS, nextUtcMidnight, parseCooldownState, recordStopOut } from "./cooldown.js";

const cfg = { cooldownHours: 4, maxStopOutsPerDay: 2 };
const ref = (proposalId: string | null = null): StopOutRef => ({ source: "paper", proposalId, planId: null, fill: { side: "long", size: 1, px: 100, pnl: -10 } });
const at = (iso: string) => new Date(iso);

describe("cooldown transitions", () => {
  test("a stop-out locks its coin for the cooldown, then releases", () => {
    const s = recordStopOut({ stopOuts: [] }, { coin: "ETH", at: at("2026-10-05T10:00:00Z"), ref: ref("p1") }, cfg);
    const during = activeLocks(s, at("2026-10-05T13:59:00Z"), cfg);
    expect(during).toMatchObject({ coins: [{ coin: "ETH", until: "2026-10-05T14:00:00.000Z", stopOutAt: "2026-10-05T10:00:00.000Z", ref: { proposalId: "p1" } }], all: null, stopOutsToday: 1 });
    expect(lockReasons(during, "eth").join()).toContain("new ETH entries locked until 2026-10-05 14:00 UTC");
    expect(lockReasons(during, "BTC")).toEqual([]);
    expect(activeLocks(s, at("2026-10-05T14:00:00Z"), cfg).coins).toEqual([]);
  });

  test("a later stop-out on the same coin extends its lock", () => {
    let s = recordStopOut({ stopOuts: [] }, { coin: "ETH", at: at("2026-10-05T08:00:00Z"), ref: ref() }, cfg);
    s = recordStopOut(s, { coin: "ETH", at: at("2026-10-05T09:30:00Z"), ref: ref() }, { ...cfg, maxStopOutsPerDay: 3 });
    expect(activeLocks(s, at("2026-10-05T12:30:00Z"), { ...cfg, maxStopOutsPerDay: 3 }).coins).toMatchObject([{ coin: "ETH", until: "2026-10-05T13:30:00.000Z" }]);
  });

  test("two stop-outs in one UTC day lock every entry until the next 00:00 UTC", () => {
    let s = recordStopOut({ stopOuts: [] }, { coin: "ETH", at: at("2026-10-05T09:00:00Z"), ref: ref() }, cfg);
    s = recordStopOut(s, { coin: "BTC", at: at("2026-10-05T20:00:00Z"), ref: ref() }, cfg);
    const late = activeLocks(s, at("2026-10-05T23:59:00Z"), cfg);
    expect(late.all).toEqual({ until: "2026-10-06T00:00:00.000Z", reason: "2 stop-outs today (ETH, BTC): no new entries until 00:00 UTC" });
    expect(lockReasons(late, "SOL").join()).toContain("2 stop-outs today");
    // Next UTC day: the all-lock is gone; BTC's own 4h lock still runs to 00:00.
    const next = activeLocks(s, at("2026-10-06T00:00:00Z"), cfg);
    expect(next.all).toBeNull();
    expect(next.stopOutsToday).toBe(0);
    expect(next.coins).toEqual([]);
  });

  test("stop-outs on two different days do not add up", () => {
    let s = recordStopOut({ stopOuts: [] }, { coin: "ETH", at: at("2026-10-05T23:00:00Z"), ref: ref() }, cfg);
    s = recordStopOut(s, { coin: "BTC", at: at("2026-10-06T01:00:00Z"), ref: ref() }, cfg);
    const l = activeLocks(s, at("2026-10-06T02:00:00Z"), cfg);
    expect(l.all).toBeNull();
    expect(l.coins.map((c) => c.coin)).toEqual(["ETH", "BTC"]);
  });

  test("recording is idempotent per coin and instant, and prunes entries that lock nothing", () => {
    const s1 = recordStopOut({ stopOuts: [] }, { coin: "ETH", at: at("2026-10-03T09:00:00Z"), ref: ref() }, cfg);
    expect(recordStopOut(s1, { coin: "ETH", at: at("2026-10-03T09:00:00Z"), ref: ref() }, cfg)).toBe(s1);
    const s2 = recordStopOut(s1, { coin: "SOL", at: at("2026-10-05T09:00:00Z"), ref: ref() }, cfg);
    expect(s2.stopOuts.map((x) => x.coin)).toEqual(["SOL"]);
  });

  test("an unparseable stored value reads as no stop-outs", () => {
    expect(parseCooldownState({ nope: 1 })).toEqual({ stopOuts: [] });
    expect(parseCooldownState(null)).toEqual({ stopOuts: [] });
    expect(activeLocks(parseCooldownState(undefined), at("2026-10-05T00:00:00Z"), cfg)).toEqual(NO_LOCKS);
  });

  test("nextUtcMidnight", () => {
    expect(nextUtcMidnight(at("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
