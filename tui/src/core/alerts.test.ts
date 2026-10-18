import { describe, expect, test } from "bun:test";
import { AlertEngine } from "./alerts.js";
import { DemoInfo } from "./demo.js";
import type { AccountSnapshot, MarketRow } from "./types.js";

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = 1_800_000_000_000;

const demo = new DemoInfo(() => T0);
const baseMarkets = await demo.markets();
const baseAccount = await demo.account("0xabc", baseMarkets);

/** Markets with every funding and day change zeroed so only the thing under test can fire. */
const quiet = (over: Record<string, Partial<MarketRow>> = {}): MarketRow[] =>
  baseMarkets.map((m) => ({ ...m, fundingHourly: 0, fundingAprPct: 0, dayChangePct: 0.1, ...(over[m.coin] ?? {}) }));

const protectedAccount: AccountSnapshot = { ...baseAccount, positions: baseAccount.positions.map((p) => ({ ...p, stopPx: p.stopPx ?? p.markPx * 0.95 })) };

describe("AlertEngine", () => {
  test("a position without a stop raises a critical no-stop alert", () => {
    const e = new AlertEngine();
    const out = e.ingest(T0, quiet(), baseAccount, []);
    const a = out.find((x) => x.key === "nostop:ETH")!;
    expect(a.level).toBe("critical");
    expect(a.title).toContain("ETH has no stop");
    expect(a.at).toBe(T0);
    expect(out.some((x) => x.key === "nostop:BTC")).toBe(false); // BTC has its stop
  });

  test("no account and nothing moving: no alerts", () => {
    expect(new AlertEngine().ingest(T0, quiet(), null, ["BTC", "ETH"])).toEqual([]);
    expect(new AlertEngine().ingest(T0, quiet(), protectedAccount, ["BTC"])).toEqual([]);
  });

  test("returns only new alerts: same key is suppressed inside the cooldown and returns after it", () => {
    const e = new AlertEngine({ cooldownMs: 30 * MIN });
    expect(e.ingest(T0, quiet(), baseAccount, []).map((a) => a.key)).toEqual(["nostop:ETH"]);
    expect(e.ingest(T0 + 15_000, quiet(), baseAccount, [])).toEqual([]);
    expect(e.ingest(T0 + 29 * MIN, quiet(), baseAccount, [])).toEqual([]);
    const again = e.ingest(T0 + 31 * MIN, quiet(), baseAccount, []);
    expect(again.map((a) => a.key)).toEqual(["nostop:ETH"]);
    expect(again[0]!.at).toBe(T0 + 31 * MIN);
  });

  test("a different key is not blocked by another key's cooldown", () => {
    const e = new AlertEngine();
    e.ingest(T0, quiet(), baseAccount, []);
    const hot = quiet({ SOL: { fundingHourly: 0.0001, fundingAprPct: 87.6 } });
    const out = e.ingest(T0 + 15_000, hot, baseAccount, ["SOL"]);
    expect(out.map((a) => a.key)).toEqual(["funding:SOL:1"]);
  });

  test("a 1h move is detected from the mark history it accumulated", () => {
    const e = new AlertEngine();
    const btc = baseMarkets.find((m) => m.coin === "BTC")!.markPx;
    for (let t = 0; t <= 60; t += 5) {
      const px = btc * (t < 60 ? 1 : 1.04);
      const out = e.ingest(T0 + t * MIN, quiet({ BTC: { markPx: px } }), null, ["BTC"]);
      if (t < 60) expect(out).toEqual([]);
      else expect(out.map((a) => a.key)).toEqual(["move1h:BTC:1"]);
    }
  });

  test("OI change over 4h needs ~4h of history, then fires at +10%", () => {
    const e = new AlertEngine();
    const oi = baseMarkets.find((m) => m.coin === "ETH")!.oiUsd;
    const keys = (t: number, k: number) => e.ingest(T0 + t, quiet({ ETH: { oiUsd: oi * k } }), null, ["ETH"]).map((a) => a.key);
    expect(keys(0, 1)).toEqual([]);
    expect(keys(1 * HOUR, 1.2)).toEqual([]); // only 1h of history: unknown, not a 20% swing
    expect(keys(2 * HOUR, 1.2)).toEqual([]);
    expect(keys(4 * HOUR, 1.2)).toEqual(["oi:ETH:1"]);
    expect(e.oiSeries("ETH").length).toBe(4);
  });

  test("active(): latest per key, newest first, dropped 4h after the condition stops", () => {
    const e = new AlertEngine();
    e.ingest(T0, quiet(), baseAccount, []);
    e.ingest(T0 + 40 * MIN, quiet(), baseAccount, []); // re-emitted after cooldown
    const act = e.active();
    expect(act).toHaveLength(1);
    expect(act[0]!.at).toBe(T0 + 40 * MIN);
    e.ingest(T0 + 41 * MIN, quiet(), protectedAccount, []); // stop added: condition ends
    expect(e.active()).toHaveLength(1);
    e.ingest(T0 + 41 * MIN + 4 * HOUR + MIN, quiet(), protectedAccount, []);
    expect(e.active()).toEqual([]);
  });

  test("watch and position coins only: other markets get no history", () => {
    const e = new AlertEngine();
    e.ingest(T0, quiet(), baseAccount, ["SOL"]);
    expect(e.oiSeries("SOL")).toHaveLength(1);
    expect(e.oiSeries("BTC")).toHaveLength(1); // open position
    expect(e.oiSeries("HYPE")).toEqual([]);
  });

  test("history is trimmed to historyMs", () => {
    const e = new AlertEngine({ historyMs: HOUR });
    for (let t = 0; t <= 3 * HOUR; t += 10 * MIN) e.ingest(T0 + t, quiet(), null, ["BTC"]);
    expect(e.oiSeries("BTC").length).toBeLessThanOrEqual(7);
  });
});
