import type { ProprVenueConfig } from "../config.js";
import type { MarketRef } from "../governor.js";
import type { Broker, ExecutionResult, UpkeepNote } from "../paper.js";
import type { AccountState, Confidence, RiskOrder, Sizing } from "../types.js";
import { coinOf, filledQty, fillPx, isEntry, isOpen, readSnapshot, sameCoin, toAccountState, type ProprPosition, type ProprSnapshot } from "./account.js";
import { ProprClient, scrub, type ProprOrderRequest, type Row } from "./client.js";
import { isLadderId, ulid, ulidTime } from "./ids.js";
import { firmReasons, ladderRequests, planLadder, tradeLeverage, type LadderPlan, type LadderRequest } from "./ladder.js";

// The Propr venue: a challenge or funded account on Hyperliquid mainnet, reached only through Propr's API. Entries go
// out as a ladder of rungs from the mark toward the stop, each rung with its own reduce-only stop (and take-profit),
// behind the governor and then Propr's firm rules, at the cross leverage the trade picked (1x to the coin's maximum).
// Nothing is sent unless PROPR_LIVE=true: a dry run builds the exact requests and returns them with dryRun set, so the
// desk records the proposal as not filled.

export interface ProprBrokerOptions {
  config: ProprVenueConfig;
  /** Hyperliquid mainnet market (mark, size decimals) for a coin: Propr routes there, so the desk's own data applies. */
  market: (coin: string) => Promise<MarketRef | null>;
  fetchFn?: typeof fetch;
  /**
   * Where housekeeping keeps what it must remember between ticks (the desk store's state, so a fresh process per tick
   * still has it). Absent: this process's memory.
   */
  state?: { get(): Promise<ProprUpkeepState | null>; set(v: ProprUpkeepState): Promise<void> };
}

/** Desk-state key of the Propr housekeeping memory. */
export const PROPR_UPKEEP_KEY = "propr_upkeep";
export interface ProprUpkeepState {
  /** Ladder → when it was first seen with no position and nothing left to fill (epoch ms): sweepPlan's wait. */
  flat?: Record<string, number>;
  /** What the last fully readable account held: an unreadable account is critical while this is not empty. */
  exposure?: { positions: number; rungs: number };
}

export type ProprExecutionResult = ExecutionResult;

const BAD = ["rejected", "cancelled", "canceled", "expired"];
const num = (x: unknown): number | null => {
  const v = typeof x === "string" && x.trim() !== "" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(v) ? v : null;
};
const errText = (e: unknown) => scrub(e instanceof Error ? e.message : String(e));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/**
 * How long a ladder must show no position and nothing left to fill, across housekeeping runs, before its stops and
 * targets are cancelled. A fill can show on the order before its position row does (the two are read in parallel), and
 * a rung can fill while its cancel is on the way; without the wait one read would cancel the stops of an open position.
 * Entry rungs never wait: cancelling one adds no risk.
 */
export const FLAT_GRACE_MS = 2 * 60_000;

export class ProprBroker implements Broker {
  readonly venue = "propr";
  readonly live: boolean;
  /** A Propr account is real money: entries, and the agents' exits, always wait for the operator. */
  readonly manualOnly = true;
  readonly accountId: string;
  private readonly client: ProprClient;
  /** Everything but the key, which only the client holds. */
  private readonly cfg: Omit<ProprVenueConfig, "apiKey">;
  readonly #market: ProprBrokerOptions["market"];
  readonly #state: ProprBrokerOptions["state"];
  /** The housekeeping memory when no store was given. */
  private memory: ProprUpkeepState = {};

  constructor(o: ProprBrokerOptions) {
    const { apiKey, ...cfg } = o.config;
    this.cfg = cfg;
    this.live = cfg.live;
    this.accountId = cfg.accountId;
    this.#market = o.market;
    this.#state = o.state;
    this.client = new ProprClient(apiKey, cfg.baseUrl, o.fetchFn ?? fetch);
  }

  market(coin: string): Promise<MarketRef | null> {
    return this.#market(coin);
  }

  tradeLeverage(coin: string, chosen: number | undefined, confidence?: Confidence) {
    return tradeLeverage(this.cfg, coin, chosen, confidence);
  }

  /** Strict by default (entries are planned on it); `tolerant` returns what could be read and lists the rest (see readSnapshot). */
  snapshot(now: Date, opts: { tolerant?: boolean } = {}): Promise<ProprSnapshot> {
    return readSnapshot(this.client, this.accountId, this.cfg.startingBalance, now.getTime(), opts);
  }

  /** A failed state read is an empty memory: no stop is cancelled on it, entries still are. */
  private async upkeepState(): Promise<ProprUpkeepState> {
    if (!this.#state) return this.memory;
    return (await this.#state.get().catch(() => null)) ?? {};
  }

  private async saveUpkeepState(was: ProprUpkeepState, next: ProprUpkeepState): Promise<void> {
    if (JSON.stringify(was) === JSON.stringify(next)) return;
    if (!this.#state) this.memory = next;
    else await this.#state.set(next).catch((e) => console.error("[desk] propr upkeep state not saved:", errText(e)));
  }

  /**
   * The desk's view of the account. When some rows could not be read, the positions that could are still listed (so
   * an exit of one is allowed) and the account is marked unavailable, which blocks every new entry.
   */
  async account(marks: Map<string, number>, now: Date): Promise<AccountState> {
    try {
      const s = await this.snapshot(now, { tolerant: true });
      const state = toAccountState(s, marks, this.venue, this.live ? undefined : "dry run: orders are built, not sent (PROPR_LIVE is not true)");
      const bad = [...s.unreadable.live, ...s.unreadable.other];
      return bad.length ? { ...state, available: false, note: `Propr account partly unreadable (${plural(bad.length, "row")}; ${bad[0]}): no new entries, exits still work` } : state;
    } catch (e) {
      return { venue: this.venue, equityUsd: 0, dayPnlUsd: 0, positions: [], available: false, note: `Propr account unreadable: ${errText(e)}` };
    }
  }

  /**
   * The ladder the desk would send for a governor-approved order, the cross leverage it runs at, the desk's leftover
   * stops and targets on the coin to clear first, and the firm's reasons to refuse it.
   */
  async plan(p: RiskOrder, sizing: Sizing, now: Date): Promise<{ plan?: LadderPlan; snapshot?: ProprSnapshot; leverage?: number; leftovers?: Row[]; reasons: string[] }> {
    const m = await this.#market(p.coin);
    if (!m) return { reasons: [`${p.coin} is not listed on Hyperliquid`] };
    const { plan, reasons } = planLadder(p, sizing, m.szDecimals, this.cfg.ladder);
    if (!plan) return { reasons };
    const snapshot = await this.snapshot(now);
    const out = firmReasons(snapshot, plan, this.cfg.firm);
    // The whole ladder's notional must fit the trade's leverage (the governor caps it there, so this holds unless
    // equity fell since); without a choice, the smallest whole leverage that carries it.
    // An agent's proposal carries its confidence, which can pick the leverage (PROPR_LEVERAGE_BY_CONFIDENCE).
    const lev = tradeLeverage(this.cfg, plan.coin, p.leverage, p.confidence);
    const needed = Math.max(1, Math.ceil(plan.notionalUsd / Math.max(1e-9, snapshot.equity)));
    const leverage = lev.leverage ?? needed;
    if (leverage > lev.max) out.push(`the ladder needs ${needed}x on ${plan.coin}, Propr allows ${lev.max}x`);
    else if (needed > leverage) out.push(`the ladder's ${plan.notionalUsd} USD needs ${needed}x, the trade runs at ${leverage}x`);
    // A position on the coin is the governor's refusal too. With none, the desk's old stops and targets there protect
    // nothing and would read as the new position's stop, so they are cancelled before the new ladder goes out.
    const hasPos = snapshot.positions.some((x) => sameCoin(x.coin, plan.coin));
    if (hasPos) out.push(`a ${plan.coin} position is already open`);
    const leftovers = hasPos ? [] : snapshot.orders.filter((o) => isLadderId(o.intentId) && isOpen(o) && !isEntry(o) && sameCoin(coinOf(o), plan.coin));
    return { plan, snapshot, leverage, leftovers, reasons: out };
  }

  async open(p: RiskOrder, sizing: Sizing, proposalId: string, now: Date): Promise<ProprExecutionResult> {
    let planned: Awaited<ReturnType<ProprBroker["plan"]>>;
    try {
      planned = await this.plan(p, sizing, now);
    } catch (e) {
      return { ok: false, venue: this.venue, fills: [], error: `Propr: ${errText(e)}` };
    }
    const { plan, snapshot, leverage, leftovers = [] } = planned;
    if (!plan || !snapshot || leverage == null || planned.reasons.length) {
      return { ok: false, venue: this.venue, fills: [], error: `Propr firm rules: ${planned.reasons.join("; ")}` };
    }
    const reqs = ladderRequests(plan, this.accountId, proposalId, now.getTime());
    const margin = { margin: { asset: plan.coin, marginMode: "cross", leverage } };
    const requests = [margin, ...reqs];
    const shape = `${plural(plan.rungs.length, "rung")} ${plan.rungs.map((r) => r.px).join(" / ")}, ${plan.qty} ${plan.coin} total at ${leverage}x cross, risk $${plan.riskUsd}`;
    if (!this.live) {
      const clear = leftovers.length ? `, after cancelling ${plural(leftovers.length, `leftover ${plan.coin} order`)}` : "";
      return { ok: false, dryRun: true, venue: this.venue, fills: [], requests, error: `Propr dry run: ${plural(reqs.length, "rung request")} built, none sent (${shape}${clear})` };
    }
    try {
      return await this.placeLive(plan, leverage, leftovers, reqs, requests, shape);
    } catch (e) {
      return { ok: false, venue: this.venue, fills: [], requests, error: `Propr: ${errText(e)}` };
    }
  }

  private async placeLive(plan: LadderPlan, leverage: number, leftovers: Row[], reqs: LadderRequest[], requests: unknown[], shape: string): Promise<ProprExecutionResult> {
    for (const o of leftovers) {
      if (await this.client.cancelOrder(this.accountId, String(o.orderId)).catch(() => false)) continue;
      // Already gone is fine; one still open would sit beside the new stops, so nothing is sent.
      const still = (await this.client.orders(this.accountId)).some((x) => x.orderId === o.orderId && isOpen(x));
      if (still) return this.failed([`a leftover ${plan.coin} ${String(o.type)} order could not be cancelled, nothing sent`], [], requests);
    }
    // Cross margin at the trade's leverage.
    const mc = await this.client.marginConfig(this.accountId, plan.coin);
    if (num(mc.leverage) !== leverage || mc.marginMode !== "cross") await this.client.setLeverage(this.accountId, mc.configId, plan.coin, leverage);

    const fee = this.cfg.firm.feePct / 100;
    const fills: ExecutionResult["fills"] = [];
    const notes: string[] = [];
    let working = 0;
    const summary = () => `${working} of ${reqs.length} rungs working (${shape})`;
    for (const [i, req] of reqs.entries()) {
      const tag = `rung ${i + 1}`;
      const entryReq = req.orders[0]!;
      let rows: Row[];
      try {
        rows = await this.client.createOrders(this.accountId, req);
      } catch (e) {
        notes.push(`${tag} not sent (${errText(e)}), no further rungs sent`);
        break;
      }
      const byIntent = new Map(rows.map((r) => [String(r.intentId), r]));
      const [entry, stop, tp] = req.orders.map((o) => byIntent.get(o.intentId));
      const st = (r: Row | undefined) => (r?.status == null ? null : String(r.status));
      if (!st(entry) || BAD.includes(st(entry)!)) {
        notes.push(`${tag} entry ${st(entry) ?? "not answered"}`);
        continue;
      }
      if (!st(stop) || BAD.includes(st(stop)!)) {
        // A rung is never left to fill without its stop. A resting one is cancelled; when that fails it may have filled,
        // so its quantity is closed at market (reduce-only: with nothing to close, nothing happens). A market rung is
        // closed straight away. No further rung is sent: a refused stop is rarely a one-off.
        const id = entry?.orderId != null ? String(entry.orderId) : null;
        const cancelled = entryReq.type !== "market" && id ? await this.client.cancelOrder(this.accountId, id).catch(() => false) : false;
        if (cancelled) notes.push(`${tag} stop was refused, its entry was cancelled, no further rungs sent`);
        else {
          const closed = await this.closeAtMarket(plan.coin, plan.side, entryReq.quantity, `${req.orderGroupId}:rescue`);
          notes.push(closed ? `${tag} stop was refused, its quantity was closed at market, no further rungs sent` : `${tag} stop was refused and the emergency close failed: CLOSE ${plan.coin} BY HAND`);
        }
        break;
      }
      if (plan.target != null && (!st(tp) || BAD.includes(st(tp)!))) notes.push(`${tag} take-profit refused; its stop is in place`);
      working++;
      if (entryReq.type === "market") {
        const qty = filledQty(entry);
        if (qty > 0) {
          const px = fillPx(entry) ?? plan.rungs[i]!.px;
          fills.push({ side: plan.side === "long" ? "buy" : "sell", size: qty, px, fee: Math.round(qty * px * fee * 100) / 100, pnl: 0 });
        } else notes.push(`${tag} market entry accepted, its fill is not reported yet`);
      }
    }
    if (!working) return this.failed(notes, fills, requests);
    const resting = reqs.slice(0, working).filter((r) => r.orders[0]!.type !== "market").length;
    notes.unshift(`${summary()}${resting ? `, ${resting} resting as limits until filled or ${this.cfg.ladder.ttlHours}h old` : ""}`);
    return { ok: true, venue: this.venue, fills, requests, note: notes.join("; ") };
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
      const rows = await this.client.createOrders(this.accountId, { orders: [this.closeRequest(coin, side, quantity, seed, false)] });
      return rows.some((r) => !BAD.includes(String(r.status)));
    } catch {
      return false;
    }
  }

  async exit(coin: string, size: number, markPx: number, reason: string, proposalId: string | null, now: Date): Promise<ProprExecutionResult> {
    // Tolerant: an unreadable row elsewhere on the account must not keep the operator in a position that was read.
    let s: ProprSnapshot;
    try {
      s = await this.snapshot(now, { tolerant: true });
    } catch (e) {
      return { ok: false, venue: this.venue, fills: [], error: `Propr: ${errText(e)}` };
    }
    const pos = s.positions.find((p) => sameCoin(p.coin, coin));
    if (!pos) return { ok: false, venue: this.venue, fills: [], error: `Propr: no open ${coin} position` };
    const qty = Math.min(size, pos.qty);
    const whole = qty >= pos.qty * 0.999;
    const req = this.closeRequest(coin, pos.side, String(whole ? pos.qty : qty), `${proposalId ?? reason}:${coin}:${now.getTime()}:close`, whole);
    if (!this.live) return { ok: false, dryRun: true, venue: this.venue, fills: [], requests: [req], error: `Propr dry run: close of ${req.quantity} ${coin} built, not sent` };
    let rows: Row[];
    try {
      rows = await this.client.createOrders(this.accountId, { orders: [req] });
    } catch (e) {
      return { ok: false, venue: this.venue, fills: [], requests: [req], error: `Propr: ${errText(e)}` };
    }
    const r = rows.find((x) => String(x.intentId) === req.intentId) ?? rows[0];
    if (!r || BAD.includes(String(r.status))) return { ok: false, venue: this.venue, fills: [], requests: [req], error: `Propr: close ${r?.status ?? "not answered"}` };
    const filled = filledQty(r);
    // A whole close ends the trade, so the desk's unfilled entry rungs on the coin go now, whether or not the fill is
    // reported: left resting they would reopen it. The stops and targets go here only when the close is confirmed and no
    // rung was resting (one may have filled while its cancel was on the way); otherwise housekeeping clears them once
    // the position has stayed gone.
    const mine = whole ? s.orders.filter((o) => isLadderId(o.intentId) && isOpen(o) && sameCoin(coinOf(o), coin)) : [];
    const rungs = mine.filter(isEntry);
    const notes = await this.cancelAll(rungs, coin);
    const settled = whole && filled >= pos.qty * 0.999 && !rungs.length && !s.unreadable.live.length;
    if (settled) notes.push(...(await this.cancelAll(mine.filter((o) => !isEntry(o)), coin)));
    if (!(filled > 0)) {
      const note = [`close of ${req.quantity} ${coin} accepted (${String(r.status)}), its fill is not reported yet`, ...notes, "the stops stay until housekeeping sees the position gone"].join("; ");
      return { ok: true, venue: this.venue, fills: [], requests: [req], note };
    }
    const px = fillPx(r) ?? markPx;
    const pnl = (pos.side === "long" ? px - pos.entry : pos.entry - px) * filled;
    const fee = filled * px * (this.cfg.firm.feePct / 100);
    return {
      ok: true,
      venue: this.venue,
      fills: [{ side: pos.side === "long" ? "sell" : "buy", size: filled, px, fee: Math.round(fee * 100) / 100, pnl: Math.round((pnl - fee) * 100) / 100 }],
      requests: [req],
      note: notes.length ? notes.join("; ") : undefined,
    };
  }

  /** Cancels the given resting orders of the desk on a coin; says how many went and which could not be. */
  private async cancelAll(orders: Row[], coin: string): Promise<string[]> {
    let n = 0;
    const out: string[] = [];
    for (const o of orders) {
      try {
        if (await this.client.cancelOrder(this.accountId, String(o.orderId))) n++;
      } catch (e) {
        out.push(`could not cancel a ${coin} ${String(o.type)} order (${errText(e)})`);
      }
    }
    if (n) out.unshift(`${plural(n, `resting ${coin} order`)} cancelled`);
    return out;
  }

  async holds(coin: string, side: "long" | "short", now: Date): Promise<boolean | null> {
    let s: ProprSnapshot;
    try {
      s = await this.snapshot(now);
    } catch {
      return null;
    }
    if (s.positions.some((p) => sameCoin(p.coin, coin) && p.side === side)) return true;
    const entrySide = side === "long" ? "buy" : "sell";
    const sideOf = (o: Row) => (o.positionSide === "long" || o.positionSide === "short" ? o.positionSide === side : o.side === entrySide);
    return s.orders.some((o) => isLadderId(o.intentId) && isEntry(o) && isOpen(o) && sameCoin(coinOf(o), coin) && sideOf(o));
  }

  /**
   * Upkeep on each watch tick. Flags any position on the account without a full stop (critical), rows that could not
   * be read, and perp-radar's orders on the account. Live, it cancels the desk's own ladder orders (tag PRD): unfilled
   * entry rungs as soon as the trade is over (a rung filled and no position is left), the ladder is older than its TTL,
   * or the kill switch is on; the leftover stops and targets only on a later tick, once the ladder has shown no position
   * and no resting rung for FLAT_GRACE_MS (see sweepPlan), and never while a row is unreadable. Orders the desk did not
   * place, perp-radar's included, are never cancelled. A dry run sends nothing: with the kill switch on it reports the
   * entry rungs it would cancel. Each note carries a key, so the watch alerts a condition once.
   */
  async housekeep(now: Date, ctx: { killSwitch?: boolean } = {}): Promise<UpkeepNote[]> {
    const was = await this.upkeepState();
    const held = was.exposure && (was.exposure.positions > 0 || was.exposure.rungs > 0) ? was.exposure : null;
    const lastGood = held ? `the last good read had ${plural(held.positions, "open position")} and ${plural(held.rungs, "resting entry rung")}: check them on Propr by hand` : null;
    let s: ProprSnapshot;
    try {
      s = await this.snapshot(now, { tolerant: true });
    } catch (e) {
      const kill = ctx.killSwitch ? "; with the kill switch on, the desk's resting entry rungs could not be checked" : "";
      return [{ level: held ? "critical" : "warn", key: "unreadable", text: `Propr account unreadable: ${errText(e)}${lastGood ? `; ${lastGood}` : ""}${kill}` }];
    }
    const notes: UpkeepNote[] = s.positions
      .filter((p) => p.stop == null)
      .map((p) => ({ level: "critical" as const, key: `unprotected:${p.coin}:${p.side}`, text: `${p.coin} ${p.side} ${p.qty} has no full stop on Propr: set one by hand; the desk takes no new trades until it does` }));
    const bad = [...s.unreadable.live, ...s.unreadable.other];
    const exposure = { positions: s.positions.length, rungs: s.orders.filter((o) => isLadderId(o.intentId) && isEntry(o) && isOpen(o)).length };
    if (bad.length) {
      // An order or position that may be live and cannot be read is critical by itself; an unreadable trade row is while anything is held.
      const critical = s.unreadable.live.length > 0 || exposure.positions > 0 || exposure.rungs > 0 || !!held;
      notes.unshift({ level: critical ? "critical" : "warn", key: "unreadable", text: `Propr account partly unreadable: ${plural(bad.length, "row")} skipped (${bad[0]}). No new entries until it reads; exits, the kill switch and rung cancels act on the rows that were read, and no stop is cancelled meanwhile` });
    }
    if (s.perpRadarOrders) notes.push({ level: "warn", key: "perp-radar", text: `perp-radar's executor has ${plural(s.perpRadarOrders, "open order")} on this account: the desk takes no new trades here (one executor per account)` });
    const flat = new Map(Object.entries(was.flat ?? {}));
    const swept = await this.sweep(s, now, { kill: !!ctx.killSwitch, flat, entriesOnly: bad.length > 0 });
    await this.saveUpkeepState(was, { flat: Object.fromEntries(flat), exposure: bad.length ? was.exposure : exposure });
    return [...notes, ...swept];
  }

  /**
   * The kill switch's own action: the desk's unfilled entry rungs are cancelled now (housekeeping repeats it on every
   * tick while the switch is on, so a cancel that failed is retried). Stops and take-profits are not touched here. A
   * row that cannot be read does not stop it: the rungs that were read are cancelled and the rest is said.
   */
  async cancelEntries(now: Date): Promise<UpkeepNote[]> {
    let s: ProprSnapshot;
    try {
      s = await this.snapshot(now, { tolerant: true });
    } catch (e) {
      return [{ level: "warn", key: "unreadable", text: `Propr account unreadable, the desk's resting entry rungs could not be checked: ${errText(e)}` }];
    }
    const bad = s.unreadable.live;
    const notes: UpkeepNote[] = bad.length ? [{ level: "critical", key: "unreadable", text: `${plural(bad.length, "order or position row")} on Propr could not be read (${bad[0]}): a resting entry among them is not cancelled, check Propr by hand` }] : [];
    return [...notes, ...(await this.sweep(s, now, { kill: true, entriesOnly: true }))];
  }

  private async sweep(s: ProprSnapshot, now: Date, opts: { kill: boolean; flat?: Map<string, number>; entriesOnly?: boolean }): Promise<UpkeepNote[]> {
    const notes: UpkeepNote[] = [];
    const plan = sweepPlan(s.orders, s.positions, now.getTime(), this.cfg.ladder.ttlHours, opts);
    if (!this.live) {
      // A dry run placed nothing, so only rungs from an earlier live run can rest here: under the kill switch they are named.
      if (!opts.kill) return notes;
      for (const x of plan) {
        const n = x.victims.filter(isEntry).length;
        if (n) notes.push({ level: "warn", key: `kill-dry:${x.ladder}`, text: `${x.coin}: ${plural(n, "resting entry rung")} would be cancelled (${x.why}), but this is a dry run (PROPR_LIVE is not true) and nothing was sent: cancel ${n === 1 ? "it" : "them"} on Propr by hand` });
      }
      return notes;
    }
    for (const x of plan) {
      let n = 0;
      const failed: string[] = [];
      for (const o of x.victims) {
        try {
          if (await this.client.cancelOrder(this.accountId, String(o.orderId))) n++;
        } catch (e) {
          failed.push(`could not cancel a ${x.coin} ${String(o.type)} order (${errText(e)})`);
        }
      }
      if (n) notes.push({ level: "info", key: `swept:${x.ladder}:${n}`, text: `${x.coin}: ${plural(n, "resting order")} cancelled, ${x.why}` });
      if (failed.length) notes.push({ level: "warn", key: `sweep-failed:${x.ladder}`, text: `${failed.join("; ")}; it is tried again on the next tick` });
    }
    return notes;
  }
}

/**
 * Which of the desk's ladder orders housekeeping cancels in this pass, and why. A pass takes a ladder's entry rungs or
 * its stops and targets, never both:
 *
 * - Unfilled entry rungs go at once when the trade is closed (a rung filled and no position is left), the ladder is
 *   past its TTL, or `kill` is set. Left resting after a close they would fill later and reopen a finished trade.
 * - Stops and take-profits go only on a later pass: no position, no entry rung still resting, and that has held for
 *   FLAT_GRACE_MS. So a rung that filled (wholly or in part) while its cancel was on the way, or whose position row
 *   lags its fill, is seen by the next read before its stop can go.
 *
 * The wait is counted in `flat` (ladder → first seen with no position and nothing left to fill), which the caller
 * keeps between runs and this updates; without it, or with `entriesOnly`, no stop is ever cancelled.
 */
export function sweepPlan(
  orders: Row[],
  positions: ProprPosition[],
  now: number,
  ttlHours: number,
  opts: { kill?: boolean; flat?: Map<string, number>; entriesOnly?: boolean } = {},
): Array<{ ladder: string; coin: string; victims: Row[]; why: string }> {
  const ladders = new Map<string, Row[]>();
  for (const o of orders) {
    if (!isLadderId(o.intentId)) continue;
    const key = `${String(o.intentId).slice(0, 10)}:${coinOf(o).toUpperCase()}`;
    ladders.set(key, [...(ladders.get(key) ?? []), o]);
  }
  for (const key of [...(opts.flat?.keys() ?? [])]) if (!ladders.has(key)) opts.flat!.delete(key);
  const out: Array<{ ladder: string; coin: string; victims: Row[]; why: string }> = [];
  for (const [key, list] of ladders) {
    const coin = coinOf(list[0]!);
    // The ladder's side from any row's positionSide, else its entry's side (buy is long), as in holds(). Unknown: sweep
    // nothing, since without it an open position's stop and take-profit would read as leftovers.
    const tagged = list.find((o) => o.positionSide === "long" || o.positionSide === "short")?.positionSide;
    const entrySide = list.find(isEntry)?.side;
    const side = tagged ?? (entrySide === "buy" ? "long" : entrySide === "sell" ? "short" : null);
    if (!side) continue;
    const hasPos = positions.some((p) => sameCoin(p.coin, coin) && p.side === side);
    const anyFilled = list.some((o) => isEntry(o) && (o.status === "filled" || filledQty(o) > 0));
    const resting = list.filter((o) => isEntry(o) && isOpen(o));
    const closed = anyFilled && !hasPos;
    if (!hasPos && (anyFilled || !resting.length)) {
      if (!opts.flat?.has(key)) opts.flat?.set(key, now);
    } else opts.flat?.delete(key);
    if (resting.length) {
      const ageH = (now - ulidTime(key.slice(0, 10))) / 3_600_000;
      const stale = ageH >= ttlHours;
      if (closed || stale || opts.kill) out.push({ ladder: key, coin, victims: resting, why: closed ? "the trade is closed" : stale ? `the ladder is ${ageH.toFixed(1)}h old` : "the kill switch is on" });
      continue;
    }
    const since = opts.flat?.get(key);
    if (opts.entriesOnly || hasPos || since == null || now - since < FLAT_GRACE_MS) continue;
    const victims = list.filter(isOpen);
    if (victims.length) out.push({ ladder: key, coin, victims, why: anyFilled ? "the trade is closed" : "none of its rungs filled and none is resting" });
  }
  return out;
}
