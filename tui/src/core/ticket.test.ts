import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.js";
import { buildTicket, requote, type TicketDeps } from "./ticket.js";
import type { AccountSnapshot, BookView, InfoSource, MarketRow, OpenOrder, OrderIntent, PositionRow } from "./types.js";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const MASTER = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-10-18T12:00:00Z");

function market(coin: string, asset: number, markPx: number, szDecimals: number, maxLeverage: number): MarketRow {
  return {
    coin,
    asset,
    szDecimals,
    maxLeverage,
    markPx,
    midPx: null,
    prevDayPx: markPx,
    dayChangePct: 0,
    fundingHourly: 0.00001,
    fundingAprPct: 8.76,
    predictedFundingHourly: null,
    oiUsd: 1e9,
    dayVolumeUsd: 1e9,
    premium: 0,
    isDelisted: false,
    atOiCap: false,
  };
}
const markets = (ethMark = 4000) => [market("BTC", 0, 100_000, 5, 40), market("ETH", 1, ethMark, 4, 25)];

function account(o: { positions?: PositionRow[]; orders?: OpenOrder[]; equity?: number } = {}): AccountSnapshot {
  const equity = o.equity ?? 10_000;
  return { address: MASTER, equityUsd: equity, marginUsedUsd: 0, withdrawableUsd: equity, unrealizedPnlUsd: 0, positions: o.positions ?? [], orders: o.orders ?? [], at: NOW.getTime() };
}

const ethLong = (size = 0.6255): PositionRow => ({
  coin: "ETH",
  side: "long",
  size,
  entryPx: 3900,
  markPx: 4000,
  unrealizedPnlUsd: 62.55,
  notionalUsd: size * 4000,
  leverage: 3,
  liqPx: 2700,
  marginUsedUsd: (size * 4000) / 3,
  stopPx: 3800,
  tpPx: null,
  stopDistPct: -5,
  liqDistPct: -32.5,
});
const order = (oid: number, tpsl: "sl" | "tp" | null, px: number): OpenOrder => ({
  oid,
  coin: "ETH",
  side: "sell",
  size: 0.6255,
  limitPx: px,
  triggerPx: tpsl ? px : null,
  isTrigger: tpsl != null,
  reduceOnly: tpsl != null,
  tpsl,
  orderType: tpsl ? "Stop Market" : "Limit",
  timestamp: NOW.getTime(),
});

function book(coin: string, mid: number): BookView {
  return {
    coin,
    bids: [{ px: mid - 0.5, sz: 1000 }],
    asks: [{ px: mid + 0.5, sz: 1000 }],
    mid,
    spreadBps: (1 / mid) * 1e4,
    depth50Usd: { bid: 0, ask: 0 },
    slippage: [],
    at: NOW.getTime(),
  };
}

function fakeInfo(calls: string[] = [], acct: () => AccountSnapshot = () => account()): InfoSource {
  return {
    markets: async () => markets(),
    account: async (address) => {
      calls.push(`account ${address}`);
      return acct();
    },
    book: async (coin) => {
      calls.push(`book ${coin}`);
      return book(coin, coin === "ETH" ? 4000 : 100_000);
    },
    candles: async (coin, interval) => {
      calls.push(`candles ${coin} ${interval}`);
      return [];
    },
    fundingHistory: async () => [],
  };
}

const tradeEnv = { HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER, HT_MAX_NOTIONAL_USD: "5000" };
/** The fake info source answers with the same account the deps hold, unless `info` is given. */
function deps(o: Partial<TicketDeps> & { env?: Record<string, string> } = {}): TicketDeps {
  const acct = o.account === undefined ? account() : o.account;
  return {
    config: loadConfig(o.env ?? tradeEnv, []).config,
    info: o.info ?? fakeInfo([], () => acct ?? account()),
    markets: o.markets ?? markets(),
    account: acct,
    now: () => NOW,
    id: () => "t-test",
  };
}

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  asset: "ETH",
  side: "long",
  leverage: 3,
  size: { usd: 1 },
  entry: { type: "market" },
  stop: { type: "pct", pct: 2 },
  target: 4300,
  ...over,
});

describe("open tickets", () => {
  test("risk-sized happy path: resolve → governor → slippage → sendable", async () => {
    const calls: string[] = [];
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps({ info: fakeInfo(calls) }));
    expect(t.blockers).toEqual([]);
    expect(t.canSend).toBe(true);
    expect(t).toMatchObject({ id: "t-test", network: "testnet", coin: "ETH", side: "long", entryPx: 4000, stopPx: 3920, tpPx: 4300, markPx: 4000, leverage: 3 });
    // 0.5% of 10,000 at a 2% stop = 2,500 notional = 0.625 ETH
    expect(t.size).toBe(0.625);
    expect(t.notionalUsd).toBe(2500);
    expect(t.riskUsd).toBe(50);
    expect(t.riskPct).toBe(0.5);
    expect(t.rr).toBe(3.75);
    expect(t.verdict?.approved).toBe(true);
    expect(t.verdict?.sizing?.size).toBe(0.625);
    expect(t.slippageBps).toBeCloseTo(1.25, 2);
    expect(t.liqPx).not.toBeNull();
    expect(t.quotedAt).toBe(NOW.getTime());
    expect(t.notes.join(" ")).toContain("risk 0.5%");
    expect(calls).toEqual(["book ETH"]); // no candles for a pct stop
  });

  test("candles are fetched only when the stop needs them", async () => {
    const calls: string[] = [];
    const t = await buildTicket({ kind: "open", intent: intent({ stop: { type: "atr_mult", mult: 1.5 } }), riskPct: 0.5 }, deps({ info: fakeInfo(calls) }));
    expect(calls).toContain("candles ETH 1d");
    expect(t.canSend).toBe(false);
    expect(t.blockers[0]).toStartWith("resolve: ATR14 needs 15");
  });

  test("the governor clips risk above its limit and the ticket takes the smaller size", async () => {
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 1 }, deps());
    expect(t.verdict?.approved).toBe(true);
    expect(t.verdict?.warnings.join(" ")).toContain("clipped");
    expect(t.size).toBe(0.625);
    expect(t.riskPct).toBe(0.5);
    expect(t.warnings.join(" ")).toContain("size reduced from 1.25 to 0.625");
    expect(t.canSend).toBe(true);
  });

  test("governor reject blocks the ticket with its reasons", async () => {
    const t = await buildTicket({ kind: "open", intent: intent({ stop: { type: "pct", pct: 0.2 }, target: 4100 }), riskPct: 0.5 }, deps({ env: { ...tradeEnv, HT_MAX_NOTIONAL_USD: "1000000" } }));
    expect(t.verdict?.approved).toBe(false);
    expect(t.canSend).toBe(false);
    expect(t.blockers.some((b) => b.includes("under the 0.5% minimum"))).toBe(true);
    expect(t.blockers).toEqual(t.verdict!.reasons);
  });

  test("an existing position in the coin is a governor reject", async () => {
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps({ account: account({ positions: [ethLong()] }) }));
    expect(t.canSend).toBe(false);
    expect(t.blockers.join(" ")).toContain("already long ETH");
  });

  test("notional over HT_MAX_NOTIONAL_USD is a blocker", async () => {
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps({ env: { HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER } }));
    expect(t.verdict?.approved).toBe(true);
    expect(t.canSend).toBe(false);
    expect(t.blockers).toEqual(["notional $2,525.00 (mark + 1% IOC band) exceeds HT_MAX_NOTIONAL_USD $1,000.00"]);
  });

  test("read-only and demo still quote but cannot send", async () => {
    const ro = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps({ env: { HT_ACCOUNT: MASTER, HT_MAX_NOTIONAL_USD: "5000" } }));
    expect(ro.size).toBe(0.625);
    expect(ro.blockers).toEqual(["read-only: no HT_AGENT_KEY"]);
    expect(ro.canSend).toBe(false);
    const demo = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, { ...deps(), config: loadConfig({ HT_MAX_NOTIONAL_USD: "5000" }, ["--demo"]).config });
    expect(demo.blockers).toEqual(["demo: orders disabled"]);
  });

  test("no account, unknown coin, delisted coin", async () => {
    expect((await buildTicket({ kind: "open", intent: intent() }, deps({ account: null }))).blockers).toContain("no account configured: set HT_ACCOUNT or HT_AGENT_KEY");
    expect((await buildTicket({ kind: "open", intent: intent({ asset: "NOPE" }) }, deps())).blockers).toContain("NOPE is not a listed Hyperliquid perp");
    const ms = markets();
    ms[1]!.isDelisted = true;
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps({ markets: ms }));
    expect(t.canSend).toBe(false);
    expect(t.blockers).toContain("ETH is delisted");
  });

  test("a usd-sized intent keeps its notional; no target means no R:R", async () => {
    const t = await buildTicket({ kind: "open", intent: intent({ size: { usd: 800 }, target: undefined, side: "short", stop: { type: "price", px: 4100 } }) }, deps());
    expect(t).toMatchObject({ side: "short", size: 0.2, notionalUsd: 800, stopPx: 4100, rr: null, canSend: true });
    expect(t.verdict?.warnings).toContain("no target: reward:risk not checked");
  });
});

describe("close tickets", () => {
  const withPos = () => account({ positions: [ethLong()], orders: [order(11, "sl", 3800), order(12, "tp", 4400), order(13, null, 3500)] });

  test("pct sizing floors to szDecimals; 100% is the exact size and captures leftover triggers", async () => {
    const half = await buildTicket({ kind: "close", coin: "ETH", pct: 50 }, deps({ account: withPos() }));
    expect(half).toMatchObject({ side: "long", size: 0.3127, canSend: true, verdict: null, stopPx: 3800 });
    expect((half.action as { cleanupOids?: number[] }).cleanupOids).toBeUndefined();
    const full = await buildTicket({ kind: "close", coin: "ETH", pct: 100 }, deps({ account: withPos() }));
    expect(full.size).toBe(0.6255);
    expect((full.action as { cleanupOids?: number[] }).cleanupOids).toEqual([11, 12]);
    expect(full.slippageBps).not.toBeNull();
  });

  test("closes are not capped by notional, only warned", async () => {
    const t = await buildTicket({ kind: "close", coin: "ETH", pct: 100 }, deps({ env: { HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER, HT_MAX_NOTIONAL_USD: "100" }, account: withPos() }));
    expect(t.canSend).toBe(true);
    expect(t.notionalUsd).toBe(2502);
    expect(t.warnings.join(" ")).toContain("not capped");
  });

  test("no position or a bad percent blocks", async () => {
    expect((await buildTicket({ kind: "close", coin: "BTC", pct: 100 }, deps({ account: withPos() }))).blockers).toEqual(["no open BTC position"]);
    expect((await buildTicket({ kind: "close", coin: "ETH", pct: 0 }, deps({ account: withPos() }))).canSend).toBe(false);
    expect((await buildTicket({ kind: "close", coin: "ETH", pct: 150 }, deps({ account: withPos() }))).canSend).toBe(false);
    expect((await buildTicket({ kind: "close", coin: "ETH", pct: 0.001 }, deps({ account: withPos() }))).blockers).toContain("close size rounds to zero");
  });
});

describe("cancel tickets", () => {
  const acc = () => account({ positions: [ethLong()], orders: [order(11, "sl", 3800), order(13, null, 3500)] });
  test("oids must be open orders on the named coin", async () => {
    const ok = await buildTicket({ kind: "cancel", oids: [{ coin: "ETH", oid: 13 }] }, deps({ account: acc() }));
    expect(ok.canSend).toBe(true);
    expect(ok.notes[0]).toContain("13 ETH sell");
    const missing = await buildTicket({ kind: "cancel", oids: [{ coin: "ETH", oid: 99 }] }, deps({ account: acc() }));
    expect(missing.blockers).toEqual(["order 99 is not among the open orders"]);
    const wrongCoin = await buildTicket({ kind: "cancel", oids: [{ coin: "BTC", oid: 13 }] }, deps({ account: acc() }));
    expect(wrongCoin.canSend).toBe(false);
  });
  test("cancelling the only stop warns", async () => {
    const t = await buildTicket({ kind: "cancel", oids: [{ coin: "ETH", oid: 11 }] }, deps({ account: acc() }));
    expect(t.canSend).toBe(true);
    expect(t.warnings.join(" ")).toContain("without a stop");
  });
});

describe("stop tickets", () => {
  const acc = () => account({ positions: [ethLong()], orders: [order(11, "sl", 3800), order(12, "tp", 4400)] });
  test("a stop on the loss side replaces the existing sl triggers", async () => {
    const t = await buildTicket({ kind: "stop", coin: "ETH", px: 3900 }, deps({ account: acc() }));
    expect(t).toMatchObject({ canSend: true, side: "long", size: 0.6255, stopPx: 3900, riskUsd: 62.55 });
    expect((t.action as { replaceOids?: number[] }).replaceOids).toEqual([11]);
  });
  test("a stop on the wrong side of the mark is blocked", async () => {
    const t = await buildTicket({ kind: "stop", coin: "ETH", px: 4100 }, deps({ account: acc() }));
    expect(t.canSend).toBe(false);
    expect(t.blockers[0]).toContain("wrong side of the mark");
  });
  test("no position blocks", async () => {
    expect((await buildTicket({ kind: "stop", coin: "ETH", px: 3900 }, deps())).blockers).toEqual(["no open ETH position"]);
  });
});

describe("requote", () => {
  test("same market → same, fresh quotedAt and same id", async () => {
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps());
    const later = new Date(NOW.getTime() + 5000);
    const r = await requote(t, { ...deps(), now: () => later, id: () => "other" });
    expect(r.kind).toBe("same");
    expect(r.ticket.id).toBe("t-test");
    expect(r.ticket.quotedAt).toBe(later.getTime());
    expect(r.ticket.size).toBe(t.size);
  });

  test("a mark move over 0.5% is a change", async () => {
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps());
    const r = await requote(t, deps({ markets: markets(4040) }));
    expect(r.kind).toBe("changed");
    if (r.kind === "changed") expect(r.why).toContain("mark moved +1%");
  });

  test("a blocker change (cap now exceeded) is a change", async () => {
    const t = await buildTicket({ kind: "open", intent: intent({ size: { usd: 900 } }) }, deps({ env: { HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER } }));
    expect(t.canSend).toBe(true);
    const r = await requote(t, deps({ env: { HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER, HT_MAX_NOTIONAL_USD: "500" } }));
    expect(r.kind).toBe("changed");
    if (r.kind === "changed") expect(r.why).toContain("now blocked");
  });

  test("requote recaptures stop oids from the fresh account", async () => {
    const acc = account({ positions: [ethLong()], orders: [order(11, "sl", 3800)] });
    const t = await buildTicket({ kind: "stop", coin: "ETH", px: 3900 }, deps({ account: acc }));
    const fresh = account({ positions: [ethLong()], orders: [order(21, "sl", 3850)] });
    const r = await requote(t, { ...deps({ account: acc }), info: fakeInfo([], () => fresh) });
    expect(r.kind).toBe("same");
    expect((r.ticket.action as { replaceOids?: number[] }).replaceOids).toEqual([21]);
  });
});

describe("review fixes", () => {
  test("ticket ids carry 64 random bits", async () => {
    const d = deps();
    delete d.id;
    const a = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, d);
    const b = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, d);
    expect(a.id).toMatch(/^t-[0-9a-f]{16}$/);
    expect(a.id).not.toBe(b.id);
  });

  test("the notional cap is checked at the far edge of the IOC band", async () => {
    // $990 → 0.2475 ETH: $999.90 at mark + 1%, passes. $995 → 0.2487 ETH: $994.80 at the mark but $1,004.75 at mark + 1%, blocked.
    const ok = await buildTicket({ kind: "open", intent: intent({ size: { usd: 990 } }) }, deps({ env: { HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER } }));
    expect(ok.canSend).toBe(true);
    const over = await buildTicket({ kind: "open", intent: intent({ size: { usd: 995 } }) }, deps({ env: { HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER } }));
    expect(over.notionalUsd).toBe(994.8);
    expect(over.blockers[0]).toContain("(mark + 1% IOC band) exceeds HT_MAX_NOTIONAL_USD");
  });

  test("a limit more than the slippage band through the mark is blocked; inside the band it only warns", async () => {
    const far = await buildTicket({ kind: "open", intent: intent({ entry: { type: "limit", px: 4050 }, target: 4400 }), riskPct: 0.5 }, deps());
    expect(far.blockers.join(" ")).toContain("more than 1% through the mark");
    const near = await buildTicket({ kind: "open", intent: intent({ entry: { type: "limit", px: 4030 }, target: 4400 }), riskPct: 0.5 }, deps());
    expect(near.canSend).toBe(true);
    expect(near.warnings.join(" ")).toContain("fills at once");
    const shortFar = await buildTicket({ kind: "open", intent: intent({ side: "short", entry: { type: "limit", px: 3950 }, target: 3600 }), riskPct: 0.5 }, deps());
    expect(shortFar.canSend).toBe(false);
  });

  test("stop, TP and limit are venue-rounded and sized on the rounded values", async () => {
    const t = await buildTicket(
      { kind: "open", intent: intent({ entry: { type: "limit", px: 3990.04 }, stop: { type: "price", px: 3912.345 }, target: 4300.06 }), riskPct: 0.5 },
      deps(),
    );
    expect(t).toMatchObject({ entryPx: 3990, stopPx: 3912.3, tpPx: 4300.1 });
    expect(t.riskUsd).toBeCloseTo(t.size! * (3990 - 3912.3), 2);
    expect(t.notes.filter((n) => n.includes("rounded to the venue price"))).toHaveLength(3);
    const pct = await buildTicket({ kind: "open", intent: intent({ stop: { type: "pct", pct: 1.2345 } }), riskPct: 0.5 }, deps());
    expect(pct.stopPx).toBe(3950.6); // 4000 × (1 − 1.2345%) = 3950.62 → 5 significant figures
    expect(pct.notes.some((n) => n.startsWith("stop = 1.2345% below entry"))).toBe(true);
    const stop = await buildTicket({ kind: "stop", coin: "ETH", px: 3900.123 }, deps({ account: account({ positions: [ethLong()] }) }));
    expect(stop.stopPx).toBe(3900.1);
  });

  test("a resting entry on the same coin blocks like a position", async () => {
    const resting: OpenOrder = { ...order(50, null, 3950), side: "buy", reduceOnly: false };
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps({ account: account({ orders: [resting] }) }));
    expect(t.canSend).toBe(false);
    expect(t.blockers).toContain("resting entry order on ETH (oid 50): cancel before opening another");
    expect(t.blockers.join(" ")).toContain("already long ETH");
  });

  test("resting entries elsewhere count toward open risk: unprotected by their whole notional, protected by their stop", async () => {
    const btcBuy: OpenOrder = { oid: 60, coin: "BTC", side: "buy", size: 0.015, limitPx: 100_000, triggerPx: null, isTrigger: false, reduceOnly: false, tpsl: null, orderType: "Limit", timestamp: NOW.getTime() };
    const naked = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps({ account: account({ orders: [btcBuy] }) }));
    // $1,500 unprotected exceeds the 2% ($200) open-risk budget: nothing left for a new trade
    expect(naked.canSend).toBe(false);
    expect(naked.verdict?.warnings.join(" ")).toContain("open-risk budget");
    const btcStop: OpenOrder = { ...btcBuy, oid: 61, side: "sell", triggerPx: 99_000, limitPx: 99_000, isTrigger: true, reduceOnly: true, tpsl: "sl" };
    const covered = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps({ account: account({ orders: [btcBuy, btcStop] }) }));
    expect(covered.canSend).toBe(true); // $15 at risk leaves $185 of budget, the new trade needs $50
    expect(covered.verdict?.sizing?.grossLeverageAfter).toBe(0.4); // (1,500 + 2,500) / 10,000
  });

  test("requote refetches the account; a fetch failure falls back to the snapshot with a warning", async () => {
    const calls: string[] = [];
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps());
    const withPos = account({ positions: [ethLong()] });
    const r = await requote(t, { ...deps(), info: fakeInfo(calls, () => withPos) });
    expect(calls[0]).toBe(`account ${MASTER}`);
    expect(r.kind).toBe("changed");
    expect(r.ticket.blockers.join(" ")).toContain("already long ETH");

    const failing: InfoSource = { ...fakeInfo(), account: async () => Promise.reject(new Error("HTTP 502")) };
    const f = await requote(t, { ...deps(), info: failing });
    expect(f.kind).toBe("same");
    expect(f.ticket.warnings).toContain("account refresh failed (HTTP 502): re-quoted on the last snapshot");
  });

  test("requote flags leverage and fixed-price changes", async () => {
    const t = await buildTicket({ kind: "open", intent: intent(), riskPct: 0.5 }, deps());
    const ms = markets();
    ms[1]!.maxLeverage = 2;
    const lev = await requote(t, deps({ markets: ms }));
    expect(lev.kind).toBe("changed");
    if (lev.kind === "changed") expect(lev.why).toContain("leverage 3 → 2");

    const acc = account({ positions: [ethLong()] });
    const s = await buildTicket({ kind: "stop", coin: "ETH", px: 3900 }, deps({ account: acc }));
    const moved = account({ positions: [{ ...ethLong(), entryPx: 3950 }] });
    const r = await requote(s, { ...deps({ account: acc }), info: fakeInfo([], () => moved) });
    expect(r.kind).toBe("changed");
    if (r.kind === "changed") expect(r.why).toContain("entry 3900 → 3950");
  });
});
