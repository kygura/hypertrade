import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { actionHash, addressOf, agentDigest } from "../../../src/server/desk/hl/signing.js";
import { loadConfig } from "./config.js";
import { API_BASE, buildCancelAction, buildCloseAction, buildOpenActions, buildStopActions, createExchange } from "./exchange.js";
import { buildTicket, type TicketDeps } from "./ticket.js";
import type { AccountSnapshot, BookView, Config, InfoSource, MarketRow, OpenOrder, OrderIntent, PositionRow, Ticket } from "./types.js";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const MASTER = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-10-18T12:00:00Z");
const T0 = NOW.getTime();

function market(coin: string, asset: number, markPx: number, szDecimals: number, maxLeverage: number): MarketRow {
  return { coin, asset, szDecimals, maxLeverage, markPx, midPx: null, prevDayPx: markPx, dayChangePct: 0, fundingHourly: 0, fundingAprPct: 0, predictedFundingHourly: null, oiUsd: 1e9, dayVolumeUsd: 1e9, premium: 0, isDelisted: false, atOiCap: false };
}
const MARKETS = [market("BTC", 0, 100_000, 5, 40), market("ETH", 1, 4000, 4, 25)];
const ETH = MARKETS[1]!;

const pos: PositionRow = { coin: "ETH", side: "long", size: 0.6255, entryPx: 3900, markPx: 4000, unrealizedPnlUsd: 0, notionalUsd: 2502, leverage: 3, liqPx: 2700, marginUsedUsd: 834, stopPx: 3800, tpPx: 4400, stopDistPct: -5, liqDistPct: -32 };
const ord = (oid: number, tpsl: "sl" | "tp" | null, px: number): OpenOrder => ({ oid, coin: "ETH", side: "sell", size: 0.6255, limitPx: px, triggerPx: tpsl ? px : null, isTrigger: tpsl != null, reduceOnly: tpsl != null, tpsl, orderType: "x", timestamp: T0 });
function account(withPos = false): AccountSnapshot {
  return { address: MASTER, equityUsd: 10_000, marginUsedUsd: 0, withdrawableUsd: 10_000, unrealizedPnlUsd: 0, positions: withPos ? [pos] : [], orders: withPos ? [ord(11, "sl", 3800), ord(12, "tp", 4400), ord(13, null, 3500)] : [], at: T0 };
}
const book = (coin: string, mid: number): BookView => ({ coin, bids: [{ px: mid - 0.5, sz: 1000 }], asks: [{ px: mid + 0.5, sz: 1000 }], mid, spreadBps: 1, depth50Usd: { bid: 0, ask: 0 }, slippage: [], at: T0 });
const info: InfoSource = {
  markets: async () => MARKETS,
  account: async () => account(),
  book: async (coin) => book(coin, coin === "ETH" ? 4000 : 100_000),
  candles: async () => [],
  fundingHistory: async () => [],
};

function cfg(env: Record<string, string> = {}): Config {
  return loadConfig({ HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER, HT_MAX_NOTIONAL_USD: "5000", ...env }, []).config;
}
function deps(config = cfg(), withPos = false): TicketDeps {
  return { config, info, markets: MARKETS, account: account(withPos), now: () => NOW, id: () => "t-x" };
}
const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({ asset: "ETH", side: "long", leverage: 3, size: { usd: 1 }, entry: { type: "market" }, stop: { type: "pct", pct: 2 }, target: 4300, ...over });
const openTicket = (over: Partial<OrderIntent> = {}, config = cfg()) => buildTicket({ kind: "open", intent: intent(over), riskPct: 0.5 }, deps(config));

type Posted = { url: string; body: { action: any; nonce: number; signature: { r: string; s: string; v: number }; vaultAddress: string | null; expiresAfter: null } };

type InfoReply = (body: { type: string; [k: string]: unknown }) => unknown;
/** Fake /info for flatten and close reads: a fresh mid of 3990 and a flat account, unless overridden. */
const defaultInfo: InfoReply = (b) => (b.type === "allMids" ? { ETH: "3990", BTC: "100000" } : b.type === "clearinghouseState" ? { assetPositions: [] } : null);

/** Fake HL API: records /exchange posts (verifying every signature against KEY) and /info reads; answers from scripts. */
function fakeExchange(responses: unknown[], isMainnet = false, info: InfoReply = defaultInfo) {
  const posted: Posted[] = [];
  const infos: Array<{ type: string; [k: string]: unknown }> = [];
  const queue = [...responses];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/info")) {
      infos.push(body);
      const reply = info(body);
      return reply == null ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify(reply), { status: 200 });
    }
    const digest = agentDigest(actionHash(body.action, body.vaultAddress, body.nonce, null), isMainnet);
    const sig = new secp256k1.Signature(BigInt(body.signature.r), BigInt(body.signature.s), body.signature.v - 27);
    expect(`0x${bytesToHex(keccak_256(sig.recoverPublicKey(digest).toBytes(false).slice(1)).slice(-20))}`).toBe(addressOf(KEY));
    posted.push({ url: String(url), body });
    const next = queue.shift() ?? { status: "err", response: "unscripted" };
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, posted, infos };
}
const okDefault = { status: "ok", response: { type: "default" } };
const orderOk = (...statuses: unknown[]) => ({ status: "ok", response: { type: "order", data: { statuses } } });
const cancelOk = (...statuses: unknown[]) => ({ status: "ok", response: { type: "cancel", data: { statuses } } });
const clock = (ms = T0 + 1000) => () => ms;

describe("action builders", () => {
  test("open: leverage, then normalTpsl [IOC entry through the mark, reduce-only SL, TP]", async () => {
    const t = await openTicket();
    const [lev, order] = buildOpenActions(t, ETH, 0.01);
    expect(lev).toEqual({ type: "updateLeverage", asset: 1, isCross: true, leverage: 3 });
    expect(order.grouping).toBe("normalTpsl");
    expect(order.orders).toEqual([
      { a: 1, b: true, p: "4040", s: "0.625", r: false, t: { limit: { tif: "Ioc" } } },
      { a: 1, b: false, p: "3880.8", s: "0.625", r: true, t: { trigger: { isMarket: true, triggerPx: "3920", tpsl: "sl" } } },
      { a: 1, b: false, p: "4257", s: "0.625", r: true, t: { trigger: { isMarket: true, triggerPx: "4300", tpsl: "tp" } } },
    ]);
    expect(Object.keys(order)).toEqual(["type", "orders", "grouping"]);
    expect(Object.keys(order.orders[1]!)).toEqual(["a", "b", "p", "s", "r", "t"]);
  });

  test("open: a short without target, and a Gtc limit entry", async () => {
    const short = await openTicket({ side: "short", target: undefined, stop: { type: "price", px: 4080 } });
    const [, o] = buildOpenActions(short, ETH, 0.01);
    expect(o.orders.map((x) => [x.b, x.r, x.t.trigger?.tpsl ?? x.t.limit?.tif])).toEqual([
      [false, false, "Ioc"],
      [true, true, "sl"],
    ]);
    const lim = await openTicket({ entry: { type: "limit", px: 3990 } });
    const [, l] = buildOpenActions(lim, ETH, 0.01);
    expect(l.orders[0]).toMatchObject({ b: true, p: "3990", r: false, t: { limit: { tif: "Gtc" } } });
  });

  test("the wire carries exactly the ticket's venue-rounded prices", async () => {
    const t = await buildTicket({ kind: "open", intent: intent({ entry: { type: "limit", px: 3990.04 }, stop: { type: "price", px: 3912.345 }, target: 4300.06 }), riskPct: 0.5 }, deps());
    const [, o] = buildOpenActions(t, ETH, 0.01);
    expect([o.orders[0]!.p, o.orders[1]!.t.trigger?.triggerPx, o.orders[2]!.t.trigger?.triggerPx]).toEqual([String(t.entryPx), String(t.stopPx), String(t.tpPx)]);
    expect([t.entryPx, t.stopPx, t.tpPx]).toEqual([3990, 3912.3, 4300.1]);
  });

  test("open builder refuses a mismatched market and a non-open ticket", async () => {
    const t = await openTicket();
    expect(() => buildOpenActions(t, MARKETS[0]!, 0.01)).toThrow("does not match");
    expect(() => buildCloseAction(t, ETH, 0.01)).toThrow("not a close ticket");
  });

  test("close: one reduce-only IOC opposite the position", async () => {
    const t = await buildTicket({ kind: "close", coin: "ETH", pct: 50 }, deps(cfg(), true));
    expect(buildCloseAction(t, ETH, 0.01)).toEqual({ type: "order", orders: [{ a: 1, b: false, p: "3960", s: "0.3127", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
  });

  test("cancel: asset index per coin", async () => {
    const t = await buildTicket({ kind: "cancel", oids: [{ coin: "ETH", oid: 13 }, { coin: "ETH", oid: 11 }] }, deps(cfg(), true));
    expect(buildCancelAction(t, MARKETS)).toEqual({ type: "cancel", cancels: [{ a: 1, o: 13 }, { a: 1, o: 11 }] });
  });

  test("stop: place a positionTpsl SL for the full size, then cancel the old SL", async () => {
    const t = await buildTicket({ kind: "stop", coin: "ETH", px: 3900 }, deps(cfg(), true));
    const [place, cancel] = buildStopActions(t, ETH, 0.01);
    expect(place).toEqual({ type: "order", orders: [{ a: 1, b: false, p: "3861", s: "0.6255", r: true, t: { trigger: { isMarket: true, triggerPx: "3900", tpsl: "sl" } } }], grouping: "positionTpsl" });
    expect(cancel).toEqual({ type: "cancel", cancels: [{ a: 1, o: 11 }] });
  });
});

describe("createExchange", () => {
  test("null without a key, read-only or demo", () => {
    expect(createExchange(cfg(), null)).toBeNull();
    expect(createExchange(loadConfig({}, []).config, KEY)).toBeNull();
    expect(createExchange(loadConfig({ HT_AGENT_KEY: KEY }, ["--demo"]).config, KEY)).toBeNull();
    expect(createExchange(cfg(), KEY)).not.toBeNull();
  });

  test("posts signed actions to the configured network with monotonic nonces; signatures are deterministic", async () => {
    const t = await openTicket();
    const run = async (config: Config, mainnet: boolean) => {
      const fx = fakeExchange([okDefault, orderOk({ filled: { totalSz: "0.625", avgPx: "4001.5", oid: 77 } }, { resting: { oid: 78 } }, { resting: { oid: 79 } })], mainnet);
      const ex = createExchange(config, KEY, { fetchFn: fx.fetchFn, now: clock() })!;
      const r = await ex.send({ ...t, network: config.network }, MARKETS);
      return { r, posted: fx.posted };
    };
    const a = await run(cfg(), false);
    const b = await run(cfg(), false);
    expect(a.r).toEqual({ ok: true, lines: ["leverage 3x cross set on ETH", "filled 0.625 ETH @ 4,001.5 (oid 77)", "stop oid 78 resting @ 3,920", "take-profit oid 79 resting @ 4,300"], errors: [], oids: [77, 78, 79] });
    expect(a.posted.map((p) => p.url)).toEqual([`${API_BASE.testnet}/exchange`, `${API_BASE.testnet}/exchange`]);
    expect(a.posted[0]!.body.nonce).toBe(T0 + 1000);
    expect(a.posted[1]!.body.nonce).toBe(T0 + 1001);
    expect(a.posted[1]!.body.vaultAddress).toBeNull();
    expect(a.posted.map((p) => p.body.signature)).toEqual(b.posted.map((p) => p.body.signature));
    // The key never travels.
    expect(JSON.stringify(a.posted).toLowerCase()).not.toContain(KEY.slice(2, 18));

    const main = await run(cfg({ HT_NETWORK: "mainnet" }), true);
    expect(main.r.ok).toBe(true);
    expect(main.posted[0]!.url).toBe(`${API_BASE.mainnet}/exchange`);
    expect(main.posted[1]!.body.signature).not.toEqual(a.posted[1]!.body.signature);
  });

  test("pending tpsl status strings count as accepted", async () => {
    const t = await openTicket();
    const fx = fakeExchange([okDefault, orderOk({ filled: { totalSz: "0.625", avgPx: "4000", oid: 1 } }, "waitingForTrigger", "waitingForTrigger")]);
    const r = await createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!.send(t, ETH);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(fx.posted).toHaveLength(2);
  });

  test("entry filled but stop rejected → immediate reduce-only flatten, orphaned TP cancelled", async () => {
    const t = await openTicket();
    const fx = fakeExchange([
      okDefault,
      orderOk({ filled: { totalSz: "0.625", avgPx: "4000", oid: 1 } }, { error: "Invalid TP/SL price." }, { resting: { oid: 3 } }),
      orderOk({ filled: { totalSz: "0.625", avgPx: "3999", oid: 4 } }),
      cancelOk("success"),
    ]);
    const r = await createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("stop order rejected (Invalid TP/SL price.)");
    expect(r.lines).toContain("flattened 0.625 ETH @ 3,999 (oid 4, ±2% band)");
    // anchored to the fresh mid 3990, 2 × 1% through it
    const flat = fx.posted[2]!.body.action;
    expect(flat).toEqual({ type: "order", orders: [{ a: 1, b: false, p: "3910.2", s: "0.625", r: true, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
    expect(fx.infos[0]).toEqual({ type: "allMids" });
    expect(fx.posted[3]!.body.action).toEqual({ type: "cancel", cancels: [{ a: 1, o: 3 }] });
  });

  test("an unfilled flatten is retried once with a wider band, then the TP is cancelled", async () => {
    const t = await openTicket();
    const fx = fakeExchange([
      okDefault,
      orderOk({ filled: { totalSz: "0.625", avgPx: "4000", oid: 1 } }, { error: "bad stop" }, { resting: { oid: 3 } }),
      orderOk({ error: "no liquidity" }),
      orderOk({ filled: { totalSz: "0.625", avgPx: "3950", oid: 5 } }),
      cancelOk("success"),
    ]);
    const r = await createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r.ok).toBe(false);
    expect(fx.posted[3]!.body.action.orders[0]).toMatchObject({ b: false, r: true, s: "0.625", p: "3790.5" }); // 3990 × 0.95
    expect(r.lines).toContain("flattened 0.625 ETH @ 3,950 (oid 5, ±5% band)");
    expect(fx.posted.at(-1)!.body.action).toEqual({ type: "cancel", cancels: [{ a: 1, o: 3 }] });
    expect(r.errors.join(" ")).not.toContain("FLATTEN FAILED");
  });

  test("a failed flatten is reported loudly and keeps the take-profit; no fresh mid falls back to the fill price", async () => {
    const t = await openTicket();
    const fx = fakeExchange(
      [okDefault, orderOk({ filled: { totalSz: "0.625", avgPx: "4000", oid: 1 } }, { error: "bad stop" }, { resting: { oid: 3 } }), orderOk({ error: "no liquidity" }), orderOk({ error: "no liquidity" })],
      false,
      () => null,
    );
    const r = await createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r.ok).toBe(false);
    expect(r.errors.at(-1)).toBe("FLATTEN FAILED: 0.625 of 0.625 ETH is open WITHOUT a stop; take-profit kept: act now");
    expect(fx.posted.map((p) => p.body.action.type)).toEqual(["updateLeverage", "order", "order", "order"]); // no cancel
    expect(fx.posted[2]!.body.action.orders[0].p).toBe("3920"); // fill 4000 × 0.98
    expect(fx.infos.map((i) => i.type)).toEqual(["allMids", "l2Book", "allMids", "l2Book"]);
  });

  test("a resting limit entry whose stop is rejected is cancelled", async () => {
    const t = await openTicket({ entry: { type: "limit", px: 3990 } });
    const fx = fakeExchange([okDefault, orderOk({ resting: { oid: 5 } }, { error: "bad stop" }, "waitingForFill"), cancelOk("success")]);
    const r = await createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r.ok).toBe(false);
    expect(fx.posted[2]!.body.action).toEqual({ type: "cancel", cancels: [{ a: 1, o: 5 }] });
  });

  test("unfilled IOC entry, TP-only rejection, leverage rejection", async () => {
    const t = await openTicket();
    const ex1 = fakeExchange([okDefault, orderOk({ error: "Order could not immediately match against any resting orders." }, "waitingForFill", "waitingForFill")]);
    const r1 = await createExchange(cfg(), KEY, { fetchFn: ex1.fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r1.ok).toBe(false);
    expect(r1.errors[0]).toContain("entry not filled: Order could not immediately match");

    const ex2 = fakeExchange([okDefault, orderOk({ filled: { totalSz: "0.625", avgPx: "4000", oid: 1 } }, { resting: { oid: 2 } }, { error: "bad tp" })]);
    const r2 = await createExchange(cfg(), KEY, { fetchFn: ex2.fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r2.ok).toBe(true);
    expect(r2.errors).toEqual(["take-profit rejected (bad tp); the stop is live"]);

    const ex3 = fakeExchange([{ status: "err", response: "Invalid leverage" }]);
    const r3 = await createExchange(cfg(), KEY, { fetchFn: ex3.fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r3.ok).toBe(false);
    expect(ex3.posted).toHaveLength(1);
    expect(r3.errors[0]).toContain("nothing was ordered");
  });

  test("full close fills, the venue confirms flat, then leftover triggers are cancelled", async () => {
    const t = await buildTicket({ kind: "close", coin: "ETH", pct: 100 }, deps(cfg(), true));
    const fx = fakeExchange([orderOk({ filled: { totalSz: "0.6255", avgPx: "3998", oid: 30 } }), cancelOk("success", { error: "Order was never placed, already canceled, or filled." })]);
    const r = await createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!.send(t, ETH);
    expect(r.ok).toBe(true);
    expect(fx.infos).toEqual([{ type: "clearinghouseState", user: MASTER }]);
    expect(r.lines).toEqual(["closed 0.6255 ETH @ 3,998 (oid 30)", "cancelled leftover trigger oid 11"]);
    expect(r.errors[0]).toContain("could not cancel leftover trigger oid 12");
    expect(fx.posted[1]!.body.action).toEqual({ type: "cancel", cancels: [{ a: 1, o: 11 }, { a: 1, o: 12 }] });
  });

  test("full close: position still open or unreadable → triggers kept; a partial fill is not ok", async () => {
    const t = await buildTicket({ kind: "close", coin: "ETH", pct: 100 }, deps(cfg(), true));
    const open = fakeExchange([orderOk({ filled: { totalSz: "0.6255", avgPx: "3998", oid: 30 } })], false, (b) => (b.type === "clearinghouseState" ? { assetPositions: [{ position: { coin: "ETH", szi: "0.1" } }] } : null));
    const r1 = await createExchange(cfg(), KEY, { fetchFn: open.fetchFn, now: clock() })!.send(t, ETH);
    expect(r1.ok).toBe(true);
    expect(r1.lines.at(-1)).toBe("ETH: position remains, triggers kept (0.1 still open)");
    expect(open.posted).toHaveLength(1);

    const down = fakeExchange([orderOk({ filled: { totalSz: "0.6255", avgPx: "3998", oid: 30 } })], false, () => null);
    const r2 = await createExchange(cfg(), KEY, { fetchFn: down.fetchFn, now: clock() })!.send(t, ETH);
    expect(r2.errors[0]).toContain("could not confirm ETH is flat");
    expect(r2.errors[0]).toContain("triggers kept");
    expect(down.posted).toHaveLength(1);

    const partial = fakeExchange([orderOk({ filled: { totalSz: "0.4", avgPx: "3998", oid: 31 } })], false, (b) => (b.type === "clearinghouseState" ? { assetPositions: [{ position: { coin: "ETH", szi: "0.2255" } }] } : null));
    const r3 = await createExchange(cfg(), KEY, { fetchFn: partial.fetchFn, now: clock() })!.send(t, ETH);
    expect(r3.ok).toBe(false);
    expect(r3.errors).toContain("partial close: 0.4 of 0.6255 ETH filled");
    expect(r3.lines.at(-1)).toBe("ETH: position remains, triggers kept (0.2255 still open)");
  });

  test("stop: new stop first, then the old one cancelled; a rejected new stop keeps the old", async () => {
    const t = await buildTicket({ kind: "stop", coin: "ETH", px: 3900 }, deps(cfg(), true));
    const fx = fakeExchange([orderOk({ resting: { oid: 40 } }), cancelOk("success")]);
    const r = await createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!.send(t, ETH);
    expect(r).toMatchObject({ ok: true, oids: [40] });
    expect(fx.posted.map((p) => p.body.action.type)).toEqual(["order", "cancel"]);

    const fx2 = fakeExchange([orderOk({ error: "bad px" })]);
    const r2 = await createExchange(cfg(), KEY, { fetchFn: fx2.fetchFn, now: clock() })!.send(t, ETH);
    expect(r2.ok).toBe(false);
    expect(fx2.posted).toHaveLength(1);
    expect(r2.errors[0]).toContain("old stop is left in place");
  });

  test("cancel parses per-oid statuses", async () => {
    const t = await buildTicket({ kind: "cancel", oids: [{ coin: "ETH", oid: 13 }] }, deps(cfg(), true));
    const fx = fakeExchange([cancelOk("success")]);
    const r = await createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r).toEqual({ ok: true, lines: ["cancelled oid 13"], errors: [], oids: [13] });
  });
});

describe("send refuses before signing", () => {
  const refuse = async (t: Ticket, opts: { config?: Config; now?: number; markets?: MarketRow[] } = {}) => {
    const fx = fakeExchange([]);
    const r = await createExchange(opts.config ?? cfg(), KEY, { fetchFn: fx.fetchFn, now: clock(opts.now) })!.send(t, opts.markets ?? MARKETS);
    expect(fx.posted).toHaveLength(0);
    expect(r.ok).toBe(false);
    return r.errors[0]!;
  };

  test("a ticket with canSend false", async () => {
    const t = await openTicket({}, cfg({ HT_MAX_NOTIONAL_USD: "1000" }));
    expect(t.canSend).toBe(false);
    expect(await refuse(t)).toContain("ticket is blocked: notional");
    expect(await refuse({ ...(await openTicket()), canSend: false })).toContain("ticket is blocked");
  });

  test("notional over the cap even if the ticket claims canSend; the cap includes the IOC band", async () => {
    const t = await openTicket();
    expect(await refuse(t, { config: cfg({ HT_MAX_NOTIONAL_USD: "1000" }) })).toContain("exceeds HT_MAX_NOTIONAL_USD");
    // 0.625 × 4000 = 2,500 at the mark, 2,525 at mark + 1%
    expect(await refuse(t, { config: cfg({ HT_MAX_NOTIONAL_USD: "2520" }) })).toContain("notional $2525.00 exceeds");
  });

  test("a take-profit no longer on the profit side of the mark", async () => {
    const t = await openTicket();
    expect(await refuse({ ...t, tpPx: 3990 })).toContain("take-profit 3,990 is on the wrong side");
  });

  test("network mismatch, stale ticket, mark drift, wrong-side stop", async () => {
    const t = await openTicket();
    expect(await refuse(t, { config: cfg({ HT_NETWORK: "mainnet" }) })).toContain("quoted on testnet");
    expect(await refuse(t, { now: T0 + 31_000 })).toContain("re-quote");
    expect(await refuse(t, { markets: [MARKETS[0]!, { ...ETH, midPx: 4030 }] })).toContain("mark moved");
    expect(await refuse({ ...t, stopPx: 4010 })).toContain("wrong side");
  });

  test("the same ticket is never sent twice", async () => {
    const t = await openTicket();
    const fx = fakeExchange([okDefault, orderOk({ filled: { totalSz: "0.625", avgPx: "4000", oid: 1 } }, { resting: { oid: 2 } }, { resting: { oid: 3 } })]);
    const ex = createExchange(cfg(), KEY, { fetchFn: fx.fetchFn, now: clock() })!;
    expect((await ex.send(t, MARKETS)).ok).toBe(true);
    const again = await ex.send(t, MARKETS);
    expect(again.ok).toBe(false);
    expect(again.errors[0]).toContain("already sent");
    expect(fx.posted).toHaveLength(2);
  });

  test("transport errors never carry the key", async () => {
    const t = await openTicket();
    const fetchFn = (async () => {
      throw new Error(`boom ${KEY} ${KEY.slice(2).toUpperCase()}`);
    }) as unknown as typeof fetch;
    const r = await createExchange(cfg(), KEY, { fetchFn, now: clock() })!.send(t, MARKETS);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("[redacted]");
    expect(r.errors.join(" ").toLowerCase()).not.toContain(KEY.slice(2, 18));
  });
});
