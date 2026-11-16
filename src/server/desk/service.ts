import { createHash } from "node:crypto";
import type { ActiveLocks, DeskCooldownResponse, DeskPlanInput, DeskPlanSubmitResponse, PlanCheck, PlanPlacement, StopOutRef } from "../../shared/deskPlan.js";
import { fmtPx } from "../../shared/format.js";
import type { AssetCtx } from "../../shared/types.js";
import type { DeskConfig } from "./config.js";
import { activeLocks, COOLDOWN_KEY, parseCooldownState, recordStopOut } from "./cooldown.js";
import type { MarketData } from "./data.js";
import { evaluateExit, evaluateOpen, evaluateRisk, floorToDecimals, notionalCap, operatorRiskOrder, type GovernorContext, type MarketRef } from "./governor.js";
import type { Alert, AlertAction, Notifier } from "./notify.js";
import { HlBroker } from "./hl/broker.js";
import { PaperBroker, type Broker, type ExecutionResult } from "./paper.js";
import { checkPlan, type PlanContext } from "./plan.js";
import { ProprBroker } from "./propr/broker.js";
import type { DeskStore } from "./store.js";
import {
  OperatorOrderSchema,
  type AccountState,
  type AlertLevel,
  type ExitProposal,
  type OperatorOrder,
  type OperatorOrderRecord,
  type PlanOrderRecord,
  type ProposalRecord,
  type RiskOrder,
  type Sizing,
  type TradeProposal,
  type Verdict,
} from "./types.js";

// The desk service: the single path from a proposal to the book.
//
//   agent → propose_trade/propose_exit → submit*() → governor → record
//     approval "auto"   → execute now (re-checked against the live mark)
//     approval "manual" → pending; alert with approve/reject; approve() re-runs
//                         the governor on fresh prices before executing
//
//   operator (copilot) → previewOperatorOrder() → governor verdict + previewHash
//                      → submitOperatorOrder(hash) → governor again on fresh
//                        marks → execute. The confirm is the operator's
//                        approval, so the approval mode does not apply.
//
// The kill switch blocks every new entry (exits stay allowed). Every
// decision, fill and failure raises a stored alert.

const KILL_KEY = "kill_switch";
const APPROVAL_KEY = "approval_override";
const REVIEW_HOURS_KEY = "review_hours_override";
export const OPERATOR_PREVIEW_KEY = "operator_preview";
/** A preview can be submitted for this long, while the mark stays within OPERATOR_MAX_MOVE of it. */
const OPERATOR_PREVIEW_TTL_MS = 60_000;
const OPERATOR_MAX_MOVE = 0.005;
/** A one-rung plan on a venue that only fills at the mark: the rung must be this close to it. */
const PLAN_MARK_TOLERANCE = 0.005;
const COPILOT_NO_TARGET = "no target: a copilot order needs a stop and a target (the desk places planned trades only)";
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface OperatorPreview {
  verdict: Verdict;
  previewHash: string;
  /** The venue mark the verdict was sized at (null when the coin is not listed). */
  markPx: number | null;
  venue: string;
  expiresAt: string;
}

/** The latest preview; only it can be submitted, once. */
interface StoredPreview {
  hash: string;
  markPx: number | null;
  at: string;
}

/** Binds an operator order to the mark it was previewed at (6 significant digits) and the second it was shown. */
function operatorPreviewHash(o: OperatorOrder, markPx: number | null, atMs: number): string {
  const order = [o.coin, o.side, o.stop, o.target ?? null, o.riskPct ?? null, o.entryLimit ?? null, o.leverage ?? null, o.notionalUsd ?? null, o.source];
  const mark = markPx == null ? null : Number(markPx.toPrecision(6));
  return createHash("sha256")
    .update(JSON.stringify([order, mark, Math.floor(atMs / 1000)]))
    .digest("hex");
}

function parseOperatorOrder(input: unknown): OperatorOrder {
  const r = OperatorOrderSchema.safeParse(input);
  if (!r.success) throw new DeskError(400, r.error.issues.map((i) => `${i.path.join(".") || "order"}: ${i.message}`).join("; "));
  return r.data;
}

export interface DeskDeps {
  config: DeskConfig;
  store: DeskStore;
  data: MarketData;
  notifier: Notifier;
  now?: () => Date;
  /** Overrides the venue the config selects (tests). */
  broker?: Broker;
  /**
   * The monitoring watchlist, resolved on every call (production: intel/positions.ts watchedAssets over
   * intel_watchlist, so WATCH-page edits apply on the next tick). Absent → config.watchlist, the same
   * env/default list the resolver returns for an empty table; only tests and services built without an
   * Intel store take that path.
   */
  watchlist?: () => Promise<string[]>;
}

export class DeskService {
  readonly config: DeskConfig;
  readonly store: DeskStore;
  readonly data: MarketData;
  readonly notifier: Notifier;
  readonly broker: Broker;
  private readonly clock: () => Date;
  private readonly watchlistSource: () => Promise<string[]>;
  /** Serializes operator submits in this process (the store's takeState guards across processes). */
  private operatorLock: Promise<unknown> = Promise.resolve();

  constructor(d: DeskDeps) {
    this.config = d.config;
    this.store = d.store;
    this.data = d.data;
    this.notifier = d.notifier;
    this.clock = d.now ?? (() => new Date());
    this.watchlistSource = d.watchlist ?? (async () => this.config.watchlist);
    this.broker =
      d.broker ??
      (d.config.venue === "hl-testnet" && d.config.hl
        ? new HlBroker({ ...d.config.hl, takerFee: d.config.limits.takerFee })
        : d.config.venue === "propr" && d.config.propr
          ? new ProprBroker({ config: d.config.propr, market: async (coin) => DeskService.findMarket(await d.data.ctxs(), coin) })
          : new PaperBroker(d.store, {
            startingEquity: d.config.paperStartingEquity,
            slippage: d.config.paperSlippage,
            takerFee: d.config.limits.takerFee,
          }));
  }

  now(): Date {
    return this.clock();
  }

  async killSwitch(): Promise<{ on: boolean; reason?: string; at?: string }> {
    return (await this.store.getState<{ on: boolean; reason?: string; at?: string }>(KILL_KEY)) ?? { on: false };
  }

  async setKillSwitch(on: boolean, reason: string, by: string): Promise<void> {
    await this.store.setState(KILL_KEY, { on, reason, at: this.now().toISOString(), by });
    await this.alert(on ? "critical" : "info", on ? "Kill switch ON" : "Kill switch off", `${reason} (by ${by})`);
  }

  /** Approval in force: manual on a venue that requires it (Propr), else an operator override from the UI, else the env default. */
  async approval(): Promise<"manual" | "auto"> {
    if (this.broker.manualOnly) return "manual";
    const o = await this.store.getState<{ approval: "manual" | "auto" }>(APPROVAL_KEY);
    return o?.approval ?? this.config.approval;
  }

  async setApproval(approval: "manual" | "auto", by: string): Promise<void> {
    if (approval === "auto" && this.broker.manualOnly) throw new DeskError(409, `approval stays manual on the ${this.broker.venue} venue`);
    await this.store.setState(APPROVAL_KEY, { approval, by, at: this.now().toISOString() });
  }

  /** Scheduled-review interval in force: an operator override from the UI, else the env default. 0 disables scheduled reviews. */
  async reviewEveryHours(): Promise<{ hours: number; source: "ui" | "env" }> {
    const o = await this.store.getState<{ hours: number }>(REVIEW_HOURS_KEY);
    return o ? { hours: o.hours, source: "ui" } : { hours: this.config.reviewEveryHours, source: "env" };
  }

  async setReviewEveryHours(hours: number, by: string): Promise<void> {
    await this.store.setState(REVIEW_HOURS_KEY, { hours, by, at: this.now().toISOString() });
  }

  /** Coins the watch tick checks beyond held positions: the UI watchlist, else DESK_WATCHLIST, else the default. */
  watchlist(): Promise<string[]> {
    return this.watchlistSource();
  }

  async marks(): Promise<{ ctxs: AssetCtx[]; marks: Map<string, number> }> {
    const ctxs = await this.data.ctxs();
    return { ctxs, marks: new Map(ctxs.map((c) => [c.name, c.markPx])) };
  }

  async account(): Promise<AccountState> {
    const { marks } = await this.marks();
    return this.broker.account(marks, this.now());
  }

  async watchedAccount(): Promise<AccountState | null> {
    return this.config.watchAddress ? this.data.watchedAccount(this.config.watchAddress) : null;
  }

  /** Case-insensitive coin lookup: HL names are case-sensitive ("kPEPE"). */
  static findMarket(ctxs: AssetCtx[], coin: string): MarketRef | null {
    const c = ctxs.find((x) => x.name === coin) ?? ctxs.find((x) => x.name.toLowerCase() === coin.toLowerCase());
    return c ? { coin: c.name, markPx: c.markPx, szDecimals: c.szDecimals, isDelisted: c.isDelisted } : null;
  }

  /**
   * What the governor checks an order against. On a venue where the trade picks its leverage (Propr), the coin's
   * notional ceiling is that leverage (capped to the coin's maximum) in place of DESK_MAX_COIN_LEVERAGE; without a
   * choice it is DESK_MAX_COIN_LEVERAGE, never above the coin's maximum. `venueWarnings` go on the verdict.
   */
  private async governorContext(coin: string, leverage?: number, confidence?: TradeProposal["confidence"]): Promise<GovernorContext & { venueWarnings: string[] }> {
    const { ctxs, marks } = await this.marks();
    const account = await this.broker.account(marks, this.now());
    // A live venue is checked against its own marks (testnet prices differ from mainnet).
    const market = this.broker.market ? await this.broker.market(coin) : DeskService.findMarket(ctxs, coin);
    const lev = this.broker.tradeLeverage?.(market?.coin ?? coin, leverage, confidence);
    const limits = lev ? { ...this.config.limits, maxCoinLeverage: lev.leverage ?? Math.min(this.config.limits.maxCoinLeverage, lev.max) } : this.config.limits;
    return { limits, account, market, killSwitch: (await this.killSwitch()).on, locks: await this.locks(), now: this.now(), venueWarnings: lev?.warning ? [lev.warning] : [] };
  }

  // ------------------------------------------------------------ cooldown

  /** Stop-out locks in force now (cooldown.ts). */
  async locks(): Promise<ActiveLocks> {
    return activeLocks(parseCooldownState(await this.store.getState(COOLDOWN_KEY)), this.now(), this.config.plan);
  }

  /** Records a stop-out (the watch tick calls this) and returns the locks in force after it. */
  async recordStopOut(coin: string, at: Date, ref: Omit<StopOutRef, "planId">): Promise<ActiveLocks> {
    const planId = ref.proposalId ? await this.planIdForProposal(ref.proposalId) : null;
    const state = parseCooldownState(await this.store.getState(COOLDOWN_KEY));
    await this.store.setState(COOLDOWN_KEY, recordStopOut(state, { coin, at, ref: { ...ref, planId } }, this.config.plan));
    return this.locks();
  }

  /** GET /desk/cooldown: the locks, each with the plan behind the loss when the desk can tie it to one. */
  async cooldown(): Promise<DeskCooldownResponse> {
    const locks = await this.locks();
    const coins = await Promise.all(locks.coins.map(async (l) => ({ ...l, plan: l.ref.planId ? await this.store.getPlan(l.ref.planId) : null })));
    return { ...locks, coins };
  }

  /** The plan journaled for a desk proposal: a plan's own link, else a copilot order's journal entry. */
  private async planIdForProposal(proposalId: string): Promise<string | null> {
    const p = await this.store.getProposal(proposalId);
    if (p && "source" in p.proposal && p.proposal.source === "plan") return p.proposal.planId;
    return (await this.store.listPlans(200)).find((x) => x.placement?.proposalId === proposalId)?.id ?? null;
  }

  /** The newest executed entry on a coin (a live stop-out names the proposal it most likely closed). */
  async lastEntryProposalId(coin: string): Promise<string | null> {
    const c = coin.toUpperCase();
    return (await this.store.listProposals({ status: "executed", limit: 100 })).find((p) => p.kind === "open" && (p.proposal as { coin: string }).coin.toUpperCase() === c)?.id ?? null;
  }

  // ------------------------------------------------------------ plans

  private planContext(ctx: GovernorContext): PlanContext {
    return { account: ctx.account, limits: ctx.limits, rules: this.config.plan, locks: ctx.locks, drawdownBaseUsd: this.config.propr?.startingBalance, markPx: ctx.market?.markPx ?? null };
  }

  /**
   * The plan rules (plan.ts checkPlan), the venue's limits and the governor's verdict on the plan at the live mark.
   * Writes nothing. The governor is asked to risk exactly the plan's loss at its stop; a plan it would shrink (the
   * per-trade, open-risk or leverage limits) is blocked, never placed smaller.
   */
  checkPlan(input: DeskPlanInput): Promise<PlanCheck> {
    return this.planCheckNow(input).then((c) => c.check);
  }

  private async planCheckNow(input: DeskPlanInput): Promise<{ check: PlanCheck; plan: DeskPlanInput; risk: RiskOrder | null; verdict: Verdict | null; sizing: Sizing | null }> {
    const ctx = await this.governorContext(input.coin);
    const plan = ctx.market ? { ...input, coin: ctx.market.coin } : input;
    const base = checkPlan(plan, this.planContext(ctx));
    const blockers = [...base.blockers];
    const warnings = [...ctx.venueWarnings, ...base.warnings];
    const add = (r: string) => void (blockers.includes(r) || blockers.push(r));
    const { market, account, limits } = ctx;
    const venue = this.broker.venue;
    if (!market) add(`${plan.coin} is not a listed Hyperliquid perp`);
    else {
      const step = 10 ** -market.szDecimals;
      const minRung = this.config.propr?.ladder.minRungUsd ?? this.config.limits.minNotionalUsd;
      for (const r of plan.rungs) {
        if (Math.abs(floorToDecimals(r.size, market.szDecimals) - r.size) > step * 1e-6) add(`rung size ${r.size} is not a multiple of ${plan.coin}'s size step ${step}`);
        if (r.px * r.size < minRung) add(`rung ${r.size} ${plan.coin} @ ${r.px} is ${r2(r.px * r.size)} USD, under the ${minRung} USD order minimum`);
      }
      // A venue without resting ladders fills one entry at the mark: anything else would place a different trade.
      if (!this.broker.openLadder) {
        if (plan.rungs.length > 1) add(`${venue} fills one entry at the mark and cannot rest a ${plan.rungs.length}-rung ladder: write one rung at the mark (${fmtPx(market.markPx)})`);
        else {
          const away = Math.abs(plan.rungs[0]!.px / market.markPx - 1);
          if (away > PLAN_MARK_TOLERANCE) add(`${venue} fills at the mark ${fmtPx(market.markPx)} and cannot rest a limit: the rung at ${fmtPx(plan.rungs[0]!.px)} is ${r2(away * 100)}% away (limit ${PLAN_MARK_TOLERANCE * 100}%)`);
        }
      }
    }
    const loss = base.metrics.lossAtStopUsd;
    let risk: RiskOrder | null = null;
    let verdict: Verdict | null = null;
    let sizing: Sizing | null = null;
    if (market && plan.stopPx != null && loss != null && loss > 0 && account.equityUsd > 0) {
      risk = { coin: plan.coin, side: plan.side, stop: plan.stopPx, ...(plan.targetPx != null ? { target: plan.targetPx } : {}), riskPct: (loss / account.equityUsd) * 100 };
      verdict = evaluateRisk(risk, ctx);
      const hasDaily = blockers.some((b) => b.startsWith("today's possible loss"));
      for (const r of verdict.reasons) if (!(hasDaily && r.startsWith("today's possible loss"))) add(r);
      warnings.push(...verdict.warnings.filter((w) => !w.startsWith("no target") && !w.includes("clipped")));
      const g = verdict.sizing;
      if (g) {
        const capped = blockers.some((b) => b.startsWith("loss at stop"));
        const slack = 10 ** -market.szDecimals * Math.abs(market.markPx - plan.stopPx) + 0.01;
        if (!capped && g.riskUsd < loss - slack) add(`the governor would risk at most ${g.riskUsd} USD here, the plan's stop loses ${loss} USD (${verdict.warnings.join("; ") || "risk limits"})`);
        const cap = notionalCap(limits, account);
        if (base.metrics.notionalUsd > cap + 0.01) add(`the plan's ${base.metrics.notionalUsd} USD notional is over the ${r2(Math.max(0, cap))} USD the leverage limits allow (gross ${limits.maxGrossLeverage}x, per coin ${limits.maxCoinLeverage}x)`);
        // What the venue is sent: a one-rung plan fills its own size at the mark; a ladder carries the plan's totals.
        const size = floorToDecimals(base.metrics.totalSize, market.szDecimals);
        const atMark = this.broker.openLadder ? null : size * Math.abs(market.markPx - plan.stopPx);
        sizing = { ...g, size, notionalUsd: r2(this.broker.openLadder ? base.metrics.notionalUsd : size * market.markPx), riskUsd: r2(atMark ?? loss), rr: base.metrics.rrFull };
      }
    }
    return { check: { metrics: base.metrics, blockers, warnings }, plan, risk, verdict, sizing };
  }

  /**
   * Journals a plan and, with `place` and no blockers, places it: one proposal record decided by `by`, sent to the
   * venue under the operator lock (no other operator order lands between the check and the send). The operator's
   * submit is the approval, so the approval mode does not apply. A one-rung plan fills at the mark on paper and
   * testnet; Propr rests every rung as a limit with its own stop and target.
   */
  submitPlan(input: DeskPlanInput, opts: { place: boolean; by: string }): Promise<DeskPlanSubmitResponse> {
    return this.serial(() => this.submitPlanNow(input, opts));
  }

  private async submitPlanNow(input: DeskPlanInput, opts: { place: boolean; by: string }): Promise<DeskPlanSubmitResponse> {
    const c = await this.planCheckNow(input);
    const { check } = c;
    const record = await this.store.insertPlan({
      createdAt: this.now().toISOString(), source: "plan", venue: this.broker.venue, input: c.plan,
      metrics: check.metrics, blockers: check.blockers, warnings: check.warnings, placed: false, placement: null,
    });
    if (!opts.place || check.blockers.length || !c.risk || !c.verdict?.approved || !c.sizing) return { record, check, placed: false };
    const risk = c.risk;
    const proposal: PlanOrderRecord = { ...risk, source: "plan", planId: record.id, rungs: c.plan.rungs, resolvedRiskPct: Math.round(risk.riskPct * 1e4) / 1e4 };
    const rec = await this.store.insertProposal({ runId: null, kind: "open", venue: this.broker.venue, proposal, verdict: c.verdict, execution: null, status: "pending", expiresAt: null, decidedBy: opts.by });
    const sizing = c.sizing;
    const ladder = this.broker.openLadder?.bind(this.broker);
    const send = ladder ? () => ladder(risk, c.plan.rungs, sizing, rec.id, this.now()) : undefined;
    const out = await this.fillOpen(rec, risk, c.verdict, sizing, opts.by, `plan ${record.id}${c.plan.note ? `: ${c.plan.note}` : ""}`, send);
    const placed = out.status === "executed";
    const placement = placementOf(out);
    const updated = await this.store.updatePlan(record.id, { placed, placement }).catch((err) => (console.error(`[desk] plan ${record.id} placement not recorded`, err), null));
    return { record: updated ?? { ...record, placed, placement }, check, placed };
  }

  /** A copilot-confirmed order in the plan journal: a one-rung plan at the mark, with what blocked it or what the venue did. */
  private async journalOperatorOrder(order: OperatorOrder, ctx: GovernorContext, rec: ProposalRecord): Promise<void> {
    const mark = ctx.market?.markPx;
    const size = rec.verdict.sizing?.size || (mark && order.notionalUsd ? order.notionalUsd / mark : 0);
    if (!mark || !(size > 0)) return;
    const input: DeskPlanInput = { coin: ctx.market!.coin, side: order.side, rungs: [{ px: mark, size }], stopPx: order.stop, targetPx: order.target ?? null, note: "copilot order" };
    const { metrics } = checkPlan(input, this.planContext(ctx));
    await this.store
      .insertPlan({
        createdAt: this.now().toISOString(), source: "copilot", venue: this.broker.venue, input, metrics,
        blockers: rec.status === "blocked" ? rec.verdict.reasons : [], warnings: rec.verdict.warnings,
        placed: rec.status === "executed", placement: rec.status === "blocked" ? null : placementOf(rec),
      })
      .catch((err) => console.error(`[desk] copilot order ${rec.id} not journaled`, err));
  }

  private static withWarnings(v: Verdict, extra: string[]): Verdict {
    return extra.length ? { ...v, warnings: [...extra, ...v.warnings] } : v;
  }

  async alert(level: AlertLevel, title: string, body: string, runId: string | null = null, actions?: AlertAction[]): Promise<void> {
    const a: Alert = { level, title, body, actions };
    const channels = await this.notifier.send(a);
    await this.store.insertAlert({ ts: this.now().toISOString(), level, title, body, runId, channels });
  }

  /** `forceManual` queues an approved proposal for the operator without reading the approval mode, so a mode flip can't race it (the TUI). */
  async submitOpen(input: TradeProposal, runId: string | null, opts: { forceManual?: boolean } = {}): Promise<ProposalRecord> {
    const ctx = await this.governorContext(input.coin, input.leverage, input.confidence);
    const p: TradeProposal = ctx.market ? { ...input, coin: ctx.market.coin } : input;
    const verdict = DeskService.withWarnings(evaluateOpen(p, ctx), ctx.venueWarnings);
    const approval = opts.forceManual ? "manual" : await this.approval();
    const base = { runId, kind: "open" as const, venue: this.broker.venue, proposal: p, verdict, execution: null };
    if (!verdict.approved) {
      const rec = await this.store.insertProposal({ ...base, status: "blocked", expiresAt: null, decidedBy: "governor" });
      await this.alert("info", `Blocked: ${p.side} ${p.coin}`, `${p.setup}\n${verdict.reasons.join("\n")}`, runId);
      return rec;
    }
    if (approval === "manual") {
      const expiresAt = new Date(this.now().getTime() + this.config.approvalTtlMin * 60_000).toISOString();
      const rec = await this.store.insertProposal({ ...base, status: "pending", expiresAt });
      await this.alert("warn", `Approve? ${p.side.toUpperCase()} ${p.coin}`, describeOpen(p, verdict, this.config.appUrl), runId, [
        { label: "Approve", data: `approve:${rec.id}` },
        { label: "Reject", data: `reject:${rec.id}` },
      ]);
      return rec;
    }
    // decidedBy at insert: the proposal is taken, so no approve() can claim it and send it a second time.
    const rec = await this.store.insertProposal({ ...base, status: "pending", expiresAt: null, decidedBy: "auto" });
    return this.executeOpen(rec, "auto");
  }

  async submitExit(input: ExitProposal, runId: string | null): Promise<ProposalRecord> {
    const ctx = await this.governorContext(input.coin);
    const p: ExitProposal = ctx.market ? { ...input, coin: ctx.market.coin } : input;
    const verdict = evaluateExit(p, ctx);
    const base = { runId, kind: "exit" as const, venue: this.broker.venue, proposal: p, verdict, execution: null };
    if (!verdict.approved) return this.store.insertProposal({ ...base, status: "blocked", expiresAt: null, decidedBy: "governor" });
    // Exits reduce risk, so they don't wait, except an agent's exit on a venue that is real money (Propr): the account
    // can hold positions the desk did not open, so the operator approves those closes. The operator's own close is direct.
    if (runId != null && this.broker.manualOnly) {
      const expiresAt = new Date(this.now().getTime() + this.config.approvalTtlMin * 60_000).toISOString();
      const rec = await this.store.insertProposal({ ...base, status: "pending", expiresAt });
      await this.alert("warn", `Approve exit? ${p.coin}`, `close ${Math.round(p.fraction * 100)}% of ${p.coin} on ${this.broker.venue}\n${p.reason}`, runId, [
        { label: "Approve", data: `approve:${rec.id}` },
        { label: "Reject", data: `reject:${rec.id}` },
      ]);
      return rec;
    }
    const rec = await this.store.insertProposal({ ...base, status: "pending", expiresAt: null, decidedBy: "auto" });
    return this.executeExit(rec, "auto");
  }

  /** Operator order sizing at the venue's current mark: the order's risk (from notional or leverage) through the governor. */
  private async operatorVerdict(order: OperatorOrder, requireTarget = false): Promise<{ ctx: GovernorContext; risk: RiskOrder; verdict: Verdict }> {
    const ctx = await this.governorContext(order.coin, order.leverage, order.confidence);
    const { order: risk, warnings } = operatorRiskOrder(order, ctx);
    const v = evaluateRisk(risk, ctx);
    // The copilot places planned trades only: no target, no order (the platform's tickets keep their own rules).
    const reasons = requireTarget && order.target == null ? [COPILOT_NO_TARGET, ...v.reasons] : v.reasons;
    return { ctx, risk, verdict: { ...v, approved: reasons.length === 0, reasons, warnings: [...ctx.venueWarnings, ...warnings, ...v.warnings] } };
  }

  /** Read-only governor verdict for an operator order plus the account it was sized against. Writes nothing (no preview key, no lock), so a caller's pending preview stays valid. */
  async assessOperatorOrder(order: OperatorOrder): Promise<{ account: AccountState; verdict: Verdict }> {
    const { ctx, verdict } = await this.operatorVerdict(order);
    return { account: ctx.account, verdict };
  }

  /** What the governor would do with an operator order right now. Executes nothing. Under the operator lock: a preview never lands inside another caller's preview → submit. */
  previewOperatorOrder(input: OperatorOrder): Promise<OperatorPreview> {
    return this.serial(() => this.previewOperatorOrderNow(input, true));
  }

  private async previewOperatorOrderNow(input: OperatorOrder, copilot: boolean): Promise<OperatorPreview> {
    const order = parseOperatorOrder(input);
    const { ctx, verdict } = await this.operatorVerdict(order, copilot);
    const at = this.now();
    const markPx = ctx.market?.markPx ?? null;
    const preview: StoredPreview = { hash: operatorPreviewHash(order, markPx, at.getTime()), markPx, at: at.toISOString() };
    await this.store.setState(OPERATOR_PREVIEW_KEY, preview);
    return { verdict, previewHash: preview.hash, markPx, venue: this.broker.venue, expiresAt: new Date(at.getTime() + OPERATOR_PREVIEW_TTL_MS).toISOString() };
  }

  /**
   * Executes a previewed operator order on the desk's venue. 409 when the
   * order or hash does not match the latest preview, the preview is over 60 s
   * old, or the mark moved more than 0.5% since; the governor re-checks on
   * fresh marks and a blocked verdict is recorded, never executed. `by` is
   * the operator who confirmed; it is recorded as the decision.
   */
  submitOperatorOrder(input: OperatorOrder, confirm: { previewHash: string }, by: string): Promise<ProposalRecord> {
    return this.serial(() => this.submitOperatorOrderNow(input, confirm, by, true));
  }

  /**
   * Preview and submit as one step under the operator lock, so no other operator preview or submit can land in
   * between (the platform's approve path: the operator's click on the opportunity is the confirm). `by` is stored on
   * the proposal from insert on (decidedBy), so a caller can find its proposal by it.
   */
  placeOperatorOrder(input: OperatorOrder, by: string): Promise<ProposalRecord> {
    return this.serial(async () => this.submitOperatorOrderNow(input, { previewHash: (await this.previewOperatorOrderNow(input, false)).previewHash }, by, false));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operatorLock.then(fn);
    this.operatorLock = run.catch(() => undefined);
    return run;
  }

  /** `copilot`: the /order copilot's confirm (a target is required, and the order is journaled as a plan). */
  private async submitOperatorOrderNow(input: OperatorOrder, confirm: { previewHash: string }, by: string, copilot: boolean): Promise<ProposalRecord> {
    const order = parseOperatorOrder(input);
    const mismatch = () => new DeskError(409, "order does not match the latest preview: preview it again");
    const latest = await this.store.getState<StoredPreview>(OPERATOR_PREVIEW_KEY);
    if (!latest || latest.hash !== confirm.previewHash || operatorPreviewHash(order, latest.markPx, Date.parse(latest.at)) !== latest.hash) throw mismatch();
    // One submit per preview: only the caller that removes it goes on.
    const stored = await this.store.takeState<StoredPreview>(OPERATOR_PREVIEW_KEY, confirm.previewHash);
    if (!stored) throw mismatch();
    const ageMs = this.now().getTime() - Date.parse(stored.at);
    if (ageMs > OPERATOR_PREVIEW_TTL_MS) throw new DeskError(409, `preview is ${Math.round(ageMs / 1000)} s old, over the ${OPERATOR_PREVIEW_TTL_MS / 1000} s limit: preview it again`);
    const { ctx, risk, verdict } = await this.operatorVerdict(order, copilot);
    const mark = ctx.market?.markPx;
    if (mark != null && (stored.markPx == null || Math.abs(mark / stored.markPx - 1) > OPERATOR_MAX_MOVE)) {
      throw new DeskError(409, `mark moved from ${stored.markPx == null ? "none" : fmtPx(stored.markPx)} to ${fmtPx(mark)} since the preview (limit ${OPERATOR_MAX_MOVE * 100}%): preview it again`);
    }
    const proposal: OperatorOrderRecord = { ...order, coin: risk.coin, resolvedRiskPct: risk.riskPct };
    const base = { runId: null, kind: "open" as const, venue: this.broker.venue, proposal, verdict, execution: null };
    if (!verdict.approved || !verdict.sizing) {
      const rec = await this.store.insertProposal({ ...base, status: "blocked", expiresAt: null, decidedBy: `governor (at ${by})` });
      await this.alert("info", `Blocked: ${risk.side} ${risk.coin} (copilot)`, verdict.reasons.join("\n"));
      if (copilot) await this.journalOperatorOrder(order, ctx, rec);
      return rec;
    }
    const rec = await this.store.insertProposal({ ...base, status: "pending", expiresAt: null, decidedBy: by });
    const out = await this.fillOpen(rec, risk, verdict, verdict.sizing, by, "operator order (copilot)");
    if (copilot) await this.journalOperatorOrder(order, ctx, out);
    return out;
  }

  async approve(id: string, by: string): Promise<ProposalRecord> {
    const rec = await this.store.getProposal(id);
    if (!rec) throw new DeskError(404, "proposal not found");
    if (rec.status !== "pending") throw new DeskError(409, `proposal is ${rec.status}`);
    if (rec.expiresAt && new Date(rec.expiresAt) < this.now()) {
      await this.store.updateProposal(id, { status: "expired", decidedBy: "clock", decidedAt: this.now().toISOString() });
      throw new DeskError(409, "proposal expired");
    }
    // One decision per proposal: only the caller whose claim lands goes on, so a double click or a Telegram and a UI
    // approve at once send it once.
    const claimed = await this.store.claimProposal(id, by, this.now().toISOString());
    if (!claimed) throw new DeskError(409, "proposal is already being decided");
    return claimed.kind === "open" ? this.executeOpen(claimed, by) : this.executeExit(claimed, by);
  }

  async reject(id: string, by: string): Promise<ProposalRecord> {
    const rec = await this.store.getProposal(id);
    if (!rec) throw new DeskError(404, "proposal not found");
    if (rec.status !== "pending") throw new DeskError(409, `proposal is ${rec.status}`);
    if (!(await this.store.claimProposal(id, by, this.now().toISOString()))) throw new DeskError(409, "proposal is already being decided");
    return (await this.store.updateProposal(id, { status: "rejected", decidedBy: by, decidedAt: this.now().toISOString() }))!;
  }

  /** Re-checks against the live mark, then fills. */
  private async executeOpen(rec: ProposalRecord, by: string): Promise<ProposalRecord> {
    const p = rec.proposal as TradeProposal;
    const ctx = await this.governorContext(p.coin, p.leverage, p.confidence);
    const verdict = DeskService.withWarnings(evaluateOpen(p, ctx), ctx.venueWarnings);
    const decidedAt = this.now().toISOString();
    if (!verdict.approved || !verdict.sizing) {
      const out = await this.store.updateProposal(rec.id, { status: "blocked", verdict, decidedBy: `governor (at ${by})`, decidedAt });
      await this.alert("warn", `Blocked at execution: ${p.side} ${p.coin}`, verdict.reasons.join("\n"), rec.runId);
      return out!;
    }
    return this.fillOpen(rec, p, verdict, verdict.sizing, by, p.setup);
  }

  /**
   * Sends an approved, sized entry to the venue and records the outcome. Once the venue has answered nothing here
   * throws: a failed record or alert write is logged and the in-memory record returned, so a caller never reads
   * "failed" while a position is open.
   */
  private async fillOpen(rec: ProposalRecord, p: RiskOrder, verdict: Verdict, sizing: Sizing, by: string, note: string, send?: () => Promise<ExecutionResult>): Promise<ProposalRecord> {
    const decidedAt = this.now().toISOString();
    const result = send ? await send() : await this.broker.open(p, sizing, rec.id, this.now());
    const patch = { status: result.ok ? ("executed" as const) : ("failed" as const), verdict, execution: result, decidedBy: by, decidedAt };
    const out = await this.store.updateProposal(rec.id, patch).catch((err) => (console.error(`[desk] proposal ${rec.id} ${patch.status} but not recorded`, err), null));
    const fill = result.fills[0];
    await this.alert(
      result.ok || result.dryRun ? "info" : "warn",
      result.ok ? `Opened ${p.side} ${p.coin} (${this.broker.venue})` : result.dryRun ? `Dry run: ${p.side} ${p.coin} built, not sent (${this.broker.venue})` : `Open failed: ${p.coin}`,
      result.ok && fill
        ? `${fill.size} @ ${fmtPx(fill.px)} · stop ${fmtPx(p.stop)} · target ${p.target != null ? fmtPx(p.target) : "none"} · risk $${sizing.riskUsd} · R:R ${sizing.rr ?? "n/a"}${result.note ? `\n${result.note}` : ""}\n${note}`
        : ((result.ok ? result.note : result.error) ?? "unknown error"),
      rec.runId,
    ).catch((err) => console.error(`[desk] alert for proposal ${rec.id} failed`, err));
    return out ?? { ...rec, ...patch };
  }

  private async executeExit(rec: ProposalRecord, by: string): Promise<ProposalRecord> {
    const p = rec.proposal as ExitProposal;
    const ctx = await this.governorContext(p.coin);
    const verdict = evaluateExit(p, ctx);
    const decidedAt = this.now().toISOString();
    if (!verdict.approved || !verdict.sizing) {
      return (await this.store.updateProposal(rec.id, { status: "blocked", verdict, decidedBy: `governor (at ${by})`, decidedAt }))!;
    }
    const result = await this.broker.exit(p.coin, verdict.sizing.size, verdict.sizing.markPx, "exit", rec.id, this.now());
    const out = await this.store.updateProposal(rec.id, { status: result.ok ? "executed" : "failed", verdict, execution: result, decidedBy: by, decidedAt });
    const fill = result.fills[0];
    await this.alert(
      "info",
      result.ok ? (fill ? `Closed ${fill.size} ${p.coin} (${this.broker.venue})` : `Close sent: ${p.coin} (${this.broker.venue})`) : result.dryRun ? `Dry run: close ${p.coin} built, not sent (${this.broker.venue})` : `Exit failed: ${p.coin}`,
      result.ok
        ? `${fill ? `@ ${fmtPx(fill.px)} · PnL $${fill.pnl.toFixed(2)}\n` : ""}${result.note ? `${result.note}\n` : ""}${p.reason}`
        : (result.error ?? "unknown error"),
      rec.runId,
    );
    return out!;
  }

  async expirePending(): Promise<number> {
    let n = 0;
    for (const rec of await this.store.listProposals({ status: "pending", limit: 100 })) {
      // A claimed proposal is being sent right now: the send records its outcome.
      if (rec.decidedBy) continue;
      if (rec.expiresAt && new Date(rec.expiresAt) < this.now()) {
        await this.store.updateProposal(rec.id, { status: "expired", decidedBy: "clock", decidedAt: this.now().toISOString() });
        n++;
      }
    }
    return n;
  }
}

export class DeskError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

export { fmtPx };

function placementOf(rec: ProposalRecord): PlanPlacement {
  const x = rec.execution as ExecutionResult | null;
  return { proposalId: rec.id, status: rec.status, error: x && !x.ok ? (x.error ?? null) : null, dryRun: !!x?.dryRun, note: x?.note ?? null };
}

function describeOpen(p: TradeProposal, v: Verdict, appUrl?: string): string {
  const s = v.sizing!;
  const lines = [
    `${p.setup} · ${p.horizon} · confidence ${p.confidence}`,
    `mark ${fmtPx(s.markPx)} · stop ${fmtPx(p.stop)} (${s.stopDistPct}%) · target ${fmtPx(p.target)} · R:R ${s.rr}`,
    `size ${s.size} ($${s.notionalUsd}) · risk $${s.riskUsd} · gross ${s.grossLeverageAfter}x`,
    "",
    p.thesis,
    "",
    `Invalidation: ${p.invalidation}`,
  ];
  if (v.warnings.length) lines.push("", ...v.warnings.map((w) => `⚠ ${w}`));
  if (appUrl) lines.push("", `${appUrl}/desk`);
  return lines.join("\n");
}
