import { deskRisk, type Ticket } from "../../routes/platform.js";
import { describe, expect, test } from "bun:test";
import { loadDeskConfig, type ProprVenueConfig } from "../config.js";
import { DeskService } from "../service.js";
import { MemoryStore } from "../store.js";
import { FakeData, RecordingNotifier, ctx } from "../testkit.js";
import type { OperatorOrder, RiskOrder, Sizing, TradeProposal } from "../types.js";
import { tick } from "../watch.js";
import { countEntriesToday, estimateDayStart, pendingLadderRisk, snapshotFrom, type ProprSnapshot } from "./account.js";
import { ProprBroker, sweepPlan } from "./broker.js";
import { proprBaseUrl, scrub } from "./client.js";
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
  return { accountId: "acc1", startingBalance: 25_000, balance: 25_000, equity: 25_000, dayStartBalance: 25_000, positions: [], entriesToday: 0, pendingRisk: 0, working: [], perpRadarOrders: 0, orders: [], ...over };
}

/** perp-radar's own ladder ids: same layout, tag "PRX". */
const perpRadarId = (t: number) => {
  const id = ladderId(t, "pr", 0, "entry");
  return `${id.slice(0, 10)}PRX${id.slice(13)}`;
};

type Call = { method: string; url: string; headers: Record<string, string>; body: any; redirect?: string };

/** A fake Propr API: records every call, answers GETs from state and POSTed orders from a script of statuses. */
function fakePropr(opts: { positions?: unknown[]; orders?: unknown[]; account?: Record<string, string>; statuses?: string[][]; cancelFails?: boolean; unfilled?: boolean } = {}) {
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
    if (p === "/challenge-attempts") return json({ data: [{ accountId: "old", status: "failed", initialBalance: "25000" }, { accountId: "acc1", status: "active", initialBalance: "25000" }] });
    if (p === "/accounts/acc1") return json(opts.account ?? { balance: "25000", marginBalance: "25000", totalUnrealizedPnl: "0" });
    if (p === "/accounts/acc1/positions") return json({ data: opts.positions ?? [] });
    if (p === "/accounts/acc1/orders" && method === "GET") return json({ data: opts.orders ?? [] });
    if (p === "/accounts/acc1/trades") return json({ data: [] });
    if (p.startsWith("/accounts/acc1/margin-config/")) return json(method === "GET" ? { configId: "mc1", leverage: "1", marginMode: "cross" } : {});
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

  test("exit closes the position and, once the close is filled, cancels the ladder's leftovers", async () => {
    const api = fakePropr({ ...held(NOW.getTime() - 3_600_000), statuses: [["filled"]] });
    const r = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).exit("ETH", 0.24, 4001, "exit", "x1", NOW);
    expect(r.ok).toBe(true);
    expect(r.fills[0]).toMatchObject({ side: "sell", size: 0.24, px: 4001 });
    const cancels = api.posts().filter((c) => c.url.endsWith("/cancel")).map((c) => c.url);
    expect(cancels.some((u) => u.includes("/o1/"))).toBe(true);
    expect(cancels.some((u) => u.includes("/o2/"))).toBe(true);
    expect(cancels.some((u) => u.includes("/o3/"))).toBe(false);
  });

  test("exit leaves the stops in place while the close's fill is not reported", async () => {
    const api = fakePropr({ ...held(NOW.getTime() - 3_600_000), statuses: [["open"]], unfilled: true });
    const r = await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn }).exit("ETH", 0.24, 4001, "exit", "x1", NOW);
    expect(r).toMatchObject({ ok: true, fills: [], note: expect.stringContaining("not reported yet") });
    expect(api.posts().filter((c) => c.url.endsWith("/cancel"))).toEqual([]);
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
