import { deskRisk, type Ticket } from "../../routes/platform.js";
import { describe, expect, test } from "bun:test";
import { loadDeskConfig, type ProprVenueConfig } from "../config.js";
import { DeskService } from "../service.js";
import { MemoryStore } from "../store.js";
import { FakeData, RecordingNotifier, ctx } from "../testkit.js";
import type { OperatorOrder, RiskOrder, Sizing, TradeProposal } from "../types.js";
import { tick } from "../watch.js";
import { countEntriesToday, estimateDayStart, pendingLadderRisk, snapshotFrom, type ProprSnapshot } from "./account.js";
import { FLAT_GRACE_MS, PROPR_UPKEEP_KEY, ProprBroker, sweepPlan, type ProprUpkeepState } from "./broker.js";
import { ProprClient, proprBaseUrl, scrub } from "./client.js";
import { isLadderId, isPerpRadarId, ladderId, ulid, ulidTime } from "./ids.js";
import { coinMaxLeverage, firmReasons, ladderEdge, ladderRequests, planLadder, tradeLeverage } from "./ladder.js";

const NOW = new Date("2026-10-05T12:00:00Z");
const KEY = "pk_live_secret123";
const BASE = "https://api.propr.xyz/v1";
const env = (over: Record<string, string> = {}) => ({ DESK_VENUE: "propr", PROPR_API_KEY: KEY, PROPR_ACCOUNT_ID: "acc1", ...over });
const cfgOf = (over: Record<string, string> = {}): ProprVenueConfig => loadDeskConfig(env(over)).propr!;

const order: RiskOrder = { coin: "ETH", side: "long", stop: 3800, target: 4500, riskPct: 0.5 };
const sizing: Sizing = { markPx: 4000, size: 0.625, notionalUsd: 2500, riskUsd: 125, stopDistPct: 5, rr: 2.5, feeUsd: 1.13, grossLeverageAfter: 0.1 };

function snap(over: Partial<ProprSnapshot> = {}): ProprSnapshot {
  return { accountId: "acc1", startingBalance: 25_000, balance: 25_000, equity: 25_000, dayStartBalance: 25_000, positions: [], entriesToday: 0, pendingRisk: 0, working: [], perpRadarOrders: 0, orders: [], unreadable: { live: [], other: [] }, ...over };
}

/** perp-radar's own ladder ids: same layout, tag "PRX". */
const perpRadarId = (t: number) => {
  const id = ladderId(t, "pr", 0, "entry");
  return `${id.slice(0, 10)}PRX${id.slice(13)}`;
};

type Call = { method: string; url: string; headers: Record<string, string>; body: any; redirect?: string };

/**
 * A fake Propr API: records every call, answers GETs from state and POSTed orders from a script of statuses. With
 * `stateful`, a cancel marks the order cancelled in `orders` (after `onCancel`, which can fill it first), so the next
 * read sees what a real account would.
 */
function fakePropr(
  opts: { positions?: unknown[]; orders?: unknown[]; account?: Record<string, string>; statuses?: string[][]; cancelFails?: boolean; cancelDown?: boolean; unfilled?: boolean; raw?: Record<string, unknown>; stateful?: boolean; onCancel?: (order: any) => void } = {},
) {
  const calls: Call[] = [];
  const statuses = [...(opts.statuses ?? [])];
  let oid = 100;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body, redirect: init?.redirect });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const p = u.pathname.replace("/v1", "");
    if (method === "GET" && opts.raw && p in opts.raw) return json(opts.raw[p]);
    if (p.endsWith("/cancel") && opts.cancelDown) return json({ message: "upstream down" }, 502);
    if (p === "/challenge-attempts") return json({ data: [{ accountId: "old", status: "failed", initialBalance: "25000" }, { accountId: "acc1", status: "active", initialBalance: "25000" }] });
    if (p === "/accounts/acc1") return json(opts.account ?? { balance: "25000", marginBalance: "25000", totalUnrealizedPnl: "0" });
    if (p === "/accounts/acc1/positions") return json({ data: opts.positions ?? [] });
    if (p === "/accounts/acc1/orders" && method === "GET") return json({ data: opts.orders ?? [] });
    if (p === "/accounts/acc1/trades") return json({ data: [] });
    if (p.startsWith("/accounts/acc1/margin-config/")) return json(method === "GET" ? { configId: "mc1", leverage: "1", marginMode: "cross" } : {});
    if (p.endsWith("/cancel") && opts.stateful) {
      const o = (opts.orders as any[] | undefined)?.find((x) => `/accounts/acc1/orders/${x.orderId}/cancel` === p);
      if (!o || !["open", "pending", "partially_filled"].includes(o.status)) return json({ message: "not open" }, 400);
      opts.onCancel?.(o);
      o.status = "cancelled";
      return json({});
    }
    if (p.endsWith("/cancel")) return opts.cancelFails ? json({ message: "already filled" }, 400) : json({});
    if (p === "/accounts/acc1/orders" && method === "POST") {
      const st = statuses.shift() ?? body.orders.map(() => "open");
      const fill = (o: any, s: string) => (o.type === "market" && s === "filled" && !opts.unfilled ? { averageFillPrice: "4001", cumulativeQuantity: o.quantity } : { cumulativeQuantity: "0" });
      return json({ data: body.orders.map((o: any, i: number) => ({ ...o, orderId: String(oid++), status: st[i] ?? "open", ...fill(o, st[i] ?? "open") })) });
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
  return { calls, fetchFn, posts: () => calls.filter((c) => c.method !== "GET") };
}

const market = async (coin: string) => (coin === "ETH" ? { coin: "ETH", markPx: 4000, szDecimals: 2, isDelisted: false } : null);

describe("Propr venue config", () => {
  test("needs a key and an account; PROPR_KILL and a foreign URL fall back to paper; live only on exactly true", () => {
    expect(loadDeskConfig({ DESK_VENUE: "propr" })).toMatchObject({ venue: "paper", venueNote: expect.stringContaining("PROPR_API_KEY") });
    expect(loadDeskConfig({ DESK_VENUE: "propr", PROPR_API_KEY: KEY })).toMatchObject({ venue: "paper", venueNote: expect.stringContaining("PROPR_ACCOUNT_ID") });
    expect(loadDeskConfig(env({ PROPR_KILL: "true" }))).toMatchObject({ venue: "paper", venueNote: expect.stringContaining("PROPR_KILL") });
    expect(loadDeskConfig(env({ PROPR_API_URL: "https://evil.example/v1" }))).toMatchObject({ venue: "paper", venueNote: expect.stringContaining("PROPR_API_URL") });
    expect(loadDeskConfig(env())).toMatchObject({ venue: "propr", propr: { accountId: "acc1", live: false, baseUrl: BASE } });
    expect(cfgOf({ PROPR_LIVE: "TRUE" }).live).toBe(false);
    expect(cfgOf({ PROPR_LIVE: "true" }).live).toBe(true);
    const c = cfgOf({ PROPR_LADDER_RUNGS: "50", PROPR_LADDER_RUNGS_BY_COIN: "btc:8, LIT=3, bad", PROPR_MAX_ENTRIES_PER_DAY: "9", PROPR_LADDER_FIRST_AT_MARKET: "no", PROPR_LEVERAGE_BY_COIN: "hype:5, zec:30" });
    expect(c.ladder).toMatchObject({ rungs: 20, rungsByCoin: { BTC: 8, LIT: 3 }, firstAtMarket: false });
    expect(c.firm.maxEntriesPerDay).toBe(3);
    expect(c.leverageByCoin).toEqual({ HYPE: 5, ZEC: 10 });
  });

  test("approval is manual on Propr whatever DESK_APPROVAL says", () => {
    expect(loadDeskConfig(env({ DESK_APPROVAL: "auto" })).approval).toBe("manual");
    expect(loadDeskConfig({ DESK_APPROVAL: "auto" }).approval).toBe("auto");
  });

  test("the key stays out of the service's config surface and every error", () => {
    expect(scrub(`GET /x failed with ${KEY}`)).toBe("GET /x failed with pk_***");
    expect(() => proprBaseUrl("http://api.propr.xyz/v1")).toThrow();
    expect(proprBaseUrl("https://api.beta.propr.xyz/v1/")).toBe("https://api.beta.propr.xyz/v1");
  });
});

describe("ids", () => {
  test("ladder ids are deterministic ULIDs tagged PRD, carrying their time; perp-radar's PRX ids are not the desk's", () => {
    const a = ladderId(NOW.getTime(), "prop1", 2, "entry");
    expect(a).toBe(ladderId(NOW.getTime(), "prop1", 2, "entry"));
    expect(a.slice(10, 13)).toBe("PRD");
    expect(isLadderId(a)).toBe(true);
    expect(ulidTime(a)).toBe(NOW.getTime());
    expect(isLadderId(ulid(NOW.getTime(), "x"))).toBe(false);
    const pr = perpRadarId(NOW.getTime());
    expect(isPerpRadarId(pr)).toBe(true);
    expect(isLadderId(pr)).toBe(false);
  });
});

describe("leverage", () => {
  const cfg = cfgOf({ PROPR_LEVERAGE_BY_COIN: "HYPE:5" });

  test("Propr's rulebook caps 10x on BTC, ETH and SOL and 2x elsewhere, with per-coin overrides and the account ceiling", () => {
    expect(coinMaxLeverage(cfg, "BTC")).toBe(10);
    expect(coinMaxLeverage(cfg, "LIT")).toBe(2);
    expect(coinMaxLeverage(cfg, "HYPE")).toBe(5);
    expect(coinMaxLeverage(cfgOf({ PROPR_MAX_LEVERAGE: "4" }), "ETH")).toBe(4);
  });

  test("a trade picks 1x to the coin's maximum, whole; above it is capped with a warning; no choice is null", () => {
    expect(tradeLeverage(cfg, "ETH", 1)).toEqual({ leverage: 1, max: 10 });
    expect(tradeLeverage(cfg, "ETH", 10)).toEqual({ leverage: 10, max: 10 });
    expect(tradeLeverage(cfg, "LIT", 10)).toMatchObject({ leverage: 2, warning: expect.stringContaining("capped at Propr's 2x") });
    expect(tradeLeverage(cfg, "ETH", 2.5)).toMatchObject({ leverage: 3, warning: expect.stringContaining("rounded") });
    expect(tradeLeverage(cfg, "ETH", undefined)).toEqual({ leverage: null, max: 10 });
  });

  test("without a choice: the signal's confidence, then the configured default, both capped per coin", () => {
    const c = cfgOf({ PROPR_DEFAULT_LEVERAGE: "2", PROPR_LEVERAGE_BY_CONFIDENCE: "low:1, medium:3, high:8, bogus:4" });
    expect(c.leverageByConfidence).toEqual({ low: 1, medium: 3, high: 8 });
    expect(tradeLeverage(c, "ETH", undefined, "high")).toEqual({ leverage: 8, max: 10 });
    expect(tradeLeverage(c, "LIT", undefined, "high")).toEqual({ leverage: 2, max: 2 });
    expect(tradeLeverage(c, "ETH", undefined)).toEqual({ leverage: 2, max: 10 });
    expect(tradeLeverage(c, "ETH", 4, "high")).toEqual({ leverage: 4, max: 10 });
  });
});

describe("ladder", () => {
  const ladder = cfgOf().ladder;

  test("the edge sits halfway to the stop, never inside the stop gap", () => {
    expect(ladderEdge("long", 4000, 3800, 0.2)).toBe(3900);
    expect(ladderEdge("short", 100, 110, 0.6)).toBe(104);
  });

  test("the ladder never exceeds the governor's risk or notional", () => {
    const { plan } = planLadder(order, sizing, 2, ladder);
    expect(plan!.rungs.map((r) => r.px)).toEqual([4000, 3975, 3950, 3925, 3900]);
    expect(plan!.rungs.every((r) => r.qty === 0.12)).toBe(true);
    expect(plan!.rungs.map((r) => r.market)).toEqual([true, false, false, false, false]);
    expect(plan!.riskUsd).toBeLessThanOrEqual(sizing.riskUsd);
    expect(plan!.notionalUsd).toBeLessThanOrEqual(sizing.notionalUsd);
  });

  test("rungs drop until each clears the order minimum", () => {
    const small: Sizing = { ...sizing, size: 0.01, notionalUsd: 40, riskUsd: 2 };
    const { plan } = planLadder(order, small, 2, ladder);
    expect(plan!.rungs.length).toBeLessThan(5);
    expect(plan!.rungs.every((r) => r.qty * r.px >= ladder.minRungUsd)).toBe(true);
    expect(planLadder(order, { ...sizing, notionalUsd: 5, riskUsd: 0.2 }, 2, ladder).reasons[0]).toContain("order minimum");
  });

  test("each rung is an entry with its own reduce-only stop and target in one group", () => {
    const { plan } = planLadder(order, sizing, 2, ladder);
    const reqs = ladderRequests(plan!, "acc1", "prop1", NOW.getTime());
    expect(reqs).toHaveLength(5);
    expect(reqs[0]!.orders.map((o) => [o.type, o.side, o.reduceOnly])).toEqual([
      ["market", "buy", false],
      ["stop_market", "sell", true],
      ["take_profit_market", "sell", true],
    ]);
    expect(reqs[1]!.orders[0]).toMatchObject({ type: "limit", price: "3975", timeInForce: "GTC", quantity: "0.12" });
    expect(reqs.every((r) => r.orders.every((o) => isLadderId(o.intentId)))).toBe(true);
  });

  test("firm rules: perp-radar on the account, entries per day, unprotected positions, resting entries, daily halt, both loss floors", () => {
    const f = cfgOf().firm;
    const { plan } = planLadder(order, sizing, 2, cfgOf().ladder);
    expect(firmReasons(snap(), plan!, f)).toEqual([]);
    expect(firmReasons(snap({ perpRadarOrders: 3 }), plan!, f)[0]).toContain("one executor per account");
    expect(firmReasons(snap({ entriesToday: 2 }), plan!, f)[0]).toContain("2 entries today");
    expect(firmReasons(snap({ positions: [{ coin: "BTC", side: "long", qty: 0.1, entry: 1e5, mark: 1e5, stop: null, tp: null }] }), plan!, f)[0]).toContain("no full stop");
    expect(firmReasons(snap({ working: ["ETH"] }), plan!, f)[0]).toContain("already resting");
    const down = firmReasons(snap({ equity: 24_400 }), plan!, f);
    expect(down.some((r) => r.startsWith("daily halt"))).toBe(true);
    expect(down.some((r) => r.includes("daily-loss floor"))).toBe(true);
    expect(firmReasons(snap({ startingBalance: 26_200 }), plan!, f).some((r) => r.includes("drawdown floor"))).toBe(true);
  });
});

describe("account", () => {
  test("the day-start balance takes the highest anchor", () => {
    const trades = [{ executedAt: "2026-10-05T03:00:00Z", realizedPnl: "-200", fee: "5" }, { executedAt: "2026-10-04T23:00:00Z", realizedPnl: "500", fee: "0" }];
    expect(estimateDayStart(24_795, {}, trades, NOW.getTime())).toBe(25_000);
    expect(estimateDayStart(25_100, { startOfDayBalance: "25300" }, [], NOW.getTime())).toBe(25_300);
  });

  test("a ladder counts as one entry; manual entries count each; a rung with no stop is infinite risk", () => {
    const t = NOW.getTime() - 3_600_000;
    const at = new Date(t).toISOString();
    const rung = (i: number, extra = {}) => ({ intentId: ladderId(t, "p", i, "entry"), orderGroupId: `g${i}`, type: "limit", base: "ETH", status: "open", price: "3950", quantity: "0.1", createdAt: at, ...extra });
    const orders = [rung(0), rung(1), { intentId: "manual", type: "market", base: "BTC", status: "filled", createdAt: at }, { orderGroupId: "g0", type: "stop_market", triggerPrice: "3800", reduceOnly: true, status: "open" }];
    expect(countEntriesToday(orders, NOW.getTime())).toBe(2);
    expect(pendingLadderRisk(orders)).toBe(Infinity);
    expect(pendingLadderRisk([rung(0), orders[3]!])).toBeCloseTo(15);
  });

  test("a snapshot needs a balance and a starting balance; stops covering the position protect it; perp-radar's orders are counted", () => {
    const base = { accountId: "acc1", account: { balance: "25000" }, orders: [], trades: [], now: NOW.getTime() };
    expect(() => snapshotFrom({ ...base, attempt: {}, positions: [] })).toThrow("PROPR_STARTING_BALANCE");
    expect(() => snapshotFrom({ ...base, account: { balance: "0" }, attempt: { initialBalance: "25000" }, positions: [] })).toThrow("unreadable");
    const s = snapshotFrom({
      ...base,
      attempt: { challenge: { initialBalance: "25000" } },
      positions: [{ base: "ETH", positionSide: "long", quantity: "0.2", entryPrice: "4000", markPrice: "4010" }],
      orders: [
        { base: "ETH", positionSide: "long", type: "stop_market", reduceOnly: true, status: "open", quantity: "0.1", triggerPrice: "3800" },
        { base: "ETH", positionSide: "long", type: "stop_market", reduceOnly: true, status: "open", quantity: "0.1", triggerPrice: "3790" },
        { intentId: perpRadarId(NOW.getTime()), base: "SOL", type: "limit", status: "open", quantity: "1", price: "150" },
      ],
    });
    expect(s.positions[0]).toMatchObject({ coin: "ETH", qty: 0.2, stop: 3790 });
    expect(s.perpRadarOrders).toBe(1);
  });
});

describe("ProprBroker", () => {
  test("a dry run reads the account, builds the margin setting and the rungs, and sends nothing", async () => {
    const api = fakePropr();
    const b = new ProprBroker({ config: cfgOf(), market, fetchFn: api.fetchFn });
    expect(b.live).toBe(false);
    const r = await b.open(order, sizing, "prop1", NOW);
    expect(String(r.error)).toMatch(/at 1x cross/);
    expect(r).toMatchObject({ ok: false, dryRun: true, venue: "propr", error: expect.stringContaining("Propr dry run: 5 rung requests built, none sent") });
    expect(r.requests).toHaveLength(6);
    expect(r.requests![0]).toEqual({ margin: { asset: "ETH", marginMode: "cross", leverage: 1 } });
    expect(api.posts()).toEqual([]);
    expect(api.calls.every((c) => c.url.startsWith(BASE) && c.headers["x-api-key"] === KEY && c.redirect === "error")).toBe(true);
  });

  test("live: sets the trade's cross leverage, sends one request per rung, reports the market fill", async () => {
    const api = fakePropr({ statuses: [["filled", "open", "open"]] });
    const b = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    const r = await b.open({ ...order, leverage: 5 }, sizing, "prop1", NOW);
    expect(String(r.note)).toMatch(/at 5x cross/);
    expect(r).toMatchObject({ ok: true, fills: [{ side: "buy", size: 0.12, px: 4001 }], note: expect.stringContaining("5 of 5 rungs working") });
    expect(api.posts().find((c) => c.method === "PUT")?.body).toEqual({ exchange: "hyperliquid", asset: "ETH", marginMode: "cross", leverage: 5 });
    expect(api.posts().filter((c) => c.url.endsWith("/orders"))).toHaveLength(5);
  });

  test("live: a market entry not yet filled is working, not a fill at zero", async () => {
    const api = fakePropr({ statuses: [["open", "open", "open"]], unfilled: true });
    const r = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).open(order, sizing, "prop1", NOW);
    expect(r.ok).toBe(true);
    expect(r.fills).toEqual([]);
    expect(r.note).toContain("fill is not reported yet");
  });

  test("live: a refused stop on the market rung closes that rung's quantity and sends nothing more", async () => {
    const api = fakePropr({ statuses: [["filled", "rejected", "open"], ["filled"]] });
    const b = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    const r = await b.open(order, sizing, "prop1", NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("closed at market");
    const orderPosts = api.posts().filter((c) => c.url.endsWith("/orders"));
    expect(orderPosts).toHaveLength(2);
    expect(orderPosts[1]!.body.orders[0]).toMatchObject({ type: "market", side: "sell", reduceOnly: true, closePosition: false, quantity: "0.12" });
  });

  test("live: a refused stop on a resting rung whose cancel fails closes its quantity and stops the ladder", async () => {
    const api = fakePropr({ statuses: [["filled", "open", "open"], ["open", "rejected", "open"], ["filled"]], cancelFails: true });
    const r = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).open(order, sizing, "prop1", NOW);
    expect(r.ok).toBe(true);
    expect(r.note).toContain("1 of 5 rungs working");
    expect(r.note).toContain("rung 2 stop was refused, its quantity was closed at market");
    const orderPosts = api.posts().filter((c) => c.url.endsWith("/orders"));
    expect(orderPosts).toHaveLength(3);
    expect(orderPosts[2]!.body.orders[0]).toMatchObject({ type: "market", reduceOnly: true, quantity: "0.12" });
  });

  test("live: the desk's leftover stops on the coin go before a new ladder", async () => {
    const old = NOW.getTime() - 2 * 3_600_000;
    const api = fakePropr({ orders: [{ orderId: "s1", intentId: ladderId(old, "p", 0, "stop"), type: "stop_market", base: "ETH", positionSide: "long", reduceOnly: true, status: "open", quantity: "0.12", triggerPrice: "3700" }] });
    const r = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).open(order, sizing, "prop1", NOW);
    expect(r.ok).toBe(true);
    expect(api.posts()[0]!.url).toBe(`${BASE}/accounts/acc1/orders/s1/cancel`);
  });

  test("the firm rules refuse before anything is sent, perp-radar's orders on the account included", async () => {
    // $600 of open loss on a $25,000 day start: past half the 3% daily limit.
    const api = fakePropr({ account: { balance: "25000", marginBalance: "24400", totalUnrealizedPnl: "-600" } });
    const b = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    expect(await b.open(order, sizing, "prop1", NOW)).toMatchObject({ ok: false, error: expect.stringContaining("Propr firm rules") });
    const pr = fakePropr({ orders: [{ orderId: "x", intentId: perpRadarId(NOW.getTime()), type: "limit", base: "SOL", status: "open", quantity: "1", price: "150" }] });
    const r = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: pr.fetchFn }).open(order, sizing, "prop1", NOW);
    expect(r.error).toContain("one executor per account");
    expect([...api.posts(), ...pr.posts()]).toEqual([]);
  });

  test("an unreadable account is unavailable, with the key scrubbed", async () => {
    const fetchFn = (async () => {
      throw new Error(`boom ${KEY}`);
    }) as unknown as typeof fetch;
    const acc = await new ProprBroker({ config: cfgOf(), market, fetchFn }).account(new Map(), NOW);
    expect(acc.available).toBe(false);
    expect(acc.note).not.toContain(KEY);
  });

  const held = (t: number) => ({
    positions: [{ base: "ETH", positionSide: "long", quantity: "0.24", entryPrice: "3990", markPrice: "4001" }],
    orders: [
      { orderId: "o1", intentId: ladderId(t, "p", 2, "entry"), type: "limit", base: "ETH", positionSide: "long", status: "open", quantity: "0.12", price: "3950" },
      { orderId: "o2", intentId: ladderId(t, "p", 0, "stop"), type: "stop_market", base: "ETH", positionSide: "long", reduceOnly: true, status: "open", quantity: "0.24", triggerPrice: "3800" },
      { orderId: "o3", intentId: "manual", type: "limit", base: "ETH", status: "open", quantity: "1", price: "3000" },
    ],
  });

  test("a filled whole close cancels the ladder's resting rungs at once and leaves its stops to housekeeping; with no rung resting the stops go too", async () => {
    const api = fakePropr({ ...held(NOW.getTime() - 3_600_000), statuses: [["filled"]] });
    const r = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).exit("ETH", 0.24, 4001, "exit", "x1", NOW);
    expect(r.ok).toBe(true);
    expect(r.fills[0]).toMatchObject({ side: "sell", size: 0.24, px: 4001 });
    // The rung may fill while its cancel is on the way: its stop is not cancelled in the same pass. Manual orders never are.
    expect(cancels(api).filter(Boolean)).toEqual(["o1"]);
    const h = held(NOW.getTime() - 3_600_000);
    const bare = fakePropr({ positions: h.positions, orders: h.orders.slice(1), statuses: [["filled"]] });
    await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: bare.fetchFn }).exit("ETH", 0.24, 4001, "exit", "x1", NOW);
    expect(cancels(bare).filter(Boolean)).toEqual(["o2"]);
  });

  test("a whole close whose fill is not reported still cancels the resting rungs, and leaves the stops in place", async () => {
    const api = fakePropr({ ...held(NOW.getTime() - 3_600_000), statuses: [["open"]], unfilled: true });
    const r = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).exit("ETH", 0.24, 4001, "exit", "x1", NOW);
    expect(r).toMatchObject({ ok: true, fills: [] });
    expect(r.note).toContain("not reported yet");
    expect(r.note).toContain("1 resting ETH order cancelled");
    expect(cancels(api).filter(Boolean)).toEqual(["o1"]);
    // A partial close ends nothing: every rung and stop stays.
    const part = fakePropr({ ...held(NOW.getTime() - 3_600_000), statuses: [["filled"]] });
    await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: part.fetchFn }).exit("ETH", 0.1, 4001, "exit", "x1", NOW);
    expect(cancels(part).filter(Boolean)).toEqual([]);
  });

  test("holds: a position or the desk's own resting entry rungs on the coin and side; another side, a manual order or no read is not", async () => {
    const t = NOW.getTime() - 3_600_000;
    const rung = { orderId: "o1", intentId: ladderId(t, "p", 1, "entry"), type: "limit", base: "ETH", positionSide: "long", side: "buy", status: "open", quantity: "0.12", price: "3950" };
    const manual = { orderId: "o2", intentId: "manual", type: "limit", base: "SOL", positionSide: "long", side: "buy", status: "open", quantity: "1", price: "140" };
    const b = (o: Parameters<typeof fakePropr>[0]) => new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: fakePropr(o).fetchFn });
    const resting = b({ orders: [rung, manual] });
    expect(await resting.holds("ETH", "long", NOW)).toBe(true);
    expect(await resting.holds("ETH", "short", NOW)).toBe(false);
    expect(await resting.holds("SOL", "long", NOW)).toBe(false);
    expect(await b({ positions: [{ base: "BTC", positionSide: "short", quantity: "0.01", entryPrice: "100000", markPrice: "100000" }] }).holds("btc", "short", NOW)).toBe(true);
    const down = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch });
    expect(await down.holds("ETH", "long", NOW)).toBeNull();
  });

  test("sweepPlan without positionSide: the entry's side keeps a held position's stop and take-profit; no side sweeps nothing", () => {
    const t = NOW.getTime() - 3_600_000;
    const bare = [
      { orderId: "e0", intentId: ladderId(t, "p", 0, "entry"), type: "market", side: "buy", base: "ETH", status: "filled", quantity: "0.12", cumulativeQuantity: "0.12" },
      { orderId: "e1", intentId: ladderId(t, "p", 1, "entry"), type: "limit", side: "buy", base: "ETH", status: "open", quantity: "0.12", price: "3950" },
      { orderId: "s0", intentId: ladderId(t, "p", 0, "stop"), type: "stop_market", side: "sell", base: "ETH", reduceOnly: true, status: "open", quantity: "0.12", triggerPrice: "3800" },
      { orderId: "t0", intentId: ladderId(t, "p", 0, "tp"), type: "take_profit_market", side: "sell", base: "ETH", reduceOnly: true, status: "open", quantity: "0.12", triggerPrice: "4500" },
    ];
    const ethLong = [{ coin: "ETH", side: "long" as const, qty: 0.12, entry: 4000, mark: 4000, stop: 3800, tp: 4500 }];
    expect(sweepPlan(bare, ethLong, NOW.getTime(), 8)).toEqual([]);
    expect(sweepPlan(bare.map(({ side, ...o }) => o), [], NOW.getTime(), 8)).toEqual([]);
  });

  test("housekeeping: live cancels a stale desk ladder, never other orders; a dry run cancels nothing; unprotected positions are critical", async () => {
    const old = NOW.getTime() - 9 * 3_600_000;
    const orders = [
      { orderId: "o1", intentId: ladderId(old, "p", 1, "entry"), type: "limit", base: "ETH", positionSide: "long", status: "open", quantity: "0.12", price: "3950" },
      { orderId: "o8", intentId: perpRadarId(old), type: "limit", base: "SOL", positionSide: "long", status: "open", quantity: "1", price: "150" },
      { orderId: "o9", intentId: "manual", type: "limit", base: "ETH", status: "open", quantity: "1", price: "3000", createdAt: new Date(old).toISOString() },
    ];
    expect(sweepPlan(orders, [], NOW.getTime(), 8).map((x) => x.victims.map((o) => o.orderId))).toEqual([["o1"]]);
    const dry = fakePropr({ orders });
    expect(await new ProprBroker({ config: cfgOf(), market, fetchFn: dry.fetchFn }).housekeep(NOW)).toEqual([{ level: "warn", key: "perp-radar", text: expect.stringContaining("one executor per account") }]);
    expect(dry.posts()).toEqual([]);
    const live = fakePropr({ orders, positions: [{ base: "BTC", positionSide: "short", quantity: "0.01", entryPrice: "100000", markPrice: "100000" }] });
    const notes = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: live.fetchFn }).housekeep(NOW);
    expect(notes.find((n) => n.level === "critical")).toMatchObject({ key: "unprotected:BTC:short", text: expect.stringContaining("no full stop") });
    expect(notes.find((n) => n.level === "info")?.text).toContain("ETH: 1 resting order cancelled");
    expect(live.posts().map((c) => c.url)).toEqual([`${BASE}/accounts/acc1/orders/o1/cancel`]);
  });
});

/** A one-hour-old ETH long ladder: the market rung filled (its stop and target working), two limit rungs resting with their stops. */
function liveLadder(coin = "ETH") {
  const t = NOW.getTime() - 3_600_000;
  const row = (i: number, kind: "entry" | "stop" | "tp", o: Record<string, unknown>) => ({ orderId: `${kind[0]}${i}`, intentId: ladderId(t, "p", i, kind), orderGroupId: `g${i}`, base: coin, positionSide: "long", quantity: "0.1", status: "open", ...o });
  return [
    row(0, "entry", { type: "market", side: "buy", status: "filled", cumulativeQuantity: "0.1" }),
    row(0, "stop", { type: "stop_market", side: "sell", reduceOnly: true, triggerPrice: "3800" }),
    row(0, "tp", { type: "take_profit_market", side: "sell", reduceOnly: true, triggerPrice: "4500" }),
    row(1, "entry", { type: "limit", side: "buy", price: "3950", cumulativeQuantity: "0" }),
    row(1, "stop", { type: "stop_market", side: "sell", reduceOnly: true, triggerPrice: "3800" }),
    row(2, "entry", { type: "limit", side: "buy", price: "3900", cumulativeQuantity: "0" }),
    row(2, "stop", { type: "stop_market", side: "sell", reduceOnly: true, triggerPrice: "3800" }),
  ];
}
const ethPos = (base = "ETH") => ({ base, positionSide: "long", quantity: "0.1", entryPrice: "4000", markPrice: "4000" });
const cancels = (api: ReturnType<typeof fakePropr>) => api.posts().map((c) => c.url.match(/orders\/(\w+)\/cancel$/)?.[1]);

describe("kill switch on Propr", () => {
  const liveBroker = (api: ReturnType<typeof fakePropr>, over: Record<string, string> = { PROPR_LIVE: "true" }) => new ProprBroker({ config: cfgOf(over), market, fetchFn: api.fetchFn });

  test("housekeeping under the kill switch cancels the resting entry rungs and keeps every stop and target; without it nothing is sent", async () => {
    const calm = fakePropr({ orders: liveLadder(), positions: [ethPos()] });
    expect(await liveBroker(calm).housekeep(NOW)).toEqual([]);
    expect(calm.posts()).toEqual([]);
    const api = fakePropr({ orders: liveLadder(), positions: [ethPos()] });
    const notes = await liveBroker(api).housekeep(NOW, { killSwitch: true });
    expect(cancels(api)).toEqual(["e1", "e2"]);
    expect(notes).toEqual([{ level: "info", key: expect.stringContaining("swept:"), text: "ETH: 2 resting orders cancelled, the kill switch is on" }]);
  });

  test("a dry run under the kill switch sends nothing and names what it would cancel", async () => {
    const api = fakePropr({ orders: liveLadder(), positions: [ethPos()] });
    const notes = await liveBroker(api, {}).housekeep(NOW, { killSwitch: true });
    expect(api.posts()).toEqual([]);
    expect(notes).toEqual([{ level: "warn", key: expect.stringContaining("kill-dry:"), text: expect.stringContaining("2 resting entry rungs would be cancelled") }]);
    expect(await liveBroker(api, {}).housekeep(NOW)).toEqual([]);
  });

  test("the kill action itself cancels the rungs, says so in its alert, and every tick retries a cancel that failed", async () => {
    const opts: Parameters<typeof fakePropr>[0] = { orders: liveLadder(), positions: [ethPos()], cancelDown: true };
    const api = fakePropr(opts);
    const config = loadDeskConfig(env({ PROPR_LIVE: "true", DESK_REVIEW_HOURS: "0" }));
    const notifier = new RecordingNotifier();
    const service = new DeskService({ config, store: new MemoryStore(() => NOW), data: new FakeData([ctx("ETH", 4000)]), notifier, now: () => NOW, broker: liveBroker(api) });
    await service.setKillSwitch(true, "halt", "operator");
    expect((await service.killSwitch()).on).toBe(true);
    expect(cancels(api)).toEqual(["e1", "e2"]);
    expect(notifier.sent.at(-1)).toMatchObject({ title: "Kill switch ON", body: expect.stringContaining("could not cancel a ETH limit order") });
    opts.cancelDown = false;
    await tick(service, { runCycle: false });
    expect(cancels(api)).toEqual(["e1", "e2", "e1", "e2"]);
    expect(notifier.sent.at(-1)?.body).toContain("ETH: 2 resting orders cancelled, the kill switch is on");
    // Switching it off cancels nothing.
    await service.setKillSwitch(false, "resume", "operator");
    expect(api.posts()).toHaveLength(4);
  });
});

const MIN15 = 15 * 60_000;
const stateOf = (store: MemoryStore) => ({ get: () => store.getState<ProprUpkeepState>(PROPR_UPKEEP_KEY), set: (v: ProprUpkeepState) => store.setState(PROPR_UPKEEP_KEY, v) });
/** A new broker, as a serverless tick builds one: nothing survives but the desk store. */
const freshBroker = (api: ReturnType<typeof fakePropr>, store: MemoryStore) => new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn, state: stateOf(store) });

describe("housekeeping with a fresh process per tick", () => {
  test("a closed trade's unfilled rungs are cancelled on the first tick; its stops and targets on a later one, once the position has stayed gone", async () => {
    const opts: Parameters<typeof fakePropr>[0] = { orders: liveLadder(), positions: [], stateful: true };
    const api = fakePropr(opts);
    const store = new MemoryStore(() => NOW);
    const first = await freshBroker(api, store).housekeep(NOW);
    expect(first).toEqual([{ level: "info", key: expect.stringContaining("swept:"), text: "ETH: 2 resting orders cancelled, the trade is closed" }]);
    expect(cancels(api)).toEqual(["e1", "e2"]);
    // Inside the grace nothing more goes, whoever asks.
    await freshBroker(api, store).housekeep(new Date(NOW.getTime() + FLAT_GRACE_MS - 1));
    expect(cancels(api)).toEqual(["e1", "e2"]);
    const later = await freshBroker(api, store).housekeep(new Date(NOW.getTime() + MIN15));
    expect(later).toEqual([{ level: "info", key: expect.stringContaining("swept:"), text: "ETH: 4 resting orders cancelled, the trade is closed" }]);
    expect(cancels(api)).toEqual(["e1", "e2", "s0", "t0", "s1", "s2"]);
    expect(await freshBroker(api, store).housekeep(new Date(NOW.getTime() + 2 * MIN15))).toEqual([]);
  });

  test("a fill whose position row lags: the rungs go, the stops stay, and the wait starts over when the position shows", async () => {
    const opts: Parameters<typeof fakePropr>[0] = { orders: liveLadder(), positions: [], stateful: true };
    const api = fakePropr(opts);
    const store = new MemoryStore(() => NOW);
    await freshBroker(api, store).housekeep(NOW);
    opts.positions = [ethPos()];
    for (let i = 1; i <= 20; i++) await freshBroker(api, store).housekeep(new Date(NOW.getTime() + i * MIN15));
    expect(cancels(api)).toEqual(["e1", "e2"]);
    expect((await store.getState<ProprUpkeepState>(PROPR_UPKEEP_KEY))?.flat).toEqual({});
    // Gone again: one sighting is not enough, the next tick past the grace is.
    opts.positions = [];
    await freshBroker(api, store).housekeep(new Date(NOW.getTime() + 21 * MIN15));
    expect(cancels(api)).toEqual(["e1", "e2"]);
    await freshBroker(api, store).housekeep(new Date(NOW.getTime() + 22 * MIN15));
    expect(cancels(api)).toEqual(["e1", "e2", "s0", "t0", "s1", "s2"]);
  });

  test("without a stored memory no stop is ever cancelled, and a state store that fails costs only the stop sweep", async () => {
    const opts: Parameters<typeof fakePropr>[0] = { orders: liveLadder(), positions: [], stateful: true };
    const api = fakePropr(opts);
    const down = { get: async () => Promise.reject(new Error("db down")), set: async () => Promise.reject(new Error("db down")) };
    for (let i = 0; i < 4; i++) await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn, state: down }).housekeep(new Date(NOW.getTime() + i * MIN15));
    expect(cancels(api)).toEqual(["e1", "e2"]);
  });

  test("the service gives the broker the desk store, so the wait survives a new service", async () => {
    const opts: Parameters<typeof fakePropr>[0] = { orders: liveLadder(), positions: [], stateful: true };
    const api = fakePropr(opts);
    const store = new MemoryStore(() => NOW);
    const config = loadDeskConfig(env({ PROPR_LIVE: "true" }));
    const real = globalThis.fetch;
    // The service builds its broker on the global fetch: swapped for the fake while it is built, so nothing leaves the test.
    const build = () => {
      globalThis.fetch = api.fetchFn;
      try {
        return new DeskService({ config, store, data: new FakeData([ctx("ETH", 4000)]), notifier: new RecordingNotifier(), now: () => NOW });
      } finally {
        globalThis.fetch = real;
      }
    };
    await build().broker.housekeep!(NOW);
    await build().broker.housekeep!(new Date(NOW.getTime() + MIN15));
    expect(cancels(api)).toEqual(["e1", "e2", "s0", "t0", "s1", "s2"]);
  });
});

describe("a stop is never cancelled in the pass that cancels its entry", () => {
  const t = NOW.getTime() - 3_600_000;
  const rung = () => [
    { orderId: "e1", intentId: ladderId(t, "p", 1, "entry"), orderGroupId: "g1", type: "limit", side: "buy", base: "ETH", positionSide: "long", status: "open", quantity: "0.1", cumulativeQuantity: "0", price: "3950" },
    { orderId: "s1", intentId: ladderId(t, "p", 1, "stop"), orderGroupId: "g1", type: "stop_market", side: "sell", base: "ETH", positionSide: "long", reduceOnly: true, status: "open", quantity: "0.1", triggerPrice: "3800" },
  ];

  test("kill: a rung that part-filled between the read and its cancel keeps its stop, on this tick and every later one", async () => {
    const opts: Parameters<typeof fakePropr>[0] = { orders: rung(), positions: [], stateful: true };
    opts.onCancel = (o) => {
      o.cumulativeQuantity = "0.05";
      opts.positions = [{ base: "ETH", positionSide: "long", quantity: "0.05", entryPrice: "3950", markPrice: "3950" }];
    };
    const api = fakePropr(opts);
    const store = new MemoryStore(() => NOW);
    await freshBroker(api, store).cancelEntries(NOW);
    expect(cancels(api)).toEqual(["e1"]);
    for (let i = 0; i <= 4; i++) await freshBroker(api, store).housekeep(new Date(NOW.getTime() + i * MIN15), { killSwitch: true });
    expect(cancels(api)).toEqual(["e1"]);
    expect((opts.orders as any[])[1].status).toBe("open");
  });

  test("TTL: the stale rung goes first; its stop only on a later tick, when nothing filled", async () => {
    const opts: Parameters<typeof fakePropr>[0] = { orders: rung(), positions: [], stateful: true };
    const api = fakePropr(opts);
    const store = new MemoryStore(() => NOW);
    const late = NOW.getTime() + 8 * 3_600_000;
    await freshBroker(api, store).housekeep(new Date(late));
    expect(cancels(api)).toEqual(["e1"]);
    await freshBroker(api, store).housekeep(new Date(late + 60_000));
    await freshBroker(api, store).housekeep(new Date(late + 60_000 + FLAT_GRACE_MS - 1));
    expect(cancels(api)).toEqual(["e1"]);
    const notes = await freshBroker(api, store).housekeep(new Date(late + MIN15));
    expect(cancels(api)).toEqual(["e1", "s1"]);
    expect(notes[0]?.text).toBe("ETH: 1 resting order cancelled, none of its rungs filled and none is resting");
  });

  test("sweepPlan never returns a ladder's entries and its stops together", () => {
    const flat = new Map<string, number>();
    for (const [orders, positions, now, o] of [
      [liveLadder(), [], NOW.getTime(), { flat }],
      [liveLadder(), [], NOW.getTime() + 10 * 3_600_000, { flat, kill: true }],
      [rung(), [], NOW.getTime() + 10 * 3_600_000, { flat, kill: true }],
    ] as const) {
      const plan = sweepPlan(orders, [...positions], now, 8, o);
      expect(plan).toHaveLength(1);
      expect(plan[0]!.victims.every((v) => v.type === "limit")).toBe(true);
    }
    // No memory, or entriesOnly: stops are never victims.
    const done = liveLadder().map((o: Record<string, unknown>) => (o.type === "limit" ? { ...o, status: "cancelled" } : o));
    expect(sweepPlan(done, [], NOW.getTime() + 10 * 3_600_000, 8)).toEqual([]);
    const seen = new Map<string, number>();
    expect(sweepPlan(done, [], NOW.getTime(), 8, { flat: seen })).toEqual([]);
    expect(sweepPlan(done, [], NOW.getTime() + FLAT_GRACE_MS, 8, { flat: seen, entriesOnly: true })).toEqual([]);
    expect(sweepPlan(done, [], NOW.getTime() + FLAT_GRACE_MS, 8, { flat: seen })[0]?.victims.map((v) => v.orderId)).toEqual(["s0", "t0", "s1", "s2"]);
  });
});

describe("housekeeping never strips a live position's stops", () => {
  test("a leftover stop that names another position does not protect a new one on the same coin and side", () => {
    const base = { accountId: "acc1", attempt: { initialBalance: "25000" }, account: { balance: "25000" }, trades: [], now: NOW.getTime() };
    const pos = { base: "ETH", positionSide: "long", positionId: "P2", quantity: "0.1", entryPrice: "4000", markPrice: "4000" };
    const stop = (o: Record<string, unknown>) => ({ base: "ETH", positionSide: "long", type: "stop_market", reduceOnly: true, status: "open", quantity: "0.1", triggerPrice: "3800", ...o });
    const read = (orders: Record<string, unknown>[], p: Record<string, unknown> = pos) => snapshotFrom({ ...base, positions: [p], orders }).positions[0]!.stop;
    expect(read([stop({ positionId: "P1" })])).toBeNull();
    expect(read([stop({ positionId: "P2" })])).toBe(3800);
    expect(read([stop({ positionId: 7 })], { ...pos, positionId: "7" })).toBe(3800);
    // The stop carries no positionId, its rung's entry (same order group) does.
    const entry = (positionId: string) => ({ orderGroupId: "g0", type: "market", side: "buy", base: "ETH", status: "filled", positionId });
    expect(read([entry("P1"), stop({ orderGroupId: "g0" })])).toBeNull();
    expect(read([entry("P2"), stop({ orderGroupId: "g0" })])).toBe(3800);
    // No id on either side: coin and side decide, as before.
    expect(read([stop({})])).toBe(3800);
    expect(read([stop({ positionId: "P1" })], { ...pos, positionId: undefined })).toBe(3800);
  });

  test("the leftover stop of a closed trade leaves a new position flagged unprotected", async () => {
    const orders = liveLadder().map((o: Record<string, unknown>) => ({ ...o, positionId: "P1", ...(o.type === "limit" ? { status: "cancelled" } : {}) }));
    const api = fakePropr({ orders, positions: [{ ...ethPos(), positionId: "P2" }] });
    const notes = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).housekeep(NOW);
    expect(notes).toEqual([{ level: "critical", key: "unprotected:ETH:long", text: expect.stringContaining("no full stop") }]);
  });

  test("a position whose coin differs only in case (or sits in `asset`) still holds its ladder's stops, past the TTL too", async () => {
    const pos = [{ coin: "eth", side: "long" as const, qty: 0.1, entry: 4000, mark: 4000, stop: 3800, tp: 4500 }];
    const late = NOW.getTime() + 10 * 3_600_000;
    const flat = new Map([[`${ladderId(NOW.getTime() - 3_600_000, "p", 0, "entry").slice(0, 10)}:ETH`, 0]]);
    expect(sweepPlan(liveLadder(), pos, late, 8, { flat }).map((x) => x.victims.map((o) => o.orderId))).toEqual([["e1", "e2"]]);
    const api = fakePropr({ orders: liveLadder(), positions: [{ asset: "eth", positionSide: "long", quantity: "0.1", entryPrice: "4000", markPrice: "4000" }] });
    const broker = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    await broker.housekeep(new Date(late));
    await broker.housekeep(new Date(late + FLAT_GRACE_MS));
    expect(cancels(api)).toEqual(["e1", "e2", "e1", "e2"]);
    // Its mark comes from Hyperliquid's "ETH", and the operator's close of "ETH" finds it.
    expect((await broker.account(new Map([["ETH", 4100]]), NOW)).positions[0]).toMatchObject({ coin: "eth", markPx: 4100 });
    const service = new DeskService({ config: loadDeskConfig(env({ PROPR_LIVE: "true" })), store: new MemoryStore(() => NOW), data: new FakeData([ctx("ETH", 4000)]), notifier: new RecordingNotifier(), now: () => NOW, broker });
    expect((await service.submitExit({ coin: "ETH", fraction: 1, reason: "out" }, null)).status).toBe("executed");
    // The lower-case position is protected by the upper-case ladder's stops, and the governor's one-position-per-coin check sees it.
    expect((await broker.snapshot(NOW)).positions[0]).toMatchObject({ coin: "eth", stop: 3800 });
    expect(await broker.holds("ETH", "long", NOW)).toBe(true);
  });

  test("an entry that cannot be cancelled may have just filled: its ladder's stops are left alone", async () => {
    const t = NOW.getTime() - 9 * 3_600_000;
    const orders = [
      { orderId: "e1", intentId: ladderId(t, "p", 1, "entry"), type: "limit", side: "buy", base: "ETH", positionSide: "long", status: "open", quantity: "0.1", price: "3950" },
      { orderId: "s1", intentId: ladderId(t, "p", 1, "stop"), type: "stop_market", side: "sell", base: "ETH", positionSide: "long", reduceOnly: true, status: "open", quantity: "0.1", triggerPrice: "3800" },
    ];
    const api = fakePropr({ orders, cancelFails: true });
    await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).housekeep(NOW);
    expect(cancels(api)).toEqual(["e1"]);
  });
});

describe("Propr answers are parsed and fail closed", () => {
  const client = (api: ReturnType<typeof fakePropr>) => new ProprClient(KEY, BASE, api.fetchFn);

  test("a 200 in an unknown envelope is an error, never an empty list", async () => {
    for (const body of [{ items: [] }, { data: "none" }, { data: [1, 2] }, "ok", null]) {
      const api = fakePropr({ raw: { "/accounts/acc1/orders": body, "/accounts/acc1/positions": body } });
      await expect(client(api).orders("acc1")).rejects.toThrow("not in a shape the desk knows");
      await expect(client(api).positions("acc1")).rejects.toThrow("not in a shape the desk knows");
    }
    expect(await client(fakePropr({ raw: { "/accounts/acc1/orders": [] } })).orders("acc1")).toEqual([]);
  });

  test("rows missing what the guards read are refused; extra fields pass through", async () => {
    const orders = (rows: unknown[]) => client(fakePropr({ orders: rows })).orders("acc1");
    await expect(orders([{ type: "limit", base: "ETH" }])).rejects.toThrow("row 0: answer not in a shape the desk knows (status");
    await expect(orders([{ status: "open", type: "limit", quantity: "lots" }])).rejects.toThrow("quantity");
    expect(await orders([{ status: "open", type: "limit", novel: { a: 1 } }])).toEqual([{ status: "open", type: "limit", novel: { a: 1 } }]);
    const positions = (rows: unknown[]) => client(fakePropr({ positions: rows })).positions("acc1");
    await expect(positions([{ base: "ETH", positionSide: "long" }])).rejects.toThrow("quantity");
    await expect(positions([{ base: "ETH", quantity: "1" }])).rejects.toThrow("positionSide");
    await expect(positions([{ positionSide: "long", quantity: "1" }])).rejects.toThrow("no coin");
    await expect(client(fakePropr({ raw: { "/accounts/acc1": { equity: "1" } } })).account("acc1")).rejects.toThrow("balance");
  });

  test("shapes that mean the same are read: blank numbers, epoch timestamps, text booleans, upper-case words, a text total", async () => {
    const at = NOW.getTime() - 3_600_000;
    const rows = await client(
      fakePropr({
        orders: [
          { orderId: 1, status: "OPEN", type: "LIMIT", side: "BUY", positionSide: "Long", base: "ETH", reduceOnly: "false", quantity: "0.1", cumulativeQuantity: "", price: "3950", triggerPrice: "", createdAt: at },
          { orderId: 2, status: "open", type: "stop_market", side: "sell", positionSide: "LONG", base: "ETH", reduceOnly: "TRUE", quantity: "0.1", triggerPrice: "3800", createdAt: String(Math.floor(at / 1000)) },
        ],
      }),
    ).orders("acc1");
    expect(rows[0]).toMatchObject({ status: "open", type: "limit", side: "buy", positionSide: "long", reduceOnly: false, cumulativeQuantity: null, triggerPrice: null, createdAt: new Date(at).toISOString() });
    expect(rows[1]).toMatchObject({ reduceOnly: true, positionSide: "long", createdAt: new Date(Math.floor(at / 1000) * 1000).toISOString() });
    // The guards read them as what they are: one resting entry placed today, and a stop that is not an entry.
    expect(countEntriesToday(rows, NOW.getTime())).toBe(1);
    const s = snapshotFrom({ accountId: "acc1", attempt: { initialBalance: "25000" }, account: { balance: "25000", marginBalance: "" }, positions: [], orders: rows, trades: [], now: NOW.getTime() });
    expect(s).toMatchObject({ working: ["ETH"], equity: 25_000 });
    const trades = await client(fakePropr({ raw: { "/accounts/acc1/trades": { data: [{ executedAt: at, realizedPnl: "", fee: "1.5" }], total: "1" } } })).trades("acc1", 0);
    expect(trades).toEqual([{ executedAt: new Date(at).toISOString(), realizedPnl: null, fee: "1.5" }]);
    expect(await client(fakePropr({ positions: [{ base: "ETH", positionSide: "SHORT", quantity: "0.2", entryPrice: "", markPrice: 4000 }] })).positions("acc1")).toEqual([{ base: "ETH", positionSide: "short", quantity: "0.2", entryPrice: null, markPrice: 4000 }]);
  });

  test("a row that cannot be read and cannot be live is dropped: a flat or closed position, an order that is over", async () => {
    const flat = [{ base: "ETH", quantity: "0", positionSide: null }, { base: "ETH", quantity: 0, positionSide: "both" }, { base: "ETH", quantity: "0", positionSide: "LONG" }, { quantity: "x", status: "CLOSED" }];
    const open = { base: "BTC", positionSide: "short", quantity: "0.01", entryPrice: "100000", markPrice: "100000" };
    const api = fakePropr({
      positions: [...flat, open],
      orders: [{ status: "Cancelled", type: null }, { status: "filled", type: "limit", quantity: "lots" }, { status: "expired", type: "limit", createdAt: {} }, { orderId: "ok", status: "open", type: "limit", base: "ETH" }],
    });
    expect((await client(api).orders("acc1")).map((o) => o.orderId)).toEqual(["ok"]);
    const s = await new ProprBroker({ config: cfgOf(), market, fetchFn: api.fetchFn }).snapshot(NOW);
    expect(s.positions.map((p) => `${p.coin} ${p.side} ${p.qty}`)).toEqual(["BTC short 0.01"]);
    expect(s.unreadable).toEqual({ live: [], other: [] });
  });

  test("a row that may be live and cannot be read fails the strict read and is named by the tolerant one", async () => {
    const good = { orderId: "ok", status: "open", type: "limit", base: "ETH" };
    for (const bad of [{ orderId: "b", status: null, type: "limit" }, { orderId: "b", type: "limit" }, { orderId: "b", status: "open", type: "limit", quantity: "lots" }, { orderId: "b", status: "open", type: "limit", reduceOnly: "maybe" }]) {
      const api = fakePropr({ orders: [bad, good] });
      await expect(client(api).orders("acc1")).rejects.toThrow("row 0: answer not in a shape the desk knows");
      const skipped: string[] = [];
      expect(await client(api).orders("acc1", skipped)).toEqual([good]);
      expect(skipped).toEqual([expect.stringContaining("/orders row 0")]);
    }
    for (const bad of [{ base: "ETH", quantity: "1", positionSide: "both" }, { base: "ETH", quantity: "1", positionSide: null }, { base: "ETH", quantity: "", positionSide: "long" }, { positionSide: "long", quantity: "1" }]) {
      const api = fakePropr({ positions: [bad] });
      await expect(client(api).positions("acc1")).rejects.toThrow("not in a shape the desk knows");
      const skipped: string[] = [];
      expect(await client(api).positions("acc1", skipped)).toEqual([]);
      expect(skipped).toHaveLength(1);
    }
  });

  test("dropped rows still count toward the page, so the pages after them are read", async () => {
    const offsets: number[] = [];
    const fetchFn = (async (url: string) => {
      const o = Number(new URL(String(url)).searchParams.get("offset"));
      offsets.push(o);
      const data = o === 0 ? Array.from({ length: 100 }, (_, i) => (i < 40 ? { status: "cancelled", type: 5 } : { orderId: String(i), status: "open", type: "limit" })) : [{ orderId: "last", status: "open", type: "limit" }];
      return new Response(JSON.stringify({ data, total: "101" }), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await new ProprClient(KEY, BASE, fetchFn).orders("acc1");
    expect(rows).toHaveLength(61);
    expect(rows.at(-1)?.orderId).toBe("last");
    expect(offsets).toEqual([0, 100]);
  });

  describe("one live row that cannot be read", () => {
    const proposal = { coin: "ETH", side: "long", stop: 3800, target: 4500, riskPct: 0.5, setup: "s", thesis: "t", invalidation: "i", horizon: "swing", confidence: "medium" } as TradeProposal;
    const badOrder = { orderId: "bad", status: null, type: "limit", base: "SOL" };
    const build = (apiOpts: Parameters<typeof fakePropr>[0], store = new MemoryStore(() => NOW)) => {
      const api = fakePropr(apiOpts);
      const broker = freshBroker(api, store);
      const notifier = new RecordingNotifier();
      const service = new DeskService({ config: loadDeskConfig(env({ PROPR_LIVE: "true" })), store, data: new FakeData([ctx("ETH", 4000)]), notifier, now: () => NOW, broker });
      return { api, broker, service, notifier, store };
    };

    test("a new entry is blocked, by the governor and by the broker's own plan", async () => {
      const { api, broker, service } = build({ orders: [badOrder], positions: [] });
      const acc = await broker.account(new Map(), NOW);
      expect(acc).toMatchObject({ available: false, equityUsd: 25_000 });
      expect(acc.note).toContain("partly unreadable");
      const rec = await service.submitOpen(proposal, null);
      expect(rec.status).toBe("blocked");
      expect(rec.verdict.reasons.join(" ")).toContain("account unavailable");
      expect(await broker.open(order, sizing, "p1", NOW)).toMatchObject({ ok: false, error: expect.stringContaining("not in a shape the desk knows") });
      expect(api.posts()).toEqual([]);
    });

    test("the operator's close of a position that was read goes through, and cancels its ladder's rungs but no stop", async () => {
      const { api, service } = build({ orders: [...liveLadder(), badOrder], positions: [ethPos()], statuses: [["filled"]] });
      const rec = await service.submitExit({ coin: "ETH", fraction: 1, reason: "out" }, null);
      expect(rec.status).toBe("executed");
      expect(rec).toMatchObject({ execution: { fills: [{ side: "sell", size: 0.1 }] } });
      expect(cancels(api).filter(Boolean)).toEqual(["e1", "e2"]);
    });

    test("an unreadable position does not block the close of another, and a coin that was not read is refused as unavailable", async () => {
      const { service } = build({ orders: liveLadder(), positions: [ethPos(), { base: "SOL", positionSide: "both", quantity: "3" }], statuses: [["filled"]] });
      expect((await service.submitExit({ coin: "ETH", fraction: 1, reason: "out" }, null)).status).toBe("executed");
      const sol = await service.submitExit({ coin: "SOL", fraction: 1, reason: "out" }, null);
      expect(sol.status).toBe("blocked");
      expect(sol.verdict.reasons[0]).toContain("account unavailable: Propr account partly unreadable");
    });

    test("the kill switch cancels the rungs that were read and says a row was not; housekeeping cancels rungs, never a stop, and is critical", async () => {
      const opts: Parameters<typeof fakePropr>[0] = { orders: [...liveLadder(), badOrder], positions: [], stateful: true };
      const { api, service, notifier, store } = build(opts);
      await service.setKillSwitch(true, "halt", "operator");
      expect(cancels(api)).toEqual(["e1", "e2"]);
      expect(notifier.sent.at(-1)?.body).toContain("could not be read");
      expect(notifier.sent.at(-1)?.body).toContain("ETH: 2 resting orders cancelled");
      // The ladder is flat with no rung left: its stops would go after the grace, but not while a row is unreadable.
      for (let i = 1; i <= 3; i++) {
        const notes = await freshBroker(api, store).housekeep(new Date(NOW.getTime() + i * MIN15), { killSwitch: true });
        expect(notes).toEqual([{ level: "critical", key: "unreadable", text: expect.stringContaining("1 row skipped") }]);
      }
      expect(cancels(api)).toEqual(["e1", "e2"]);
      (opts.orders as unknown[]).pop();
      await freshBroker(api, store).housekeep(new Date(NOW.getTime() + 4 * MIN15));
      expect(cancels(api)).toEqual(["e1", "e2", "s0", "t0", "s1", "s2"]);
    });

    test("an unreadable account is critical when the last good read held a position or a resting rung, a warning when it held nothing", async () => {
      const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
      const failing = (store: MemoryStore) => new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: down, state: stateOf(store) }).housekeep(NOW);
      const empty = new MemoryStore(() => NOW);
      await freshBroker(fakePropr(), empty).housekeep(NOW);
      expect(await failing(empty)).toEqual([{ level: "warn", key: "unreadable", text: expect.stringContaining("Propr account unreadable") }]);
      const holding = new MemoryStore(() => NOW);
      await freshBroker(fakePropr({ orders: liveLadder(), positions: [ethPos()] }), holding).housekeep(NOW);
      expect(await holding.getState<ProprUpkeepState>(PROPR_UPKEEP_KEY)).toMatchObject({ exposure: { positions: 1, rungs: 2 } });
      const notes = await failing(holding);
      expect(notes).toEqual([{ level: "critical", key: "unreadable", text: expect.stringContaining("the last good read had 1 open position and 2 resting entry rungs") }]);
      // An unreadable envelope reads the same way, and the failed read does not overwrite what the last good one held.
      const odd = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: fakePropr({ raw: { "/accounts/acc1/orders": { result: [] } } }).fetchFn, state: stateOf(holding) });
      expect((await odd.housekeep(NOW))[0]).toMatchObject({ level: "critical", key: "unreadable" });
      expect((await holding.getState<ProprUpkeepState>(PROPR_UPKEEP_KEY))?.exposure).toEqual({ positions: 1, rungs: 2 });
      // Nor does a read that skipped a row: what it shows is not the whole account.
      await freshBroker(fakePropr({ orders: [badOrder] }), holding).housekeep(NOW);
      expect((await holding.getState<ProprUpkeepState>(PROPR_UPKEEP_KEY))?.exposure).toEqual({ positions: 1, rungs: 2 });
    });

    test("the watch repeats the critical unreadable alert hourly while it lasts", async () => {
      let t = NOW.getTime();
      const now = () => new Date(t);
      const store = new MemoryStore(now);
      const opts: Parameters<typeof fakePropr>[0] = { orders: liveLadder(), positions: [ethPos()] };
      const api = fakePropr(opts);
      const notifier = new RecordingNotifier();
      const service = new DeskService({ config: loadDeskConfig(env({ PROPR_LIVE: "true", DESK_REVIEW_HOURS: "0" })), store, data: new FakeData([ctx("ETH", 4000)]), notifier, now, broker: freshBroker(api, store) });
      await tick(service, { runCycle: false });
      opts.raw = { "/accounts/acc1/orders": "garbage" };
      const critical = () => notifier.sent.filter((a) => a.level === "critical" && a.body.includes("Propr account unreadable")).length;
      for (const step of [60_000, 60_000, 3_600_000]) {
        t += step;
        await tick(service, { runCycle: false });
      }
      expect(critical()).toBe(2);
    });
  });

  test("an unrecognised list makes the account unavailable, housekeeping says so, and the governor blocks the entry", async () => {
    const api = fakePropr({ raw: { "/accounts/acc1/orders": { result: { orders: [] } } } });
    const broker = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    expect(await broker.account(new Map(), NOW)).toMatchObject({ available: false, note: expect.stringContaining("not in a shape the desk knows") });
    expect((await broker.housekeep(NOW))[0]).toMatchObject({ key: "unreadable" });
    const service = new DeskService({ config: loadDeskConfig(env({ PROPR_LIVE: "true" })), store: new MemoryStore(() => NOW), data: new FakeData([ctx("ETH", 4000)]), notifier: new RecordingNotifier(), now: () => NOW, broker });
    const rec = await service.submitOpen({ coin: "ETH", side: "long", stop: 3800, target: 4500, riskPct: 0.5, setup: "s", thesis: "t", invalidation: "i", horizon: "swing", confidence: "medium" } as TradeProposal, null);
    expect(rec).toMatchObject({ status: "blocked", verdict: { reasons: expect.arrayContaining([expect.stringContaining("account unavailable")]) } });
    expect(api.posts()).toEqual([]);
  });

  test("a create-orders answer that cannot be read stops the ladder", async () => {
    const calls: string[] = [];
    const inner = fakePropr();
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).endsWith("/orders")) {
        calls.push(String(url));
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      return inner.fetchFn(url, init);
    }) as typeof fetch;
    const res = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn }).open(order, sizing, "p1", NOW);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("the orders may have been placed") });
    expect(calls).toHaveLength(1);
  });

  describe("pagination", () => {
    const page = (n: number, from = 0, extra: (i: number) => Record<string, unknown> = () => ({})) => Array.from({ length: n }, (_, i) => ({ orderId: String(from + i), status: "open", type: "limit", ...extra(from + i) }));
    function paged(answer: (offset: number) => unknown) {
      const offsets: number[] = [];
      const fetchFn = (async (url: string) => {
        const u = new URL(String(url));
        offsets.push(Number(u.searchParams.get("offset")));
        expect(u.searchParams.get("limit")).toBe("100");
        return new Response(JSON.stringify(answer(Number(u.searchParams.get("offset")))), { status: 200 });
      }) as unknown as typeof fetch;
      return { offsets, client: new ProprClient(KEY, BASE, fetchFn) };
    }

    test("a short page ends the list", async () => {
      const p = paged((o) => ({ data: o === 0 ? page(100) : page(30, 100) }));
      expect(await p.client.orders("acc1")).toHaveLength(130);
      expect(p.offsets).toEqual([0, 100]);
    });

    test("the reported total ends the list without another request", async () => {
      const p = paged((o) => ({ data: page(100, o), total: 200 }));
      expect(await p.client.orders("acc1")).toHaveLength(200);
      expect(p.offsets).toEqual([0, 100]);
      const text = paged((o) => ({ data: page(100, o), total: "200" }));
      expect(await text.client.orders("acc1")).toHaveLength(200);
      expect(text.offsets).toEqual([0, 100]);
    });

    test("full pages with no total stop at ten pages", async () => {
      const p = paged((o) => page(100, o));
      expect(await p.client.orders("acc1")).toHaveLength(1000);
      expect(p.offsets).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    });

    test("trades stop at the first page whose last row is older than `since`", async () => {
      const since = Date.parse("2026-10-05T00:00:00Z");
      const at = (i: number) => ({ executedAt: new Date(since + 3_600_000 - i * 60_000).toISOString() });
      const p = paged((o) => ({ data: page(100, o, at) }));
      expect(await p.client.trades("acc1", since)).toHaveLength(100);
      expect(p.offsets).toEqual([0]);
      const fresh = paged((o) => ({ data: o === 0 ? page(100, 0, () => ({ executedAt: new Date(since + 1).toISOString() })) : page(100, 100, at) }));
      expect(await fresh.client.trades("acc1", since)).toHaveLength(200);
      expect(fresh.offsets).toEqual([0, 100]);
    });

    test("a later page in an unknown shape fails the whole read", async () => {
      const p = paged((o) => (o === 0 ? { data: page(100) } : { error: "rate limited" }));
      await expect(p.client.orders("acc1")).rejects.toThrow("not in a shape the desk knows");
    });
  });
});

describe("DeskService on the Propr venue", () => {
  const proposal: TradeProposal = { coin: "ETH", side: "long", setup: "flush reversion", thesis: "OI flushed into the level and funding reset.", horizon: "swing", confidence: "medium", stop: 3800, target: 4500, riskPct: 0.5, invalidation: "back under 3800", evidence: [{ source: "a", point: "one" }, { source: "b", point: "two" }] };
  const build = (over: Record<string, string> = {}, apiOpts: Parameters<typeof fakePropr>[0] = {}) => {
    const now = () => NOW;
    const api = fakePropr(apiOpts);
    const config = loadDeskConfig(env(over));
    const notifier = new RecordingNotifier();
    const service = new DeskService({ config, store: new MemoryStore(now), data: new FakeData([ctx("ETH", 4000)]), notifier, now, broker: new ProprBroker({ config: config.propr!, market, fetchFn: api.fetchFn }) });
    return { api, notifier, service };
  };

  test("entries wait for approval; an approval runs once; a dry run is recorded as not filled, with the requests kept", async () => {
    const { api, notifier, service } = build({ DESK_APPROVAL: "auto" });
    expect(await service.approval()).toBe("manual");
    await expect(service.setApproval("auto", "op")).rejects.toThrow("stays manual");
    const rec = await service.submitOpen(proposal, null);
    expect(rec).toMatchObject({ status: "pending", venue: "propr" });
    const [a, b] = await Promise.allSettled([service.approve(rec.id, "op"), service.approve(rec.id, "telegram")]);
    expect(a.status).toBe("fulfilled");
    expect(b).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "proposal is already being decided" }) });
    const done = (a as PromiseFulfilledResult<Awaited<ReturnType<DeskService["approve"]>>>).value;
    expect(done).toMatchObject({ status: "failed", decidedBy: "op", verdict: { approved: true, sizing: { markPx: 4000, size: 0.62 } } });
    const exec = done.execution as { error: string; requests: unknown[]; dryRun: boolean };
    expect(exec).toMatchObject({ dryRun: true, error: expect.stringContaining("Propr dry run") });
    expect(exec.requests).toHaveLength(6);
    expect(notifier.sent.at(-1)).toMatchObject({ level: "info", title: "Dry run: long ETH built, not sent (propr)" });
    expect(api.posts()).toEqual([]);
  });

  test("a platform ticket placed on a dry run reports the venue's reason, not an empty one", async () => {
    const { service } = build();
    const placed = await deskRisk(() => service).place({ coin: "ETH", side: "long", stopPx: 3800, targetPx: 4500 }, "opp:o1");
    expect(placed.status).not.toBe("executed");
    expect(placed.reasons.join(" ")).toContain("Propr dry run");
  });

  test("a platform ticket's conviction or leverage picks the ladder's leverage, never its size", async () => {
    const now = () => NOW;
    const config = loadDeskConfig(env({ PROPR_LEVERAGE_BY_CONFIDENCE: "low:1, medium:2, high:4" }));
    const store = new MemoryStore(now);
    const service = new DeskService({ config, store, data: new FakeData([ctx("ETH", 4000)]), notifier: new RecordingNotifier(), now, broker: new ProprBroker({ config: config.propr!, market, fetchFn: fakePropr({}).fetchFn }) });
    const ticket = { coin: "ETH", side: "long" as const, stopPx: 3800, targetPx: 4500 };
    const leverageOf = async (t: Ticket) => {
      const rec = (await store.getProposal((await deskRisk(() => service).place(t, "opp:o1")).proposalId))!;
      return { leverage: ((rec.execution as { requests: Array<{ margin?: { leverage: number } }> }).requests[0]!.margin!).leverage, riskPct: (rec.proposal as { resolvedRiskPct: number }).resolvedRiskPct };
    };
    expect(await leverageOf({ ...ticket, confidence: "high" })).toEqual({ leverage: 4, riskPct: 0.5 });
    expect(await leverageOf({ ...ticket, confidence: "high", leverage: 3 })).toEqual({ leverage: 3, riskPct: 0.5 });
  });

  test("a claimed approval whose re-check throws (market data down) is recorded failed and not sent, never left claimed", async () => {
    const flat = build();
    const held = build({}, { positions: [{ base: "ETH", positionSide: "long", quantity: "0.2", entryPrice: "3990", markPrice: "4000" }] });
    const cases = [
      { ...flat, rec: await flat.service.submitOpen(proposal, null), title: "Open failed: ETH" },
      { ...held, rec: await held.service.submitExit({ coin: "ETH", fraction: 1, reason: "thesis broke" }, "run1"), title: "Exit failed: ETH" },
    ];
    for (const { api, notifier, service, rec, title } of cases) {
      expect(rec.status).toBe("pending");
      (service.data as FakeData).ctxs = async () => {
        throw new Error("info API down");
      };
      expect(await service.approve(rec.id, "op")).toMatchObject({ status: "failed", decidedBy: "op", execution: { ok: false, error: "not sent: info API down" } });
      await expect(service.approve(rec.id, "op")).rejects.toThrow("proposal is failed");
      expect(notifier.sent.at(-1)).toMatchObject({ level: "warn", title });
      expect(api.posts()).toEqual([]);
    }
  });

  test("a live close whose record and alert writes throw still returns executed (never failed with the close sent)", async () => {
    const { api, service } = build({ PROPR_LIVE: "true" }, { positions: [{ base: "ETH", positionSide: "long", quantity: "0.2", entryPrice: "3990", markPrice: "4000" }], statuses: [["filled"]] });
    const rec = await service.submitExit({ coin: "ETH", fraction: 1, reason: "thesis broke" }, "run1");
    const store = service.store as MemoryStore;
    const orig = store.updateProposal.bind(store);
    store.updateProposal = async () => {
      throw new Error("db down");
    };
    store.insertAlert = async () => {
      throw new Error("db down");
    };
    const err = console.error;
    console.error = () => {};
    const out = await service.approve(rec.id, "op").finally(() => {
      console.error = err;
      store.updateProposal = orig;
    });
    expect(out).toMatchObject({ status: "executed", decidedBy: "op", execution: { ok: true, fills: [{ side: "sell", size: 0.2 }] } });
    expect(api.posts().filter((c) => c.url.endsWith("/orders"))).toHaveLength(1);
  });

  test("an agent's exit waits for approval; the operator's close does not", async () => {
    const { service } = build({}, { positions: [{ base: "ETH", positionSide: "long", quantity: "0.2", entryPrice: "3990", markPrice: "4000" }] });
    expect(await service.submitExit({ coin: "ETH", fraction: 1, reason: "thesis broke" }, "run1")).toMatchObject({ status: "pending" });
    expect(await service.submitExit({ coin: "ETH", fraction: 1, reason: "operator close" }, null)).toMatchObject({ status: "failed", execution: { dryRun: true } });
  });

  test("a trade's leverage is the coin's notional ceiling (capped per coin), and the ladder runs at it", async () => {
    const { service } = build({ DESK_MAX_RISK_PCT: "2", DESK_MAX_GROSS_LEVERAGE: "10" });
    const op = (over: Partial<OperatorOrder> = {}): OperatorOrder => ({ coin: "ETH", side: "long", stop: 3980, riskPct: 2, source: "copilot", ...over });
    // 2% risk at a 0.5% stop wants 4x equity: DESK_MAX_COIN_LEVERAGE (1x) caps it without a choice, the trade's 5x does not.
    expect((await service.assessOperatorOrder(op())).verdict.sizing!.notionalUsd).toBeLessThanOrEqual(25_000);
    const five = await service.assessOperatorOrder(op({ leverage: 5, notionalUsd: 100_000 }));
    expect(five.verdict.sizing!.notionalUsd).toBeGreaterThan(90_000);
    const capped = await service.assessOperatorOrder(op({ leverage: 20, notionalUsd: 100_000 }));
    expect(capped.verdict.warnings[0]).toContain("capped at Propr's 10x");
  });

  test("the watch tick alerts housekeeping once, and an unprotected position as critical once an hour", async () => {
    const old = NOW.getTime() - 9 * 3_600_000;
    let t = NOW.getTime();
    const now = () => new Date(t);
    const api = fakePropr({
      orders: [{ orderId: "o1", intentId: ladderId(old, "p", 1, "entry"), type: "limit", base: "ETH", positionSide: "long", status: "open", quantity: "0.12", price: "3950" }],
      positions: [{ base: "BTC", positionSide: "long", quantity: "0.01", entryPrice: "100000", markPrice: "100000" }],
    });
    const config = loadDeskConfig(env({ PROPR_LIVE: "true", DESK_REVIEW_HOURS: "0" }));
    const notifier = new RecordingNotifier();
    const service = new DeskService({ config, store: new MemoryStore(now), data: new FakeData([ctx("ETH", 4000), ctx("BTC", 100_000)]), notifier, now, broker: new ProprBroker({ config: config.propr!, market, fetchFn: api.fetchFn }) });
    await tick(service, { runCycle: false });
    expect(notifier.sent.find((a) => a.title === "propr housekeeping")?.body).toContain("ETH: 1 resting order cancelled, the ladder is 9.0h old");
    const critical = () => notifier.sent.filter((a) => a.level === "critical" && a.title === "propr account check").length;
    expect(critical()).toBe(1);
    t += 60_000;
    await tick(service, { runCycle: false });
    expect(critical()).toBe(1);
    t += 3_600_000;
    await tick(service, { runCycle: false });
    expect(critical()).toBe(2);
  });

  test("the service builds the Propr broker from config", () => {
    const service = new DeskService({ config: loadDeskConfig(env()), store: new MemoryStore(() => NOW), data: new FakeData([ctx("ETH", 4000)]), notifier: new RecordingNotifier() });
    expect(service.broker).toMatchObject({ venue: "propr", live: false, accountId: "acc1" });
    expect(JSON.stringify(service.broker)).not.toContain(KEY);
  });
});
