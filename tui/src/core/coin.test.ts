import { describe, expect, test } from "bun:test";
import { buildCoinView } from "./coin.js";
import { demoAccountAddress, DemoInfo } from "./demo.js";
import type { InfoSource } from "./types.js";

const NOW = 1_800_000_000_000;
const demo = new DemoInfo(() => NOW);
const markets = await demo.markets();
const account = await demo.account(demoAccountAddress, markets);

describe("buildCoinView", () => {
  test("BTC from the demo source: ATR, regime, diagnostics, position", async () => {
    const v = await buildCoinView(demo, markets[0]!, account, NOW);
    expect(v.market.coin).toBe("BTC");
    expect(v.atr14).toBeGreaterThan(0);
    expect(v.atr14!).toBeLessThan(markets[0]!.markPx * 0.2);
    expect(v.regime).not.toBeNull();
    expect(v.diagnostics.length).toBeGreaterThan(2);
    expect(v.diagnostics[0]).toMatch(/^24h (up|down|flat) [+-]\d/);
    expect(v.diagnostics.every((l) => l.length < 200)).toBe(true);
    expect(v.position?.coin).toBe("BTC");
  });

  test("ATR ignores the still-forming daily candle", async () => {
    const day = 24 * 3_600_000;
    const bars = await demo.candles("BTC", "1d", 0);
    const forming = bars[bars.length - 1]!;
    expect(forming.t + day).toBeGreaterThan(NOW);
    const spiky: InfoSource = {
      ...(demo as InfoSource),
      markets: () => demo.markets(),
      account: (a, m) => demo.account(a, m),
      book: (c) => demo.book(c),
      fundingHistory: (c, s) => demo.fundingHistory(c, s),
      candles: async (c, i, s) => (i === "1d" ? bars.map((b) => (b === forming ? { ...b, h: b.h * 3 } : b)) : demo.candles(c, i, s)),
    };
    const base = await buildCoinView(demo, markets[0]!, null, NOW);
    expect((await buildCoinView(spiky, markets[0]!, null, NOW)).atr14).toBe(base.atr14);
  });

  test("no position, no account", async () => {
    expect((await buildCoinView(demo, markets[0]!, null, NOW)).position).toBeNull();
    expect((await buildCoinView(demo, markets[2]!, account, NOW)).position).toBeNull();
  });

  test("an OI history makes the regime use OI", async () => {
    const day = 3_600_000 * 24;
    const oi = [{ t: NOW - day, v: 1_000 }, { t: NOW, v: 1_100 }];
    const v = await buildCoinView(demo, markets[0]!, null, NOW, oi);
    expect(v.diagnostics.join("\n")).toContain("OI +10.0%");
  });

  test("a coin without candles degrades to a funding/price regime and says so", async () => {
    const zec = markets.find((m) => m.coin === "ZEC")!;
    const v = await buildCoinView(demo, zec, null, NOW);
    expect(v.atr14).toBeNull();
    expect(v.regime).not.toBeNull();
    expect(v.diagnostics.join("\n")).toContain("no flow diagnostics");
    expect(v.diagnostics.join("\n")).toContain("ATR14 unavailable");
  });

  test("failing info calls degrade instead of throwing", async () => {
    const broken: InfoSource = {
      markets: async () => markets,
      account: async () => account,
      book: async () => { throw new Error("x"); },
      candles: async () => { throw new Error("down"); },
      fundingHistory: async () => { throw new Error("down"); },
    };
    const v = await buildCoinView(broken, markets[0]!, null, NOW);
    expect(v.atr14).toBeNull();
    expect(v.diagnostics.length).toBeGreaterThan(0);
  });
});
