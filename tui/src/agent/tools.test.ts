import { describe, expect, test } from "bun:test";
import { fakeTicket, makeDeps, testConfig } from "./testkit.js";
import { agentTools, NOT_SENT } from "./tools.js";

const sig = new AbortController().signal;
async function tools(over = {}, config = testConfig()) {
  const k = await makeDeps(over, config);
  const t = Object.fromEntries(agentTools(k.deps).map((x) => [x.spec.name, x]));
  const run = (name: string, input: unknown) => t[name]!.run(input, sig);
  return { ...k, run, names: Object.keys(t) };
}

describe("agentTools", () => {
  test("exposes the documented tools", async () => {
    const { names } = await tools();
    expect(names).toEqual(["get_markets", "get_coin", "get_book", "get_positions", "get_alerts", "get_funding_history", "get_candles", "lab_pulse", "get_brief", "draft_order", "draft_close"]);
  });

  test("get_markets sorts, limits and filters", async () => {
    const { run } = await tools();
    const top = JSON.parse(await run("get_markets", { limit: 3 }));
    expect(top.markets).toHaveLength(3);
    expect(top.markets[0].oiUsd).toBeGreaterThanOrEqual(top.markets[1].oiUsd);
    const up = JSON.parse(await run("get_markets", { sort: "change_up", limit: 5 }));
    expect(up.markets[0].chg24hPct).toBeGreaterThanOrEqual(up.markets[4].chg24hPct);
    const pick = JSON.parse(await run("get_markets", { coins: ["btc", "ETH"] }));
    expect(pick.markets.map((m: { coin: string }) => m.coin)).toEqual(["BTC", "ETH"]);
  });

  test("bad input names the field", async () => {
    const { run } = await tools();
    await expect(run("get_markets", { limit: 99 })).rejects.toThrow(/limit/);
    await expect(run("get_candles", { coin: "BTC", interval: "5m" })).rejects.toThrow(/interval/);
    await expect(run("get_book", {})).rejects.toThrow(/coin/);
    await expect(run("get_funding_history", { coin: "BTC", hours: 5000 })).rejects.toThrow(/hours/);
  });

  test("unknown coin lists close matches", async () => {
    const { run } = await tools();
    await expect(run("get_book", { coin: "BTCC" })).rejects.toThrow(/close matches: .*BTC/);
    await expect(run("get_coin", { coin: "QQQQQQ" })).rejects.toThrow(/not in the Hyperliquid universe/);
  });

  test("get_coin, get_book, candles and funding return compact JSON from the info source", async () => {
    const { run } = await tools();
    const coin = JSON.parse(await run("get_coin", { coin: "BTC" }));
    expect(coin.market.coin).toBe("BTC");
    expect(coin.atr14).toBeGreaterThan(0);
    expect(coin.position?.coin).toBe("BTC");
    const book = JSON.parse(await run("get_book", { coin: "eth" }));
    expect(book.bids).toHaveLength(5);
    expect(book.slippageBps).toHaveLength(3);
    const candles = JSON.parse(await run("get_candles", { coin: "BTC", interval: "4h", bars: 10 }));
    expect(candles.candles).toHaveLength(10);
    expect(candles.candles[0]).toHaveLength(6);
    const f = JSON.parse(await run("get_funding_history", { coin: "BTC", hours: 72 }));
    expect(f.points).toBeGreaterThan(10);
    expect(f.series.length).toBeLessThanOrEqual(25);
  });

  test("positions: account, none configured", async () => {
    const { run } = await tools();
    const p = JSON.parse(await run("get_positions", {}));
    expect(p.equityUsd).toBeGreaterThan(0);
    expect(p.positions.length).toBeGreaterThan(0);
    const none = await tools({}, testConfig({ account: null }));
    expect(await none.run("get_positions", {})).toContain("no account configured");
  });

  test("lab_pulse throws when unconfigured; brief null is a readable string", async () => {
    const { run } = await tools();
    await expect(run("lab_pulse", {})).rejects.toThrow(/lab not configured/);
    expect(await run("get_brief", {})).toContain("no brief available");
  });

  test("lab_pulse keeps only firing rules", async () => {
    const pulse = async () => ({
      asOf: "2026-10-18",
      warnings: [],
      assets: [{ asset: "BTC", longActive: 1, longTotal: 2, shortActive: 0, shortTotal: 1, lean: 0.33, rules: [
        { id: "a", name: "MVRV washout", direction: "long", firing: true, text: "when x" },
        { id: "b", name: "idle", direction: "long", firing: false, text: "when y" },
      ] }],
    });
    const { run } = await tools({ pulse });
    const p = JSON.parse(await run("lab_pulse", {}));
    expect(p.assets[0].firing).toHaveLength(1);
    expect(p.assets[0].long).toBe("1/2");
  });

  test("draft_order builds an OrderIntent, calls the host once, and says NOT sent", async () => {
    const { run, drafts } = await tools();
    const text = await run("draft_order", { coin: "btc", side: "long", stop: { type: "pct", pct: 2 }, size: { usd: 750 }, target: 70000 });
    expect(drafts).toHaveLength(1);
    const a = drafts[0]!;
    expect(a.kind).toBe("open");
    if (a.kind !== "open") throw new Error();
    expect(a.intent).toEqual({ asset: "BTC", side: "long", leverage: 3, size: { usd: 750 }, entry: { type: "market" }, stop: { type: "pct", pct: 2 }, target: 70000 });
    expect(text.startsWith(NOT_SENT)).toBe(true);
    expect(text).toContain("It has NOT been sent");
    expect(text).toContain('"ticketId":"t-1234"');
  });

  test("draft_order passes blockers through and uses limit_px / leverage", async () => {
    const { run, drafts } = await tools({
      draftOrder: async (a: Parameters<typeof fakeTicket>[0]) => fakeTicket(a, { canSend: false, blockers: ["notional above HT_MAX_NOTIONAL_USD"] }),
    });
    const text = await run("draft_order", { coin: "ETH", side: "short", stop: { type: "price", px: 9999 }, size: { pctBook: 5 }, leverage: 2, limit_px: 3000 });
    expect(drafts).toHaveLength(0);
    expect(text).toContain('"canSend":false');
    expect(text).toContain("HT_MAX_NOTIONAL_USD");
  });

  test("draft_order rejects missing size/stop and bad values without calling the host", async () => {
    const { run, drafts } = await tools();
    await expect(run("draft_order", { coin: "BTC", side: "long", stop: { type: "pct", pct: 2 } })).rejects.toThrow(/size: required.*no default/);
    await expect(run("draft_order", { coin: "BTC", side: "long", size: { usd: 100 } })).rejects.toThrow(/stop: required/);
    await expect(run("draft_order", { coin: "BTC", side: "up", size: { usd: 100 }, stop: { type: "pct", pct: 2 } })).rejects.toThrow(/side/);
    await expect(run("draft_order", { coin: "BTC", side: "long", size: { usd: 100 }, stop: { type: "pct", pct: 80 } })).rejects.toThrow(/stop/);
    await expect(run("draft_order", { coin: "BTC", side: "long", size: { usd: 100 }, stop: { type: "pct", pct: 2 }, leverage: 99 })).rejects.toThrow(/leverage/);
    await expect(run("draft_order", { coin: "NOPE", side: "long", size: { usd: 100 }, stop: { type: "pct", pct: 2 } })).rejects.toThrow(/unknown coin/);
    expect(drafts).toHaveLength(0);
  });

  test("draft_close needs an open position and a valid pct", async () => {
    const { run, drafts } = await tools();
    const text = await run("draft_close", { coin: "BTC", pct: 50 });
    expect(text.startsWith(NOT_SENT)).toBe(true);
    expect(drafts).toEqual([{ kind: "close", coin: "BTC", pct: 50 }]);
    await expect(run("draft_close", { coin: "BTC", pct: 150 })).rejects.toThrow(/pct/);
    await expect(run("draft_close", { coin: "DOGE", pct: 50 })).rejects.toThrow(/no open DOGE position/);
  });

  test("results never carry the lab token", async () => {
    const { run } = await tools({}, testConfig({ lab: { url: "https://x", token: "SECRET-TOKEN" } }));
    for (const n of ["get_markets", "get_positions", "get_alerts"]) expect(await run(n, {})).not.toContain("SECRET-TOKEN");
  });
});
