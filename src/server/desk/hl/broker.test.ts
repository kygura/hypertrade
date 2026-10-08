import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { loadDeskConfig } from "../config.js";
import { DeskService } from "../service.js";
import { MemoryStore } from "../store.js";
import { FakeData, RecordingNotifier, ctx } from "../testkit.js";
import type { TradeProposal } from "../types.js";
import { HlBroker, TESTNET_API } from "./broker.js";
import { actionHash, addressOf, agentDigest } from "./signing.js";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const MASTER = "0x1111111111111111111111111111111111111111";

const meta = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 40 },
    { name: "ETH", szDecimals: 4, maxLeverage: 25 },
  ],
};
const assetCtx = (px: string) => ({ funding: "0.00001", openInterest: "100", prevDayPx: px, dayNtlVlm: "1000000", premium: "0", oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px], dayBaseVlm: "10" });

type Exchange = { action: any; nonce: number; signature: { r: string; s: string; v: number }; vaultAddress: null; expiresAfter: null };

/** A fake testnet API: records exchange posts, checks every signature, answers from a script. */
function fakeTestnet(opts: { orderStatuses?: unknown[][]; position?: { coin: string; szi: string; entryPx: string } | null; openOrders?: unknown[] } = {}) {
  const posted: Exchange[] = [];
  const urls: string[] = [];
  const statuses = [...(opts.orderStatuses ?? [])];
  let position = opts.position ?? null;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body));
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (String(url) === `${TESTNET_API}/info`) {
      if (body.type === "metaAndAssetCtxs") return json([meta, [assetCtx("100000"), assetCtx("4000")]]);
      if (body.type === "clearinghouseState") {
        return json({
          marginSummary: { accountValue: "5000", totalNtlPos: "0" },
          assetPositions: position ? [{ position: { ...position, positionValue: String(Math.abs(Number(position.szi)) * 4000), unrealizedPnl: "0" } }] : [],
        });
      }
      if (body.type === "frontendOpenOrders") return json(opts.openOrders ?? []);
      if (body.type === "portfolio") return json([]);
    }
    if (String(url) === `${TESTNET_API}/exchange`) {
      const ex = body as Exchange;
      // The signature must recover to the signer for exactly the posted action and nonce.
      const digest = agentDigest(actionHash(ex.action, null, ex.nonce, null), false);
      const sig = new secp256k1.Signature(BigInt(ex.signature.r), BigInt(ex.signature.s), ex.signature.v - 27);
      const pub = sig.recoverPublicKey(digest).toBytes(false);
      expect(`0x${bytesToHex(keccak_256(pub.slice(1)).slice(-20))}`).toBe(addressOf(KEY));
      posted.push(ex);
      if (ex.action.type === "order") {
        const st = statuses.shift() ?? [{ error: "unscripted" }];
        if (ex.action.orders[0].r === false && (st[0] as any)?.filled) position = { coin: "ETH", szi: ex.action.orders[0].b ? ex.action.orders[0].s : `-${ex.action.orders[0].s}`, entryPx: "4000" };
        return json({ status: "ok", response: { type: "order", data: { statuses: st } } });
      }
      return json({ status: "ok", response: { type: "default" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const broker = new HlBroker({ secretKey: KEY, account: MASTER, leverage: 3, slippage: 0.01, takerFee: 0.00045, fetchFn, clock: () => 1_760_000_000_000 });
  return { broker, posted, urls };
}

const long: TradeProposal = {
  coin: "ETH",
  side: "long",
  setup: "spot-led breakout",
  thesis: "Spot-led breakout with OI flat and volume rising into highs.",
  horizon: "swing",
  confidence: "medium",
  stop: 3800,
  target: 4500,
  riskPct: 0.5,
  invalidation: "back under 3850",
  evidence: [
    { source: "a", point: "one" },
    { source: "b", point: "two" },
  ],
};
const sizing = { markPx: 4000, size: 0.25, notionalUsd: 1000, riskUsd: 50, stopDistPct: 5, rr: 2.5, feeUsd: 0.9, grossLeverageAfter: 0.2 };

describe("HlBroker (testnet)", () => {
  test("an entry sets leverage, then sends entry + stop + target as one normalTpsl action", async () => {
    const { broker, posted, urls } = fakeTestnet({ orderStatuses: [[{ filled: { totalSz: "0.25", avgPx: "4001.5", oid: 77 } }, { resting: { oid: 78 } }, { resting: { oid: 79 } }]] });
    const r = await broker.open(long, sizing);
    expect(r).toMatchObject({ ok: true, venue: "hl-testnet", fills: [{ side: "buy", size: 0.25, px: 4001.5 }] });
    expect(urls.every((u) => u.startsWith(TESTNET_API))).toBe(true);
    expect(posted[0]!.action).toEqual({ type: "updateLeverage", asset: 1, isCross: true, leverage: 3 });
    const order = posted[1]!.action;
    expect(order.grouping).toBe("normalTpsl");
    expect(order.orders).toEqual([
      { a: 1, b: true, p: "4040", s: "0.25", r: false, t: { limit: { tif: "Ioc" } } },
      { a: 1, b: false, p: "3762", s: "0.25", r: true, t: { trigger: { isMarket: true, triggerPx: "3800", tpsl: "sl" } } },
      { a: 1, b: false, p: "4455", s: "0.25", r: true, t: { trigger: { isMarket: true, triggerPx: "4500", tpsl: "tp" } } },
    ]);
    // Key order is part of the signed bytes.
    expect(Object.keys(order.orders[1])).toEqual(["a", "b", "p", "s", "r", "t"]);
    expect(posted[1]!.nonce).toBeGreaterThan(posted[0]!.nonce);
    expect(posted[1]!.vaultAddress).toBeNull();
  });

  test("an unfilled IOC entry is a failed execution", async () => {
    const { broker } = fakeTestnet({ orderStatuses: [[{ error: "Order could not immediately match against any resting orders." }, { resting: { oid: 2 } }, { resting: { oid: 3 } }]] });
    const r = await broker.open(long, sizing);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("could not immediately match");
  });

  test("a filled entry whose stop is rejected is flattened at once", async () => {
    const { broker, posted } = fakeTestnet({
      orderStatuses: [
        [{ filled: { totalSz: "0.25", avgPx: "4000", oid: 1 } }, { error: "Invalid TP/SL price." }, { resting: { oid: 3 } }],
        [{ filled: { totalSz: "0.25", avgPx: "3999", oid: 4 } }],
      ],
      openOrders: [{ coin: "ETH", oid: 3, isTrigger: true, reduceOnly: true }],
    });
    const r = await broker.open(long, sizing);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("position flattened");
    const flatten = posted.find((p, i) => i > 1 && p.action.type === "order")!.action.orders[0];
    expect(flatten).toMatchObject({ a: 1, b: false, r: true, s: "0.25", t: { limit: { tif: "Ioc" } } });
    // and the orphaned take-profit is cancelled
    expect(posted.at(-1)!.action).toEqual({ type: "cancel", cancels: [{ a: 1, o: 3 }] });
  });

  test("exits are reduce-only and read the position from the master account", async () => {
    const { broker, posted } = fakeTestnet({ position: { coin: "ETH", szi: "-0.5", entryPx: "4100" }, orderStatuses: [[{ filled: { totalSz: "0.2", avgPx: "4000", oid: 9 } }]] });
    const r = await broker.exit("ETH", 0.2);
    expect(r.ok).toBe(true);
    expect(r.fills[0]).toMatchObject({ side: "buy", size: 0.2, pnl: expect.closeTo(20, 6) });
    expect(posted[0]!.action.orders[0]).toMatchObject({ b: true, r: true, p: "4040" });
    expect(posted).toHaveLength(1); // partial: triggers stay
    const acc = await broker.account();
    expect(acc).toMatchObject({ venue: "hl-testnet", equityUsd: 5000, positions: [{ coin: "ETH", side: "short", size: 0.5 }] });
  });
});

describe("DeskService on the testnet venue", () => {
  test("the governor sizes against testnet marks and the order goes out", async () => {
    const now = () => new Date("2026-10-05T12:00:00Z");
    // Analysis data says ETH is at 4200; the venue says 4000. The venue wins.
    const data = new FakeData([ctx("ETH", 4200)]);
    const { broker, posted } = fakeTestnet({ orderStatuses: [[{ filled: { totalSz: "0.125", avgPx: "4000", oid: 1 } }, { resting: { oid: 2 } }, { resting: { oid: 3 } }]] });
    const service = new DeskService({ config: loadDeskConfig({}), store: new MemoryStore(now), data, notifier: new RecordingNotifier(), now, broker });
    const rec = await service.submitOpen(long, null);
    expect(rec.status).toBe("executed");
    expect(rec.venue).toBe("hl-testnet");
    expect(rec.verdict.sizing).toMatchObject({ markPx: 4000, size: 0.125, riskUsd: 25 }); // 0.5% of 5000 equity, 5% stop
    expect(posted[1]!.action.orders[0].s).toBe("0.125");
  });
});

describe("venue config", () => {
  test("hl-testnet needs a valid key; mainnet is refused; the account defaults to the key's address", () => {
    expect(loadDeskConfig({}).venue).toBe("paper");
    expect(loadDeskConfig({ DESK_VENUE: "hl-testnet" })).toMatchObject({ venue: "paper", venueNote: expect.stringContaining("DESK_HL_SECRET_KEY") });
    expect(loadDeskConfig({ DESK_VENUE: "hl-mainnet", DESK_HL_SECRET_KEY: KEY })).toMatchObject({ venue: "paper", venueNote: expect.stringContaining("not supported") });
    const c = loadDeskConfig({ DESK_VENUE: "hl-testnet", DESK_HL_SECRET_KEY: KEY.slice(2) });
    expect(c.venue).toBe("hl-testnet");
    expect(c.hl).toMatchObject({ secretKey: KEY, account: addressOf(KEY), leverage: 3, slippage: 0.01 });
    expect(loadDeskConfig({ DESK_VENUE: "hl-testnet", DESK_HL_SECRET_KEY: KEY, DESK_HL_ACCOUNT: MASTER }).hl!.account).toBe(MASTER);
  });
});
