import { describe, expect, test } from "bun:test";
import accountOrdersFx from "./fixtures/account-orders.json";
import accountStateFx from "./fixtures/account-state.json";
import bookBtcFx from "./fixtures/book-BTC.json";
import candlesBtc1hFx from "./fixtures/candles-BTC-1h.json";
import fundingBtcFx from "./fixtures/funding-BTC.json";
import metaFx from "./fixtures/meta.json";
import predictedFx from "./fixtures/predicted.json";
import { accountFromRaw, bookViewFromRaw, HlInfo, infoBase, marketsFromRaw, type FetchFn } from "./info.js";

const meta = metaFx as unknown as [{ universe: Array<{ name: string }> }, Array<Record<string, string>>];

type Handler = (body: Record<string, unknown>) => unknown;

/** fetch stub: routes by request type, records urls and bodies. Handlers returning a number reply with that HTTP status. */
function fakeFetch(routes: Record<string, Handler>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn: FetchFn = async (input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(input), body });
    const out = routes[body.type]?.(body);
    if (typeof out === "number") return new Response("nope", { status: out });
    return new Response(JSON.stringify(out ?? null), { status: 200 });
  };
  return { fn, calls };
}

const ok = (x: unknown): Handler => () => x;

describe("infoBase", () => {
  test("maps network to host", () => {
    expect(infoBase("mainnet")).toBe("https://api.hyperliquid.xyz");
    expect(infoBase("testnet")).toBe("https://api.hyperliquid-testnet.xyz");
  });
});

describe("marketsFromRaw", () => {
  const rows = marketsFromRaw(metaFx, predictedFx, ["ETH"]);
  const btc = rows.find((r) => r.coin === "BTC")!;

  test("one row per universe entry, asset = index", () => {
    expect(rows).toHaveLength(meta[0].universe.length);
    expect(rows.every((r, i) => r.asset === i)).toBe(true);
    expect(btc.asset).toBe(0);
  });

  test("derived fields", () => {
    const ctx = meta[1][0]!;
    expect(btc.oiUsd).toBeCloseTo(Number(ctx.openInterest) * Number(ctx.markPx), 4);
    expect(btc.fundingAprPct).toBeCloseTo(Number(ctx.funding) * 24 * 365 * 100, 8);
    expect(btc.dayChangePct).toBeCloseTo(((Number(ctx.markPx) - Number(ctx.prevDayPx)) / Number(ctx.prevDayPx)) * 100, 8);
    expect(btc.dayVolumeUsd).toBe(Number(ctx.dayNtlVlm));
    expect(btc.midPx).toBeNull();
    expect(btc.maxLeverage).toBe(40);
  });

  test("predicted funding comes from the HlPerp entry; OI cap flags apply", () => {
    expect(btc.predictedFundingHourly).not.toBeNull();
    expect(rows.find((r) => r.coin === "ETH")!.atOiCap).toBe(true);
    expect(btc.atOiCap).toBe(false);
  });

  test("optional payloads may be missing or malformed", () => {
    const bare = marketsFromRaw(metaFx, { nonsense: true }, "x");
    expect(bare[0]!.predictedFundingHourly).toBeNull();
    expect(bare.some((r) => r.atOiCap)).toBe(false);
  });

  test("a malformed main payload throws", () => {
    expect(() => marketsFromRaw({ universe: [] })).toThrow();
  });

  test("null premium stays null", () => {
    const raw = structuredClone(metaFx) as unknown as [unknown, Array<{ premium: string | null }>];
    raw[1][0]!.premium = null;
    expect(marketsFromRaw(raw)[0]!.premium).toBeNull();
  });
});

describe("accountFromRaw", () => {
  const markets = marketsFromRaw(metaFx);
  const acct = accountFromRaw("0xabc", accountStateFx, accountOrdersFx, markets, 123);
  const btc = acct.positions.find((p) => p.coin === "BTC")!;
  const eth = acct.positions.find((p) => p.coin === "ETH")!;

  test("totals and positions", () => {
    expect(acct.at).toBe(123);
    expect(acct.equityUsd).toBeCloseTo(Number(accountStateFx.marginSummary.accountValue), 6);
    expect(acct.marginUsedUsd).toBeCloseTo(Number(accountStateFx.marginSummary.totalMarginUsed), 6);
    expect(acct.withdrawableUsd).toBeCloseTo(Number(accountStateFx.withdrawable), 6);
    expect(acct.positions).toHaveLength(2);
    expect(btc.side).toBe("long");
    expect(eth.side).toBe("short");
    expect(eth.size).toBe(3);
    expect(btc.markPx).toBe(markets.find((m) => m.coin === "BTC")!.markPx);
    expect(acct.unrealizedPnlUsd).toBeCloseTo(btc.unrealizedPnlUsd + eth.unrealizedPnlUsd, 6);
  });

  test("stop/tp come from reduce-only trigger orders by orderType", () => {
    const sl = acct.orders.find((o) => o.orderType === "Stop Market")!;
    const tp = acct.orders.find((o) => o.orderType === "Take Profit Market")!;
    expect(sl.tpsl).toBe("sl");
    expect(tp.tpsl).toBe("tp");
    expect(btc.stopPx).toBe(sl.triggerPx!);
    expect(btc.tpPx).toBe(tp.triggerPx!);
    expect(eth.stopPx).toBeNull();
    expect(eth.tpPx).toBeNull();
  });

  test("a resting limit order is not a stop", () => {
    const limit = acct.orders.find((o) => o.orderType === "Limit")!;
    expect(limit.isTrigger).toBe(false);
    expect(limit.tpsl).toBeNull();
    expect(limit.triggerPx).toBeNull();
    expect(limit.side).toBe("buy");
  });

  test("a non-reduce-only stop does not protect the position", () => {
    const orders = accountOrdersFx.map((o) => (o.orderType === "Stop Market" ? { ...o, reduceOnly: false } : o));
    expect(accountFromRaw("0xabc", accountStateFx, orders, markets, 1).positions.find((p) => p.coin === "BTC")!.stopPx).toBeNull();
  });

  test("distances are signed from mark: negative toward stop and liq for a long", () => {
    expect(btc.stopDistPct!).toBeLessThan(0);
    expect(btc.stopDistPct!).toBeCloseTo(((btc.stopPx! - btc.markPx) / btc.markPx) * 100, 8);
    expect(btc.liqDistPct!).toBeLessThan(btc.stopDistPct!);
    expect(eth.liqDistPct!).toBeLessThan(0); // short: liq is above mark, still the adverse direction
    expect(eth.stopDistPct).toBeNull();
  });

  test("a short's stop above mark is negative", () => {
    const orders = [{ ...accountOrdersFx[0]!, coin: "ETH", side: "B", triggerPx: String(eth.markPx * 1.05), oid: 5 }];
    const e = accountFromRaw("0xabc", accountStateFx, orders, markets, 1).positions.find((p) => p.coin === "ETH")!;
    expect(e.stopDistPct!).toBeCloseTo(-5, 6);
  });

  test("falls back to positionValue / size when the coin is not in markets", () => {
    const a = accountFromRaw("0xabc", accountStateFx, [], [], 1);
    expect(a.positions[0]!.markPx).toBeCloseTo(Number(accountStateFx.assetPositions[0]!.position.positionValue) / 0.15, 4);
  });

  test("malformed payloads throw instead of dropping orders", () => {
    expect(() => accountFromRaw("0xabc", accountStateFx, [{ coin: "BTC", oid: "x" }], markets, 1)).toThrow();
    expect(() => accountFromRaw("0xabc", { marginSummary: {} }, [], markets, 1)).toThrow();
  });
});

describe("bookViewFromRaw", () => {
  const view = bookViewFromRaw("BTC", bookBtcFx, 7);

  test("mid, spread, depth", () => {
    const bid = Number(bookBtcFx.levels[0]![0]!.px);
    const ask = Number(bookBtcFx.levels[1]![0]!.px);
    expect(view.mid).toBe((bid + ask) / 2);
    expect(view.spreadBps!).toBeCloseTo(((ask - bid) / view.mid!) * 1e4, 8);
    expect(view.bids[0]!.px).toBe(bid);
    expect(view.depth50Usd.bid).toBeGreaterThan(0);
    expect(view.at).toBe(7);
  });

  test("slippage ladder for 10k / 50k / 250k grows with size; thin books give null", () => {
    expect(view.slippage.map((s) => s.sizeUsd)).toEqual([10_000, 50_000, 250_000]);
    const [a, b] = view.slippage;
    expect(a!.buyBps!).toBeGreaterThanOrEqual(0);
    expect(b!.buyBps!).toBeGreaterThanOrEqual(a!.buyBps!);
    const thin = bookViewFromRaw("X", { levels: [[{ px: "99", sz: "1" }], [{ px: "101", sz: "1" }]] }, 1);
    expect(thin.slippage[0]!.buyBps).toBeNull();
    expect(thin.slippage[0]!.sellBps).toBeNull();
  });

  test("an empty or crossed book throws", () => {
    expect(() => bookViewFromRaw("X", { levels: [[], []] }, 1)).toThrow(/no usable order book/);
    expect(() => bookViewFromRaw("X", { levels: [[{ px: "101", sz: "1" }], [{ px: "100", sz: "1" }]] }, 1)).toThrow();
  });
});

describe("HlInfo over a fake fetch", () => {
  const routes = {
    metaAndAssetCtxs: ok(metaFx),
    predictedFundings: ok(predictedFx),
    perpsAtOpenInterestCap: ok(["SOL"]),
    clearinghouseState: ok(accountStateFx),
    frontendOpenOrders: ok(accountOrdersFx),
    l2Book: ok(bookBtcFx),
    candleSnapshot: ok(candlesBtc1hFx),
    fundingHistory: ok(fundingBtcFx.slice(0, 10)),
  };

  test("posts to the network's /info endpoint", async () => {
    const f = fakeFetch(routes);
    await new HlInfo("testnet", f.fn).markets();
    expect(f.calls.length).toBeGreaterThan(0);
    expect(new Set(f.calls.map((c) => c.url))).toEqual(new Set(["https://api.hyperliquid-testnet.xyz/info"]));
    const m = fakeFetch(routes);
    await new HlInfo("mainnet", m.fn).book("BTC");
    expect(m.calls[0]!.url).toBe("https://api.hyperliquid.xyz/info");
    expect(m.calls[0]!.body).toEqual({ type: "l2Book", coin: "BTC" });
  });

  test("markets merges predicted fundings and the OI cap list", async () => {
    const rows = await new HlInfo("mainnet", fakeFetch(routes).fn).markets();
    expect(rows.find((r) => r.coin === "SOL")!.atOiCap).toBe(true);
    expect(rows[0]!.predictedFundingHourly).not.toBeNull();
  });

  test("markets tolerates predictedFundings and OI-cap failures", async () => {
    const rows = await new HlInfo("mainnet", fakeFetch({ ...routes, predictedFundings: () => 404, perpsAtOpenInterestCap: () => 404 }).fn).markets();
    expect(rows).toHaveLength(meta[0].universe.length);
    expect(rows[0]!.predictedFundingHourly).toBeNull();
    expect(rows.some((r) => r.atOiCap)).toBe(false);
  });

  test("markets fails when metaAndAssetCtxs fails", async () => {
    await expect(new HlInfo("mainnet", fakeFetch({ ...routes, metaAndAssetCtxs: () => 404 }).fn).markets()).rejects.toThrow("HL 404");
  });

  test("account reads clearinghouseState + frontendOpenOrders for the address", async () => {
    const f = fakeFetch(routes);
    const markets = await new HlInfo("mainnet", fakeFetch(routes).fn).markets();
    const a = await new HlInfo("mainnet", f.fn).account("0xabc", markets);
    expect(f.calls.map((c) => c.body).sort((x, y) => String(x.type).localeCompare(String(y.type)))).toEqual([
      { type: "clearinghouseState", user: "0xabc" },
      { type: "frontendOpenOrders", user: "0xabc" },
    ]);
    expect(a.address).toBe("0xabc");
    expect(a.positions.find((p) => p.coin === "BTC")!.stopPx).not.toBeNull();
  });

  test("account rejects on an upstream error", async () => {
    await expect(new HlInfo("mainnet", fakeFetch({ ...routes, clearinghouseState: () => 404 }).fn).account("0xabc", [])).rejects.toThrow("HL 404");
  });

  test("candles and funding history are numeric and ascending", async () => {
    const info = new HlInfo("mainnet", fakeFetch(routes).fn);
    const c = await info.candles("BTC", "1h", 0);
    expect(c.length).toBe(candlesBtc1hFx.length);
    expect(typeof c[0]!.o).toBe("number");
    expect(c.every((x, i) => i === 0 || x.t > c[i - 1]!.t)).toBe(true);
    const f = await info.fundingHistory("BTC", 0);
    expect(f).toHaveLength(10);
    expect(f[0]!.rate).toBe(Number(fundingBtcFx[0]!.fundingRate));
  });
});
