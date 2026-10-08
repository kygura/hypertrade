import { z } from "zod";
import { parseMetaAndCtxs } from "../../../shared/hl-client.js";
import type { AssetCtx } from "../../../shared/types.js";
import { readHlAccount, type InfoFn } from "../data.js";
import type { MarketRef } from "../governor.js";
import type { Broker, ExecutionResult } from "../paper.js";
import type { AccountState, Sizing, TradeProposal } from "../types.js";
import { addressOf, signL1Action } from "./signing.js";
import { cancelAction, orderAction, roundPerpPx, slippagePx, updateLeverageAction, type OrderRequest } from "./wire.js";

// Live Hyperliquid broker, TESTNET ONLY. Same Broker shape as the paper
// book, so the governor and approval flow in service.ts are unchanged.
//
// Keys: DESK_HL_SECRET_KEY is an API ("agent") wallet approved on the
// account at app.hyperliquid-testnet.xyz/API. An agent wallet can trade but
// cannot withdraw. DESK_HL_ACCOUNT is the master account it trades for
// (positions and equity are read from there); it defaults to the key's own
// address for a key that is itself the account.
//
// An entry is one signed action, grouping "normalTpsl":
//   [0] IOC limit `slippage` through the venue mark      (the entry)
//   [1] reduce-only market stop at the proposal's stop  (tpsl "sl")
//   [2] reduce-only market take-profit at its target    (tpsl "tp")
// If the entry fills but the stop is rejected, the position is flattened at
// once: the desk never holds a live position without an exchange-side stop.

export const TESTNET_API = "https://api.hyperliquid-testnet.xyz";

export interface HlBrokerOptions {
  secretKey: string;
  account?: string;
  /** Cross leverage set on the coin before an entry (capped by the coin's max). */
  leverage: number;
  /** Fraction through the mark for marketable IOC orders (HL SDK default 5%; 1% here). */
  slippage: number;
  takerFee: number;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** Nonce clock; must increase per action. */
  clock?: () => number;
}

const StatusSchema = z.union([
  z.object({ filled: z.object({ totalSz: z.string(), avgPx: z.string(), oid: z.number() }) }),
  z.object({ resting: z.object({ oid: z.number() }) }),
  z.object({ error: z.string() }),
  z.string(),
]);
const OrderResponseSchema = z.object({
  status: z.literal("ok"),
  response: z.object({ type: z.literal("order"), data: z.object({ statuses: z.array(StatusSchema) }) }),
});
const OkSchema = z.object({ status: z.literal("ok") }).passthrough();

type Status = z.infer<typeof StatusSchema>;
const statusError = (s: Status | undefined) => (s == null ? "no status" : typeof s === "string" ? s : "error" in s ? s.error : null);

export class HlBroker implements Broker {
  readonly venue = "hl-testnet";
  readonly live = true;
  /** The account whose positions and equity this broker trades and reads. */
  readonly address: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly clock: () => number;
  private lastNonce = 0;
  private cache: { at: number; ctxs: AssetCtx[] } | null = null;

  constructor(private readonly o: HlBrokerOptions) {
    this.address = (o.account ?? addressOf(o.secretKey)).toLowerCase();
    this.base = (o.baseUrl ?? TESTNET_API).replace(/\/+$/, "");
    this.fetchFn = o.fetchFn ?? fetch;
    this.clock = o.clock ?? Date.now;
  }

  private async post(path: "/info" | "/exchange", body: unknown): Promise<unknown> {
    const r = await this.fetchFn(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HL testnet ${path} HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  private info: InfoFn = async <T>(body: { type: string } & Record<string, unknown>) => (await this.post("/info", body)) as T;

  private async exchange(action: unknown): Promise<unknown> {
    const nonce = Math.max(this.clock(), this.lastNonce + 1);
    this.lastNonce = nonce;
    const signature = signL1Action(this.o.secretKey, action, null, nonce, null, false);
    return this.post("/exchange", { action, nonce, signature, vaultAddress: null, expiresAfter: null });
  }

  /** Venue contexts (testnet marks and asset indices), cached 10s. */
  async venueCtxs(): Promise<AssetCtx[]> {
    if (!this.cache || this.clock() - this.cache.at > 10_000) {
      this.cache = { at: this.clock(), ctxs: parseMetaAndCtxs(await this.info({ type: "metaAndAssetCtxs" })).ctxs };
    }
    return this.cache.ctxs;
  }

  private async asset(coin: string): Promise<{ index: number; ctx: AssetCtx }> {
    const ctxs = await this.venueCtxs();
    const index = ctxs.findIndex((c) => c.name === coin);
    if (index < 0) throw new Error(`${coin} is not listed on Hyperliquid testnet`);
    return { index, ctx: ctxs[index]! };
  }

  async market(coin: string): Promise<MarketRef | null> {
    const ctxs = await this.venueCtxs();
    const c = ctxs.find((x) => x.name === coin) ?? ctxs.find((x) => x.name.toLowerCase() === coin.toLowerCase());
    return c ? { coin: c.name, markPx: c.markPx, szDecimals: c.szDecimals, isDelisted: c.isDelisted } : null;
  }

  async account(): Promise<AccountState> {
    return readHlAccount(this.address, this.info, this.venue);
  }

  async open(p: TradeProposal, sizing: Sizing): Promise<ExecutionResult> {
    try {
      const { index, ctx } = await this.asset(p.coin);
      const isBuy = p.side === "long";
      const leverage = Math.max(1, Math.min(Math.round(this.o.leverage), ctx.maxLeverage ?? 1));
      OkSchema.parse(await this.exchange(updateLeverageAction(index, true, leverage)));

      const sz = sizing.size;
      const legs: OrderRequest[] = [
        { asset: index, isBuy, limitPx: slippagePx(ctx.markPx, isBuy, this.o.slippage, ctx.szDecimals), sz, reduceOnly: false, orderType: { limit: { tif: "Ioc" } } },
        {
          asset: index,
          isBuy: !isBuy,
          limitPx: slippagePx(p.stop, !isBuy, this.o.slippage, ctx.szDecimals),
          sz,
          reduceOnly: true,
          orderType: { trigger: { isMarket: true, triggerPx: roundPerpPx(p.stop, ctx.szDecimals), tpsl: "sl" } },
        },
        {
          asset: index,
          isBuy: !isBuy,
          limitPx: slippagePx(p.target, !isBuy, this.o.slippage, ctx.szDecimals),
          sz,
          reduceOnly: true,
          orderType: { trigger: { isMarket: true, triggerPx: roundPerpPx(p.target, ctx.szDecimals), tpsl: "tp" } },
        },
      ];
      const res = OrderResponseSchema.safeParse(await this.exchange(orderAction(legs, "normalTpsl")));
      if (!res.success) return { ok: false, venue: this.venue, fills: [], error: "order rejected by the exchange" };
      const [entry, stop, target] = res.data.response.data.statuses;
      if (!entry || typeof entry === "string" || !("filled" in entry)) {
        return { ok: false, venue: this.venue, fills: [], error: `entry not filled: ${statusError(entry) ?? "IOC did not cross"}` };
      }
      const size = Number(entry.filled.totalSz);
      const px = Number(entry.filled.avgPx);
      const fill = { side: isBuy ? ("buy" as const) : ("sell" as const), size, px, fee: size * px * this.o.takerFee, pnl: 0 };
      const stopErr = statusError(stop);
      if (stopErr) {
        // No exchange-side stop: flatten now rather than hold it unprotected.
        const flat = await this.exit(p.coin, size, px);
        return { ok: false, venue: this.venue, fills: [fill, ...flat.fills], error: `stop order rejected (${stopErr}); position flattened${flat.ok ? "" : ` — FLATTEN FAILED: ${flat.error}`}` };
      }
      const tpErr = statusError(target);
      return { ok: true, venue: this.venue, fills: [fill], note: `oid ${entry.filled.oid}${tpErr ? `; take-profit rejected (${tpErr}), stop is live` : ""}` };
    } catch (err) {
      return { ok: false, venue: this.venue, fills: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  async exit(coin: string, size: number, _markPx?: number): Promise<ExecutionResult> {
    try {
      const { index, ctx } = await this.asset(coin);
      const acc = await this.account();
      const pos = acc.positions.find((x) => x.coin === coin);
      if (!pos) return { ok: false, venue: this.venue, fills: [], error: `no ${coin} position on testnet` };
      const qty = Math.min(size, pos.size);
      const isBuy = pos.side === "short";
      const res = OrderResponseSchema.safeParse(
        await this.exchange(
          orderAction([{ asset: index, isBuy, limitPx: slippagePx(ctx.markPx, isBuy, this.o.slippage, ctx.szDecimals), sz: qty, reduceOnly: true, orderType: { limit: { tif: "Ioc" } } }]),
        ),
      );
      if (!res.success) return { ok: false, venue: this.venue, fills: [], error: "exit rejected by the exchange" };
      const st = res.data.response.data.statuses[0];
      if (!st || typeof st === "string" || !("filled" in st)) return { ok: false, venue: this.venue, fills: [], error: `exit not filled: ${statusError(st) ?? "IOC did not cross"}` };
      const filled = Number(st.filled.totalSz);
      const px = Number(st.filled.avgPx);
      const pnl = (pos.side === "long" ? px - pos.entryPx : pos.entryPx - px) * filled;
      // Flat now: cancel the position's leftover reduce-only triggers.
      let note: string | undefined;
      if (filled >= pos.size - 1e-12) note = await this.cancelTriggers(coin, index);
      return { ok: true, venue: this.venue, fills: [{ side: isBuy ? "buy" : "sell", size: filled, px, fee: filled * px * this.o.takerFee, pnl }], note };
    } catch (err) {
      return { ok: false, venue: this.venue, fills: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async cancelTriggers(coin: string, asset: number): Promise<string | undefined> {
    const orders = z
      .array(z.object({ coin: z.string(), oid: z.number(), isTrigger: z.boolean().optional(), reduceOnly: z.boolean().optional() }).passthrough())
      .safeParse(await this.info({ type: "frontendOpenOrders", user: this.address }));
    const mine = orders.success ? orders.data.filter((o) => o.coin === coin && o.reduceOnly) : [];
    if (!mine.length) return undefined;
    const res = await this.exchange(cancelAction(mine.map((o) => ({ asset, oid: o.oid })))).catch((err) => ({ error: String(err) }));
    return OkSchema.safeParse(res).success ? `cancelled ${mine.length} leftover trigger orders` : `could not cancel leftover trigger orders`;
  }
}
