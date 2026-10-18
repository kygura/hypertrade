import { createHash } from "node:crypto";
import { fmtPx } from "../../shared/format.js";
import type { AssetCtx } from "../../shared/types.js";
import type { DeskConfig } from "./config.js";
import type { MarketData } from "./data.js";
import { evaluateExit, evaluateOpen, evaluateRisk, operatorRiskOrder, type GovernorContext, type MarketRef } from "./governor.js";
import type { Alert, AlertAction, Notifier } from "./notify.js";
import { HlBroker } from "./hl/broker.js";
import { PaperBroker, type Broker } from "./paper.js";
import type { DeskStore } from "./store.js";
import {
  OperatorOrderSchema,
  type AccountState,
  type AlertLevel,
  type ExitProposal,
  type OperatorOrder,
  type OperatorOrderRecord,
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

export const KILL_KEY = "kill_switch";
export const APPROVAL_KEY = "approval_override";
export const REVIEW_HOURS_KEY = "review_hours_override";
export const OPERATOR_PREVIEW_KEY = "operator_preview";
/** A preview can be submitted for this long, while the mark stays within OPERATOR_MAX_MOVE of it. */
export const OPERATOR_PREVIEW_TTL_MS = 60_000;
export const OPERATOR_MAX_MOVE = 0.005;

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
export function operatorPreviewHash(o: OperatorOrder, markPx: number | null, atMs: number): string {
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
}

export class DeskService {
  readonly config: DeskConfig;
  readonly store: DeskStore;
  readonly data: MarketData;
  readonly notifier: Notifier;
  readonly broker: Broker;
  private readonly clock: () => Date;
  /** Serializes operator submits in this process (the store's takeState guards across processes). */
  private operatorLock: Promise<unknown> = Promise.resolve();

  constructor(d: DeskDeps) {
    this.config = d.config;
    this.store = d.store;
    this.data = d.data;
    this.notifier = d.notifier;
    this.clock = d.now ?? (() => new Date());
    this.broker =
      d.broker ??
      (d.config.venue === "hl-testnet" && d.config.hl
        ? new HlBroker({ ...d.config.hl, takerFee: d.config.limits.takerFee })
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

  /** Approval in force: an operator override from the UI, else the env default. */
  async approval(): Promise<"manual" | "auto"> {
    const o = await this.store.getState<{ approval: "manual" | "auto" }>(APPROVAL_KEY);
    return o?.approval ?? this.config.approval;
  }

  async setApproval(approval: "manual" | "auto", by: string): Promise<void> {
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

  private async governorContext(coin: string): Promise<GovernorContext> {
    const { ctxs, marks } = await this.marks();
    const account = await this.broker.account(marks, this.now());
    return {
      limits: this.config.limits,
      account,
      // A live venue is checked against its own marks (testnet prices differ from mainnet).
      market: this.broker.market ? await this.broker.market(coin) : DeskService.findMarket(ctxs, coin),
      killSwitch: (await this.killSwitch()).on,
      now: this.now(),
    };
  }

  async alert(level: AlertLevel, title: string, body: string, runId: string | null = null, actions?: AlertAction[]): Promise<void> {
    const a: Alert = { level, title, body, actions };
    const channels = await this.notifier.send(a);
    await this.store.insertAlert({ ts: this.now().toISOString(), level, title, body, runId, channels });
  }

  async submitOpen(input: TradeProposal, runId: string | null): Promise<ProposalRecord> {
    const ctx = await this.governorContext(input.coin);
    const p: TradeProposal = ctx.market ? { ...input, coin: ctx.market.coin } : input;
    const verdict = evaluateOpen(p, ctx);
    const approval = await this.approval();
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
    const rec = await this.store.insertProposal({ ...base, status: "pending", expiresAt: null });
    return this.executeOpen(rec, "auto");
  }

  async submitExit(input: ExitProposal, runId: string | null): Promise<ProposalRecord> {
    const ctx = await this.governorContext(input.coin);
    const p: ExitProposal = ctx.market ? { ...input, coin: ctx.market.coin } : input;
    const verdict = evaluateExit(p, ctx);
    const base = { runId, kind: "exit" as const, venue: this.broker.venue, proposal: p, verdict, execution: null };
    if (!verdict.approved) return this.store.insertProposal({ ...base, status: "blocked", expiresAt: null, decidedBy: "governor" });
    // Exits reduce risk, so they never wait for approval.
    const rec = await this.store.insertProposal({ ...base, status: "pending", expiresAt: null });
    return this.executeExit(rec, "auto");
  }

  /** Operator order sizing at the venue's current mark: the order's risk (from notional or leverage) through the governor. */
  private async operatorVerdict(order: OperatorOrder): Promise<{ ctx: GovernorContext; risk: RiskOrder; verdict: Verdict }> {
    const ctx = await this.governorContext(order.coin);
    const { order: risk, warnings } = operatorRiskOrder(order, ctx);
    const v = evaluateRisk(risk, ctx);
    return { ctx, risk, verdict: { ...v, warnings: [...warnings, ...v.warnings] } };
  }

  /** What the governor would do with an operator order right now. Executes nothing. Under the operator lock: a preview never lands inside another caller's preview → submit. */
  previewOperatorOrder(input: OperatorOrder): Promise<OperatorPreview> {
    return this.serial(() => this.previewOperatorOrderNow(input));
  }

  private async previewOperatorOrderNow(input: OperatorOrder): Promise<OperatorPreview> {
    const order = parseOperatorOrder(input);
    const { ctx, verdict } = await this.operatorVerdict(order);
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
    return this.serial(() => this.submitOperatorOrderNow(input, confirm, by));
  }

  /**
   * Preview and submit as one step under the operator lock, so no other operator preview or submit can land in
   * between (the platform's approve path: the operator's click on the opportunity is the confirm). `by` is stored on
   * the proposal from insert on (decidedBy), so a caller can find its proposal by it.
   */
  placeOperatorOrder(input: OperatorOrder, by: string): Promise<ProposalRecord> {
    return this.serial(async () => this.submitOperatorOrderNow(input, { previewHash: (await this.previewOperatorOrderNow(input)).previewHash }, by));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operatorLock.then(fn);
    this.operatorLock = run.catch(() => undefined);
    return run;
  }

  private async submitOperatorOrderNow(input: OperatorOrder, confirm: { previewHash: string }, by: string): Promise<ProposalRecord> {
    const order = parseOperatorOrder(input);
    const mismatch = () => new DeskError(409, "order does not match the latest preview: preview it again");
    const latest = await this.store.getState<StoredPreview>(OPERATOR_PREVIEW_KEY);
    if (!latest || latest.hash !== confirm.previewHash || operatorPreviewHash(order, latest.markPx, Date.parse(latest.at)) !== latest.hash) throw mismatch();
    // One submit per preview: only the caller that removes it goes on.
    const stored = await this.store.takeState<StoredPreview>(OPERATOR_PREVIEW_KEY, confirm.previewHash);
    if (!stored) throw mismatch();
    const ageMs = this.now().getTime() - Date.parse(stored.at);
    if (ageMs > OPERATOR_PREVIEW_TTL_MS) throw new DeskError(409, `preview is ${Math.round(ageMs / 1000)} s old, over the ${OPERATOR_PREVIEW_TTL_MS / 1000} s limit: preview it again`);
    const { ctx, risk, verdict } = await this.operatorVerdict(order);
    const mark = ctx.market?.markPx;
    if (mark != null && (stored.markPx == null || Math.abs(mark / stored.markPx - 1) > OPERATOR_MAX_MOVE)) {
      throw new DeskError(409, `mark moved from ${stored.markPx == null ? "none" : fmtPx(stored.markPx)} to ${fmtPx(mark)} since the preview (limit ${OPERATOR_MAX_MOVE * 100}%): preview it again`);
    }
    const proposal: OperatorOrderRecord = { ...order, coin: risk.coin, resolvedRiskPct: risk.riskPct };
    const base = { runId: null, kind: "open" as const, venue: this.broker.venue, proposal, verdict, execution: null };
    if (!verdict.approved || !verdict.sizing) {
      const rec = await this.store.insertProposal({ ...base, status: "blocked", expiresAt: null, decidedBy: `governor (at ${by})` });
      await this.alert("info", `Blocked: ${risk.side} ${risk.coin} (copilot)`, verdict.reasons.join("\n"));
      return rec;
    }
    const rec = await this.store.insertProposal({ ...base, status: "pending", expiresAt: null, decidedBy: by });
    return this.fillOpen(rec, risk, verdict, verdict.sizing, by, "operator order (copilot)");
  }

  async approve(id: string, by: string): Promise<ProposalRecord> {
    const rec = await this.store.getProposal(id);
    if (!rec) throw new DeskError(404, "proposal not found");
    if (rec.status !== "pending") throw new DeskError(409, `proposal is ${rec.status}`);
    if (rec.expiresAt && new Date(rec.expiresAt) < this.now()) {
      await this.store.updateProposal(id, { status: "expired", decidedBy: "clock", decidedAt: this.now().toISOString() });
      throw new DeskError(409, "proposal expired");
    }
    return rec.kind === "open" ? this.executeOpen(rec, by) : this.executeExit(rec, by);
  }

  async reject(id: string, by: string): Promise<ProposalRecord> {
    const rec = await this.store.getProposal(id);
    if (!rec) throw new DeskError(404, "proposal not found");
    if (rec.status !== "pending") throw new DeskError(409, `proposal is ${rec.status}`);
    return (await this.store.updateProposal(id, { status: "rejected", decidedBy: by, decidedAt: this.now().toISOString() }))!;
  }

  /** Re-checks against the live mark, then fills. */
  private async executeOpen(rec: ProposalRecord, by: string): Promise<ProposalRecord> {
    const p = rec.proposal as TradeProposal;
    const ctx = await this.governorContext(p.coin);
    const verdict = evaluateOpen(p, ctx);
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
  private async fillOpen(rec: ProposalRecord, p: RiskOrder, verdict: Verdict, sizing: Sizing, by: string, note: string): Promise<ProposalRecord> {
    const decidedAt = this.now().toISOString();
    const result = await this.broker.open(p, sizing, rec.id, this.now());
    const patch = { status: result.ok ? ("executed" as const) : ("failed" as const), verdict, execution: result, decidedBy: by, decidedAt };
    const out = await this.store.updateProposal(rec.id, patch).catch((err) => (console.error(`[desk] proposal ${rec.id} ${patch.status} but not recorded`, err), null));
    const fill = result.fills[0];
    await this.alert(
      result.ok ? "info" : "warn",
      result.ok ? `Opened ${p.side} ${p.coin} (${this.broker.venue})` : `Open failed: ${p.coin}`,
      result.ok && fill
        ? `${fill.size} @ ${fmtPx(fill.px)} · stop ${fmtPx(p.stop)} · target ${p.target != null ? fmtPx(p.target) : "none"} · risk $${sizing.riskUsd} · R:R ${sizing.rr ?? "n/a"}\n${note}`
        : (result.error ?? "unknown error"),
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
      result.ok ? `Closed ${fill?.size} ${p.coin} (${this.broker.venue})` : `Exit failed: ${p.coin}`,
      result.ok && fill ? `@ ${fmtPx(fill.px)} · PnL $${fill.pnl.toFixed(2)}\n${p.reason}` : (result.error ?? "unknown error"),
      rec.runId,
    );
    return out!;
  }

  async expirePending(): Promise<number> {
    let n = 0;
    for (const rec of await this.store.listProposals({ status: "pending", limit: 100 })) {
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

export function describeOpen(p: TradeProposal, v: Verdict, appUrl?: string): string {
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
