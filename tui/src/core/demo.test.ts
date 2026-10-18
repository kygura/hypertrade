import { describe, expect, test } from "bun:test";
import { demoAccountAddress, DemoInfo } from "./demo.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const demo = new DemoInfo(() => NOW);

describe("DemoInfo", () => {
  test("demo address is a valid 0x address", () => {
    expect(demoAccountAddress).toMatch(/^0x[0-9a-f]{40}$/i);
  });

  test("markets: about 40 coins, BTC and ETH first, unique coins", async () => {
    const m = await demo.markets();
    expect(m.length).toBeGreaterThanOrEqual(40);
    expect(m.length).toBeLessThanOrEqual(45);
    expect(m[0]!.coin).toBe("BTC");
    expect(m[1]!.coin).toBe("ETH");
    expect(m.every((r) => r.markPx > 0 && r.oiUsd > 0)).toBe(true);
    expect(new Set(m.map((r) => r.coin)).size).toBe(m.length);
    // callers get copies
    m[0]!.markPx = 1;
    expect((await demo.markets())[0]!.markPx).not.toBe(1);
  });

  test("account: BTC long with stop and tp, ETH short without a stop, 3 open orders", async () => {
    const markets = await demo.markets();
    const a = await demo.account(demoAccountAddress, markets);
    expect(a.address).toBe(demoAccountAddress);
    expect(a.at).toBe(NOW);
    expect(a.positions.map((p) => [p.coin, p.side])).toEqual([["BTC", "long"], ["ETH", "short"]]);
    const [btc, eth] = a.positions;
    expect(btc!.stopPx).not.toBeNull();
    expect(btc!.tpPx).not.toBeNull();
    expect(eth!.stopPx).toBeNull();
    expect(a.orders).toHaveLength(3);
    expect(a.orders.every((o) => o.timestamp < NOW && o.timestamp > NOW - DAY)).toBe(true);
  });

  test("account is consistent with the markets: marks match and the stop is on the protective side", async () => {
    const markets = await demo.markets();
    const a = await demo.account(demoAccountAddress, markets);
    const btc = a.positions[0]!;
    expect(btc.markPx).toBe(markets[0]!.markPx);
    expect(btc.stopPx!).toBeLessThan(btc.markPx);
    expect(btc.tpPx!).toBeGreaterThan(btc.markPx);
    expect(btc.liqPx!).toBeLessThan(btc.stopPx!);
    expect(a.marginUsedUsd).toBeCloseTo(a.positions.reduce((s, p) => s + p.marginUsedUsd, 0), 1);
    expect(a.equityUsd).toBeGreaterThan(a.marginUsedUsd);
  });

  test("book mid agrees with the market mark; synthesized books follow the coin's price", async () => {
    const markets = await demo.markets();
    const btc = await demo.book("BTC");
    expect(Math.abs(btc.mid! / markets[0]!.markPx - 1)).toBeLessThan(0.001);
    const sol = markets.find((m) => m.coin === "SOL")!;
    const book = await demo.book("SOL");
    expect(book.coin).toBe("SOL");
    expect(Math.abs(book.mid! / sol.markPx - 1)).toBeLessThan(0.001);
    expect(book.slippage[0]!.buyBps).not.toBeNull();
    await expect(demo.book("NOPE")).rejects.toThrow("no demo book");
  });

  test("candles end at now and respect startMs; 4h is aggregated from 1h", async () => {
    const d = await demo.candles("BTC", "1d", NOW - 30 * DAY);
    expect(d.length).toBeGreaterThanOrEqual(30);
    expect(NOW - d[d.length - 1]!.t).toBeLessThan(DAY);
    expect(d[0]!.t).toBeGreaterThanOrEqual(NOW - 30 * DAY);
    const h = await demo.candles("ETH", "1h", NOW - 72 * HOUR);
    expect(h.length).toBeGreaterThanOrEqual(60);
    expect(NOW - h[h.length - 1]!.t).toBeLessThan(HOUR);
    const h4 = await demo.candles("BTC", "4h", 0);
    expect(h4.length).toBeLessThan(h.length / 3);
    expect(h4.every((c) => c.t % (4 * HOUR) === 0)).toBe(true);
    expect(h4.every((c) => c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c))).toBe(true);
    expect(await demo.candles("ZEC", "1d", 0)).toEqual([]);
  });

  test("funding history is hourly, ends now, and is empty for coins without fixtures", async () => {
    const f = await demo.fundingHistory("BTC", NOW - 5 * DAY);
    expect(f.length).toBeGreaterThan(24);
    expect(NOW - f[f.length - 1]!.t).toBeLessThan(HOUR);
    expect(Math.abs(f[1]!.t - f[0]!.t - HOUR)).toBeLessThan(5_000);
    expect(await demo.fundingHistory("ZEC", 0)).toEqual([]);
  });
});
