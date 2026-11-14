import type { ProprVenueConfig } from "../config.js";
import type { MarketRef } from "../governor.js";
import type { Broker, ExecutionResult } from "../paper.js";
import type { AccountState, RiskOrder, Sizing } from "../types.js";
import { isEntry, isOpen, readSnapshot, toAccountState, type ProprPosition, type ProprSnapshot } from "./account.js";
import { ProprClient, scrub, type ProprOrderRequest, type Row } from "./client.js";
import { isLadderId, ulid, ulidTime } from "./ids.js";
import { firmReasons, ladderRequests, planLadder, type LadderPlan, type LadderRequest } from "./ladder.js";

// The Propr venue: a challenge or funded account on Hyperliquid mainnet, reached only through Propr's API. Entries go
// out as a ladder of rungs from the mark toward the stop, each rung with its own reduce-only stop (and take-profit),
// behind the governor and then Propr's firm rules. Nothing is sent unless PROPR_LIVE=true: a dry run builds the exact
// requests and returns them with ok:false, so the desk records the proposal as not filled.

export interface ProprBrokerOptions {
  config: ProprVenueConfig;
  /** Hyperliquid mainnet market (mark, size decimals) for a coin: Propr routes there, so the desk's own data applies. */
  market: (coin: string) => Promise<MarketRef | null>;
  fetchFn?: typeof fetch;
}

export interface ProprExecutionResult extends ExecutionResult {
  /** The requests a dry run built (or a live run sent), for the record. */
  requests?: unknown[];
}

const BAD = ["rejected", "cancelled", "canceled", "expired"];
const num = (x: unknown): number | null => {
  const v = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(v) ? v : null;
};
const errText = (e: unknown) => scrub(e instanceof Error ? e.message : String(e));

export class ProprBroker implements Broker {
  readonly venue = "propr";
  readonly live: boolean;
  readonly accountId: string;
  private readonly client: ProprClient;
  /** Everything but the key, which only the client holds. */
  private readonly cfg: Omit<ProprVenueConfig, "apiKey">;
  readonly #market: ProprBrokerOptions["market"];

  constructor(o: ProprBrokerOptions) {
    const { apiKey, ...cfg } = o.config;
    this.cfg = cfg;
    this.live = cfg.live;
    this.accountId = cfg.accountId;
    this.#market = o.market;
    this.client = new ProprClient(apiKey, cfg.baseUrl, o.fetchFn ?? fetch);
  }

  market(coin: string): Promise<MarketRef | null> {
    return this.#market(coin);
  }

  snapshot(now: Date): Promise<ProprSnapshot> {
    return readSnapshot(this.client, this.accountId, this.cfg.startingBalance, now.getTime());
  }

  async account(marks: Map<string, number>, now: Date): Promise<AccountState> {
    try {
      const s = await this.snapshot(now);
      return toAccountState(s, marks, this.venue, this.live ? undefined : "dry run: orders are built, not sent (PROPR_LIVE is not true)");
    } catch (e) {
      return { venue: this.venue, equityUsd: 0, dayPnlUsd: 0, positions: [], available: false, note: `Propr account unreadable: ${errText(e)}` };
    }
  }

  /** The ladder the desk would send for a governor-approved order, with the firm's reasons to refuse it. */
  async plan(p: RiskOrder, sizing: Sizing, now: Date): Promise<{ plan?: LadderPlan; snapshot?: ProprSnapshot; reasons: string[] }> {
    const m = await this.#market(p.coin);
    if (!m) return { reasons: [`${p.coin} is not listed on Hyperliquid`] };
    const { plan, reasons } = planLadder(p, sizing, m.szDecimals, this.cfg.ladder);
    if (!plan) return { reasons };
    const snapshot = await this.snapshot(now);
    return { plan, snapshot, reasons: firmReasons(snapshot, plan, this.cfg.firm) };
  }

  async open(p: RiskOrder, sizing: Sizing, proposalId: string, now: Date): Promise<ProprExecutionResult> {
    let planned: Awaited<ReturnType<ProprBroker["plan"]>>;
    try {
      planned = await this.plan(p, sizing, now);
    } catch (e) {
      return { ok: false, venue: this.venue, fills: [], error: `Propr: ${errText(e)}` };
    }
    const { plan, snapshot } = planned;
    if (!plan || !snapshot || planned.reasons.length) {
      return { ok: false, venue: this.venue, fills: [], error: `Propr firm rules: ${planned.reasons.join("; ")}` };
    }
    const reqs = ladderRequests(plan, this.accountId, proposalId, now.getTime());
    const shape = `${plan.rungs.length} rung${plan.rungs.length === 1 ? "" : "s"} ${plan.rungs.map((r) => r.px).join(" / ")}, ${plan.qty} ${plan.coin} total, risk $${plan.riskUsd}`;
    if (!this.live) {
      return { ok: false, venue: this.venue, fills: [], requests: reqs, error: `Propr dry run: ${reqs.length} rung request${reqs.length === 1 ? "" : "s"} built, none sent (${shape})` };
    }
    try {
      return await this.placeLive(plan, snapshot, reqs, shape);
    } catch (e) {
      return { ok: false, venue: this.venue, fills: [], requests: reqs, error: `Propr: ${errText(e)}` };
    }
  }

  private async placeLive(plan: LadderPlan, s: ProprSnapshot, reqs: LadderRequest[], shape: string): Promise<ProprExecutionResult> {
    // Cross margin, leverage high enough for the whole ladder, never above the venue ceiling.
    const needed = Math.min(this.cfg.maxLeverage, Math.max(1, Math.ceil(plan.notionalUsd / Math.max(1, s.equity))));
    const mc = await this.client.marginConfig(this.accountId, plan.coin);
    if ((num(mc.leverage) ?? 0) < needed || mc.marginMode !== "cross") await this.client.setLeverage(this.accountId, mc.configId, plan.coin, needed);

    const fee = this.cfg.firm.feePct / 100;
    const fills: ExecutionResult["fills"] = [];
    const notes: string[] = [];
    let working = 0;
    for (const [i, req] of reqs.entries()) {
      const tag = `rung ${i + 1}`;
      let rows: Row[];
      try {
        rows = await this.client.createOrders(this.accountId, req);
      } catch (e) {
        notes.push(`${tag} not sent (${errText(e)})`);
        if (i === 0) return this.failed(notes, fills, reqs);
        continue;
      }
      const byIntent = new Map(rows.map((r) => [String(r.intentId), r]));
      const [entry, stop, tp] = req.orders.map((o) => byIntent.get(o.intentId));
      const st = (r: Row | undefined) => (r?.status == null ? null : String(r.status));
      if (!st(entry) || BAD.includes(st(entry)!)) {
        notes.push(`${tag} entry ${st(entry) ?? "not answered"}`);
        if (i === 0) return this.failed(notes, fills, reqs);
        continue;
      }
      if (!st(stop) || BAD.includes(st(stop)!)) {
        if (req.orders[0]!.type === "market") {
          // A filled rung is never left without its stop: close it at market straight away.
          const closed = await this.closeAtMarket(plan.coin, plan.side, req.orders[0]!.quantity, `${req.orderGroupId}:rescue`);
          notes.push(closed ? `${tag} stop was refused, the position was closed at market` : `${tag} stop was refused and the emergency close failed: CLOSE ${plan.coin} BY HAND`);
          return this.failed(notes, fills, reqs);
        }
        // A resting rung whose stop was refused is pulled before it can fill.
        const id = entry?.orderId != null ? String(entry.orderId) : null;
        const cancelled = id ? await this.client.cancelOrder(this.accountId, id).catch(() => false) : false;
        notes.push(`${tag} stop refused, ${cancelled ? "its entry was cancelled" : `its entry could not be cancelled: CANCEL THE ${plan.coin} LIMIT AT ${plan.rungs[i]!.px} BY HAND`}`);
        continue;
      }
      if (plan.target != null && (!st(tp) || BAD.includes(st(tp)!))) notes.push(`${tag} take-profit refused; its stop is in place`);
      working++;
      if (req.orders[0]!.type === "market") {
        const qty = num(entry!.cumulativeQuantity) ?? num(entry!.quantity) ?? plan.rungs[i]!.qty;
        const px = num(entry!.averagePrice) ?? num(entry!.avgPrice) ?? plan.rungs[i]!.px;
        fills.push({ side: plan.side === "long" ? "buy" : "sell", size: qty, px, fee: Math.round(qty * px * fee * 100) / 100, pnl: 0 });
      }
    }
    if (!working) return this.failed(notes, fills, reqs);
    const resting = working - fills.length;
    notes.unshift(`${working} of ${reqs.length} rungs working (${shape})${resting ? `, ${resting} resting as limits until filled or ${this.cfg.ladder.ttlHours}h old` : ""}`);
    return { ok: true, venue: this.venue, fills, requests: reqs, note: notes.join("; ") };
  }

  private failed(notes: string[], fills: ExecutionResult["fills"], requests: unknown[]): ProprExecutionResult {
    return { ok: false, venue: this.venue, fills, requests, error: `Propr: ${notes.join("; ")}` };
  }

  private closeRequest(coin: string, side: "long" | "short", quantity: string, seed: string, whole: boolean): ProprOrderRequest {
    return {
      accountId: this.accountId,
      intentId: ulid(Date.now(), seed),
      exchange: "hyperliquid",
      type: "market",
      side: side === "long" ? "sell" : "buy",
      positionSide: side,
      productType: "perp",
      timeInForce: "IOC",
      asset: coin,
      base: coin,
      quote: "USDC",
      quantity,
      reduceOnly: true,
      closePosition: whole,
    };
  }

  private async closeAtMarket(coin: string, side: "long" | "short", quantity: string, seed: string): Promise<boolean> {
    try {
      const rows = await this.client.createOrders(this.accountId, { orders: [this.closeRequest(coin, side, quantity, seed, true)] });
      return rows.some((r) => !BAD.includes(String(r.status)));
    } catch {
      return false;
    }
  }

  async exit(coin: string, size: number, markPx: number, reason: string, proposalId: string | null, now: Date): Promise<ProprExecutionResult> {
    let s: ProprSnapshot;
    try {
      s = await this.snapshot(now);
    } catch (e) {
      return { ok: false, venue: this.venue, fills: [], error: `Propr: ${errText(e)}` };
    }
    const pos = s.positions.find((p) => p.coin === coin);
    if (!pos) return { ok: false, venue: this.venue, fills: [], error: `Propr: no open ${coin} position` };
    const qty = Math.min(size, pos.qty);
    const whole = qty >= pos.qty * 0.999;
    const req = this.closeRequest(coin, pos.side, String(whole ? pos.qty : qty), `${proposalId ?? reason}:${coin}:${now.getTime()}:close`, whole);
    if (!this.live) return { ok: false, venue: this.venue, fills: [], requests: [req], error: `Propr dry run: close of ${req.quantity} ${coin} built, not sent` };
    let rows: Row[];
    try {
      rows = await this.client.createOrders(this.accountId, { orders: [req] });
    } catch (e) {
      return { ok: false, venue: this.venue, fills: [], requests: [req], error: `Propr: ${errText(e)}` };
    }
    const r = rows.find((x) => String(x.intentId) === req.intentId) ?? rows[0];
    if (!r || BAD.includes(String(r.status))) return { ok: false, venue: this.venue, fills: [], requests: [req], error: `Propr: close ${r?.status ?? "not answered"}` };
    const px = num(r.averagePrice) ?? num(r.avgPrice) ?? markPx;
    const filled = num(r.cumulativeQuantity) ?? qty;
    const pnl = (pos.side === "long" ? px - pos.entry : pos.entry - px) * filled;
    const fee = filled * px * (this.cfg.firm.feePct / 100);
    const notes = whole ? await this.cancelLeftovers(s.orders, coin) : [];
    return {
      ok: true,
      venue: this.venue,
      fills: [{ side: pos.side === "long" ? "sell" : "buy", size: filled, px, fee: Math.round(fee * 100) / 100, pnl: Math.round((pnl - fee) * 100) / 100 }],
      requests: [req],
      note: notes.length ? notes.join("; ") : undefined,
    };
  }

  /** After a full close, the desk's own resting orders on that coin (unfilled rungs, their stops and targets) go too. */
  private async cancelLeftovers(orders: Row[], coin: string): Promise<string[]> {
    const mine = orders.filter((o) => isLadderId(o.intentId) && isOpen(o) && String(o.base ?? o.asset) === coin);
    let n = 0;
    const out: string[] = [];
    for (const o of mine) {
      try {
        if (await this.client.cancelOrder(this.accountId, String(o.orderId))) n++;
      } catch (e) {
        out.push(`could not cancel a ${coin} ${String(o.type)} order (${errText(e)})`);
      }
    }
    if (n) out.unshift(`${n} resting ${coin} order${n === 1 ? "" : "s"} cancelled`);
    return out;
  }

  /**
   * Ladder housekeeping on each watch tick. Unfilled rungs of the desk's ladders are cancelled when the trade is over
   * (a rung filled and the position is gone) or the ladder is older than its TTL; once the position is gone its leftover
   * stops and targets go too. Orders the desk did not place are never touched. A dry run only says what it would do.
   */
  async housekeep(now: Date): Promise<string[]> {
    let s: ProprSnapshot;
    try {
      s = await this.snapshot(now);
    } catch (e) {
      return [`Propr account unreadable: ${errText(e)}`];
    }
    const plan = sweepPlan(s.orders, s.positions, now.getTime(), this.cfg.ladder.ttlHours);
    if (!this.live) return plan.map((x) => `dry run: would cancel ${x.victims.length} ${x.coin} order${x.victims.length === 1 ? "" : "s"} (${x.why})`);
    const out: string[] = [];
    for (const x of plan) {
      let n = 0;
      for (const o of x.victims) {
        try {
          if (await this.client.cancelOrder(this.accountId, String(o.orderId))) n++;
        } catch (e) {
          out.push(`could not cancel a ${x.coin} ${String(o.type)} order (${errText(e)})`);
        }
      }
      out.push(`${x.coin}: ${n} resting order${n === 1 ? "" : "s"} cancelled, ${x.why}`);
    }
    return out;
  }
}

/** Which of the desk's ladder orders housekeeping cancels, and why. Pure. */
export function sweepPlan(orders: Row[], positions: ProprPosition[], now: number, ttlHours: number): Array<{ coin: string; victims: Row[]; why: string }> {
  const ladders = new Map<string, Row[]>();
  for (const o of orders) {
    if (!isLadderId(o.intentId)) continue;
    const key = `${String(o.intentId).slice(0, 10)}:${String(o.base ?? o.asset)}`;
    ladders.set(key, [...(ladders.get(key) ?? []), o]);
  }
  const out: Array<{ coin: string; victims: Row[]; why: string }> = [];
  for (const [key, list] of ladders) {
    const coin = key.split(":")[1]!;
    const side = list[0]?.positionSide;
    const hasPos = positions.some((p) => p.coin === coin && p.side === side);
    const anyFilled = list.some((o) => isEntry(o) && (o.status === "filled" || (num(o.cumulativeQuantity) ?? 0) > 0));
    const ageH = (now - ulidTime(key.slice(0, 10))) / 3_600_000;
    const done = anyFilled && !hasPos;
    if (!done && ageH < ttlHours) continue;
    const victims = list.filter((o) => isOpen(o) && (isEntry(o) || !hasPos));
    if (victims.length) out.push({ coin, victims, why: done ? "the trade is closed" : `the ladder is ${ageH.toFixed(1)}h old` });
  }
  return out;
}

