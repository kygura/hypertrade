import { describe, expect, test } from "bun:test";
import { loadDeskConfig, type ProprVenueConfig } from "../config.js";
import { DeskService } from "../service.js";
import { MemoryStore } from "../store.js";
import { FakeData, RecordingNotifier, ctx } from "../testkit.js";
import type { RiskOrder, Sizing, TradeProposal } from "../types.js";
import { tick } from "../watch.js";
import { countEntriesToday, estimateDayStart, pendingLadderRisk, snapshotFrom, type ProprSnapshot } from "./account.js";
import { ProprBroker, sweepPlan } from "./broker.js";
import { proprBaseUrl, scrub } from "./client.js";
import { isLadderId, ladderId, ulid, ulidTime } from "./ids.js";
import { firmReasons, ladderEdge, ladderRequests, planLadder } from "./ladder.js";

const NOW = new Date("2026-10-05T12:00:00Z");
const KEY = "pk_live_secret123";
const BASE = "https://api.propr.xyz/v1";
const env = (over: Record<string, string> = {}) => ({ DESK_VENUE: "propr", PROPR_API_KEY: KEY, PROPR_ACCOUNT_ID: "acc1", ...over });
const cfgOf = (over: Record<string, string> = {}): ProprVenueConfig => loadDeskConfig(env(over)).propr!;

const order: RiskOrder = { coin: "ETH", side: "long", stop: 3800, target: 4500, riskPct: 0.5 };
const sizing: Sizing = { markPx: 4000, size: 0.625, notionalUsd: 2500, riskUsd: 125, stopDistPct: 5, rr: 2.5, feeUsd: 1.13, grossLeverageAfter: 0.1 };

function snap(over: Partial<ProprSnapshot> = {}): ProprSnapshot {
  return { accountId: "acc1", startingBalance: 25_000, balance: 25_000, equity: 25_000, dayStartBalance: 25_000, positions: [], entriesToday: 0, pendingRisk: 0, working: [], orders: [], ...over };
}

type Call = { method: string; url: string; headers: Record<string, string>; body: any };

/** A fake Propr API: records every call, answers GETs from state and POSTed orders from a script of statuses. */
function fakePropr(opts: { positions?: unknown[]; orders?: unknown[]; account?: Record<string, string>; statuses?: string[][] } = {}) {
  const calls: Call[] = [];
  const statuses = [...(opts.statuses ?? [])];
  let oid = 100;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const p = u.pathname.replace("/v1", "");
    if (p === "/challenge-attempts") return json({ data: [{ accountId: "acc1", initialBalance: "25000" }] });
    if (p === "/accounts/acc1") return json(opts.account ?? { balance: "25000", marginBalance: "25000", totalUnrealizedPnl: "0" });
    if (p === "/accounts/acc1/positions") return json({ data: opts.positions ?? [] });
    if (p === "/accounts/acc1/orders" && method === "GET") return json({ data: opts.orders ?? [] });
    if (p === "/accounts/acc1/trades") return json({ data: [] });
    if (p.startsWith("/accounts/acc1/margin-config/")) return json(method === "GET" ? { configId: "mc1", leverage: "1", marginMode: "cross" } : {});
    if (p.endsWith("/cancel")) return json({});
    if (p === "/accounts/acc1/orders" && method === "POST") {
      const st = statuses.shift() ?? body.orders.map(() => "open");
      return json({ data: body.orders.map((o: any, i: number) => ({ ...o, orderId: String(oid++), status: st[i] ?? "open", ...(o.type === "market" && st[i] === "filled" ? { averagePrice: "4001", cumulativeQuantity: o.quantity } : {}) })) });
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
    const c = cfgOf({ PROPR_LADDER_RUNGS: "50", PROPR_LADDER_RUNGS_BY_COIN: "btc:8, LIT=3, bad", PROPR_MAX_ENTRIES_PER_DAY: "9", PROPR_LADDER_FIRST_AT_MARKET: "no" });
    expect(c.ladder).toMatchObject({ rungs: 20, rungsByCoin: { BTC: 8, LIT: 3 }, firstAtMarket: false });
    expect(c.firm.maxEntriesPerDay).toBe(3);
  });

  test("the key stays out of the service's config surface and every error", () => {
    expect(scrub(`GET /x failed with ${KEY}`)).toBe("GET /x failed with pk_***");
    expect(() => proprBaseUrl("http://api.propr.xyz/v1")).toThrow();
    expect(proprBaseUrl("https://api.beta.propr.xyz/v1/")).toBe("https://api.beta.propr.xyz/v1");
  });
});

describe("ids", () => {
  test("ladder ids are deterministic ULIDs tagged PRX, carrying their time", () => {
    const a = ladderId(NOW.getTime(), "prop1", 2, "entry");
    expect(a).toBe(ladderId(NOW.getTime(), "prop1", 2, "entry"));
    expect(isLadderId(a)).toBe(true);
    expect(ulidTime(a)).toBe(NOW.getTime());
    expect(isLadderId(ulid(NOW.getTime(), "x"))).toBe(false);
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
    // A retried send of the same proposal builds the same ids, so Propr's idempotency stops a double order.
    expect(ladderRequests(plan!, "acc1", "prop1", NOW.getTime())).toEqual(reqs);
  });

  test("firm rules: entries per day, unprotected positions, resting entries, daily halt, both loss floors", () => {
    const f = cfgOf().firm;
    const { plan } = planLadder(order, sizing, 2, cfgOf().ladder);
    expect(firmReasons(snap(), plan!, f)).toEqual([]);
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

  test("a snapshot needs a balance and a starting balance; stops covering the position protect it", () => {
    const base = { accountId: "acc1", account: { balance: "25000" }, orders: [], trades: [], now: NOW.getTime() };
    expect(() => snapshotFrom({ ...base, attempt: {}, positions: [] })).toThrow("PROPR_STARTING_BALANCE");
    const s = snapshotFrom({
      ...base,
      attempt: { challenge: { initialBalance: "25000" } },
      positions: [{ base: "ETH", positionSide: "long", quantity: "0.2", entryPrice: "4000", markPrice: "4010" }],
      orders: [
        { base: "ETH", positionSide: "long", type: "stop_market", reduceOnly: true, status: "open", quantity: "0.1", triggerPrice: "3800" },
        { base: "ETH", positionSide: "long", type: "stop_market", reduceOnly: true, status: "open", quantity: "0.1", triggerPrice: "3790" },
      ],
    });
    expect(s.positions[0]).toMatchObject({ coin: "ETH", qty: 0.2, stop: 3790 });
  });
});

describe("ProprBroker", () => {
  test("a dry run reads the account and sends nothing", async () => {
    const api = fakePropr();
    const b = new ProprBroker({ config: cfgOf(), market, fetchFn: api.fetchFn });
    expect(b.live).toBe(false);
    const r = await b.open(order, sizing, "prop1", NOW);
    expect(r).toMatchObject({ ok: false, venue: "propr", error: expect.stringContaining("Propr dry run: 5 rung requests built, none sent") });
    expect(r.requests).toHaveLength(5);
    expect(api.posts()).toEqual([]);
    expect(api.calls.every((c) => c.url.startsWith(BASE) && c.headers["x-api-key"] === KEY)).toBe(true);
  });

  test("live: sets cross leverage, sends one request per rung, reports the market fill", async () => {
    const api = fakePropr({ statuses: [["filled", "open", "open"]] });
    const b = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    const r = await b.open(order, sizing, "prop1", NOW);
    expect(r).toMatchObject({ ok: true, fills: [{ side: "buy", size: 0.12, px: 4001 }], note: expect.stringContaining("5 of 5 rungs working") });
    expect(api.posts().filter((c) => c.url.endsWith("/orders"))).toHaveLength(5);
  });

  test("live: a refused stop on the market rung closes it at once and fails the open", async () => {
    const api = fakePropr({ statuses: [["filled", "rejected", "open"], ["filled"]] });
    const b = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    const r = await b.open(order, sizing, "prop1", NOW);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("closed at market");
    const last = api.posts().at(-1)!.body.orders[0];
    expect(last).toMatchObject({ type: "market", side: "sell", reduceOnly: true, closePosition: true });
  });

  test("the firm rules refuse before anything is sent", async () => {
    // $600 of open loss on a $25,000 day start: past half the 3% daily limit.
    const api = fakePropr({ account: { balance: "25000", marginBalance: "24400", totalUnrealizedPnl: "-600" } });
    const b = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    const r = await b.open(order, sizing, "prop1", NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Propr firm rules") });
    expect(api.posts()).toEqual([]);
  });

  test("an unreadable account is unavailable, with the key scrubbed", async () => {
    const fetchFn = (async () => {
      throw new Error(`boom ${KEY}`);
    }) as unknown as typeof fetch;
    const acc = await new ProprBroker({ config: cfgOf(), market, fetchFn }).account(new Map(), NOW);
    expect(acc.available).toBe(false);
    expect(acc.note).not.toContain(KEY);
  });

  test("exit closes the position and cancels the ladder's leftovers", async () => {
    const t = NOW.getTime() - 3_600_000;
    const api = fakePropr({
      positions: [{ base: "ETH", positionSide: "long", quantity: "0.24", entryPrice: "3990", markPrice: "4001" }],
      orders: [
        { orderId: "o1", intentId: ladderId(t, "p", 2, "entry"), type: "limit", base: "ETH", positionSide: "long", status: "open", quantity: "0.12", price: "3950" },
        { orderId: "o2", intentId: ladderId(t, "p", 0, "stop"), type: "stop_market", base: "ETH", positionSide: "long", reduceOnly: true, status: "open", quantity: "0.24", triggerPrice: "3800" },
        { orderId: "o3", intentId: "manual", type: "limit", base: "ETH", status: "open", quantity: "1", price: "3000" },
      ],
      statuses: [["filled"]],
    });
    const b = new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: api.fetchFn });
    const r = await b.exit("ETH", 0.24, 4001, "exit", "x1", NOW);
    expect(r.ok).toBe(true);
    expect(r.fills[0]).toMatchObject({ side: "sell", size: 0.24, px: 4001 });
    const cancels = api.posts().filter((c) => c.url.endsWith("/cancel")).map((c) => c.url);
    expect(cancels.some((u) => u.includes("/o1/"))).toBe(true);
    expect(cancels.some((u) => u.includes("/o3/"))).toBe(false);
  });

  test("housekeeping cancels a stale ladder, never your own orders, and only says so in a dry run", async () => {
    const old = NOW.getTime() - 9 * 3_600_000;
    const orders = [
      { orderId: "o1", intentId: ladderId(old, "p", 1, "entry"), type: "limit", base: "ETH", positionSide: "long", status: "open", quantity: "0.12", price: "3950" },
      { orderId: "o9", intentId: "manual", type: "limit", base: "ETH", status: "open", quantity: "1", price: "3000", createdAt: new Date(old).toISOString() },
    ];
    expect(sweepPlan(orders, [], NOW.getTime(), 8).map((x) => x.victims.map((o) => o.orderId))).toEqual([["o1"]]);
    const dry = fakePropr({ orders });
    expect(await new ProprBroker({ config: cfgOf(), market, fetchFn: dry.fetchFn }).housekeep(NOW)).toEqual([expect.stringContaining("dry run: would cancel 1 ETH order")]);
    expect(dry.posts()).toEqual([]);
    const live = fakePropr({ orders });
    expect(await new ProprBroker({ config: cfgOf({ PROPR_LIVE: "true" }), market, fetchFn: live.fetchFn }).housekeep(NOW)).toEqual([expect.stringContaining("1 resting order cancelled")]);
    expect(live.posts().map((c) => c.url)).toEqual([`${BASE}/accounts/acc1/orders/o1/cancel`]);
  });
});

describe("DeskService on the Propr venue", () => {
  test("a dry-run proposal is sized by the governor and recorded as not filled, with the requests kept", async () => {
    const now = () => NOW;
    const api = fakePropr();
    const config = loadDeskConfig(env());
    const broker = new ProprBroker({ config: config.propr!, market, fetchFn: api.fetchFn });
    const notifier = new RecordingNotifier();
    const service = new DeskService({ config, store: new MemoryStore(now), data: new FakeData([ctx("ETH", 4000)]), notifier, now, broker });
    const p: TradeProposal = { coin: "ETH", side: "long", setup: "flush reversion", thesis: "OI flushed into the level and funding reset.", horizon: "swing", confidence: "medium", stop: 3800, target: 4500, riskPct: 0.5, invalidation: "back under 3800", evidence: [{ source: "a", point: "one" }, { source: "b", point: "two" }] };
    const rec = await service.submitOpen(p, null);
    expect(rec).toMatchObject({ status: "failed", venue: "propr", verdict: { approved: true, sizing: { markPx: 4000, size: 0.62 } } });
    const exec = rec.execution as { error: string; requests: unknown[] };
    expect(exec.error).toContain("Propr dry run");
    expect(exec.requests).toHaveLength(5);
    expect(api.posts()).toEqual([]);
  });

  test("the watch tick runs housekeeping and alerts what it cancelled", async () => {
    const now = () => NOW;
    const old = NOW.getTime() - 9 * 3_600_000;
    const api = fakePropr({ orders: [{ orderId: "o1", intentId: ladderId(old, "p", 1, "entry"), type: "limit", base: "ETH", positionSide: "long", status: "open", quantity: "0.12", price: "3950" }] });
    const config = loadDeskConfig(env({ PROPR_LIVE: "true", DESK_REVIEW_HOURS: "0" }));
    const notifier = new RecordingNotifier();
    const service = new DeskService({ config, store: new MemoryStore(now), data: new FakeData([ctx("ETH", 4000)]), notifier, now, broker: new ProprBroker({ config: config.propr!, market, fetchFn: api.fetchFn }) });
    await tick(service, { runCycle: false });
    expect(notifier.sent.find((a) => a.title === "propr housekeeping")?.body).toContain("ETH: 1 resting order cancelled, the ladder is 9.0h old");
  });

  test("the service builds the Propr broker from config", () => {
    const service = new DeskService({ config: loadDeskConfig(env()), store: new MemoryStore(() => NOW), data: new FakeData([ctx("ETH", 4000)]), notifier: new RecordingNotifier() });
    expect(service.broker).toMatchObject({ venue: "propr", live: false, accountId: "acc1" });
    expect(JSON.stringify(service.broker)).not.toContain(KEY);
  });
});

