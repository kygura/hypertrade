import { createHash } from "node:crypto";
import { fmtPx } from "../../shared/format.js";
import type { AssetCtx } from "../../shared/types.js";
import type { DeskConfig } from "./config.js";
import type { MarketData } from "./data.js";
import { evaluateExit, evaluateOpen, evaluateRisk, operatorRiskOrder, type GovernorContext, type MarketRef } from "./governor.js";
import type { Alert, AlertAction, Notifier } from "./notify.js";
import { HlBroker } from "./hl/broker.js";
import { PaperBroker, type Broker, type ExecutionResult } from "./paper.js";
import { PROPR_UPKEEP_KEY, ProprBroker, type ProprUpkeepState } from "./propr/broker.js";
import type { DeskStore } from "./store.js";
import type { LlmCaps } from "../intel/llm.js";
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
// The kill switch blocks every new entry (exits stay allowed) and cancels the
// desk's entry orders still resting on the venue (Propr's unfilled ladder
// rungs); protective stops stay. Every decision, fill and failure raises a
// stored alert.

const KILL_KEY = "kill_switch";
const APPROVAL_KEY = "approval_override";
const REVIEW_HOURS_KEY = "review_hours_override";
export const OPERATOR_PREVIEW_KEY = "operator_preview";
/** A preview can be submitted for this long, while the mark stays within OPERATOR_MAX_MOVE of it. */
const OPERATOR_PREVIEW_TTL_MS = 60_000;
const OPERATOR_MAX_MOVE = 0.005;

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
  /** Daily LLM caps and counter every desk run is checked against and billed to (production: Intel's, defaultLlmCaps). Absent: no cap (tests). */
  llm?: LlmCaps;
}

export class DeskService {
  readonly config: DeskConfig;
  readonly store: DeskStore;
  readonly data: MarketData;
  readonly notifier: Notifier;
  readonly broker: Broker;
  readonly llm?: LlmCaps;
  private readonly clock: () => Date;
  private readonly watchlistSource: () => Promise<string[]>;
  /** Serializes operator submits in this process (the store's takeState guards across processes). */
  private operatorLock: Promise<unknown> = Promise.resolve();

  constructor(d: DeskDeps) {
    this.config = d.config;
    this.store = d.store;
    this.data = d.data;
    this.notifier = d.notifier;
    this.llm = d.llm;
    this.clock = d.now ?? (() => new Date());
    this.watchlistSource = d.watchlist ?? (async () => this.config.watchlist);
    this.broker =
      d.broker ??
      (d.config.venue === "hl-testnet" && d.config.hl
        ? new HlBroker({ ...d.config.hl, takerFee: d.config.limits.takerFee })
        : d.config.venue === "propr" && d.config.propr
          ? new ProprBroker({
              config: d.config.propr,
              market: async (coin) => DeskService.findMarket(await d.data.ctxs(), coin),
              state: { get: () => d.store.getState<ProprUpkeepState>(PROPR_UPKEEP_KEY), set: (v) => d.store.setState(PROPR_UPKEEP_KEY, v) },
            })
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
    // Entries already resting on the venue would still fill: cancel them now. The switch is stored first, so whatever
    // fails here is retried by housekeeping on every watch tick while it stays on.
    const venue =
      on && this.broker.cancelEntries
        ? await this.broker.cancelEntries(this.now()).then(
            (notes) => notes.map((n) => n.text),
            (err) => [`resting entry orders on ${this.broker.venue} could not be cancelled (${err instanceof Error ? err.message : String(err)}); housekeeping retries on the next tick`],
          )
        : [];
    await this.alert(on ? "critical" : "info", on ? "Kill switch ON" : "Kill switch off", [`${reason} (by ${by})`, ...venue].join("\n"));
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
    return { limits, account, market, killSwitch: (await this.killSwitch()).on, now: this.now(), venueWarnings: lev?.warning ? [lev.warning] : [] };
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
  private async operatorVerdict(order: OperatorOrder): Promise<{ ctx: GovernorContext; risk: RiskOrder; verdict: Verdict }> {
    const ctx = await this.governorContext(order.coin, order.leverage, order.confidence);
    const { order: risk, warnings } = operatorRiskOrder(order, ctx);
    const v = evaluateRisk(risk, ctx);
    return { ctx, risk, verdict: { ...v, warnings: [...ctx.venueWarnings, ...warnings, ...v.warnings] } };
  }

  /** Read-only governor verdict for an operator order plus the account it was sized against. Writes nothing (no preview key, no lock), so a caller's pending preview stays valid. */
  async assessOperatorOrder(order: OperatorOrder): Promise<{ account: AccountState; verdict: Verdict }> {
    const { ctx, verdict } = await this.operatorVerdict(order);
    return { account: ctx.account, verdict };
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
      await this.store.expireProposal(id, this.now().toISOString());
      throw new DeskError(409, "proposal expired");
    }
    // The verdict, the sizing and the operator's read were for the venue it was proposed on (paper, testnet, Propr).
    if (rec.venue !== this.broker.venue) throw new DeskError(409, `proposal was made for the ${rec.venue} venue; the desk now runs on ${this.broker.venue}: reject it and propose again`);
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
    let verdict: Verdict;
    try {
      const ctx = await this.governorContext(p.coin, p.leverage, p.confidence);
      verdict = DeskService.withWarnings(evaluateOpen(p, ctx), ctx.venueWarnings);
    } catch (err) {
      return this.failUnsent(rec, p.coin, by, err);
    }
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
    const result = await this.broker.open(p, sizing, rec.id, this.now()).catch((err) => this.venueThrew(err));
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
    let verdict: Verdict;
    try {
      verdict = evaluateExit(p, await this.governorContext(p.coin));
    } catch (err) {
      return this.failUnsent(rec, p.coin, by, err);
    }
    const decidedAt = this.now().toISOString();
    if (!verdict.approved || !verdict.sizing) {
      return (await this.store.updateProposal(rec.id, { status: "blocked", verdict, decidedBy: `governor (at ${by})`, decidedAt }))!;
    }
    // Once the venue has answered nothing here throws, as in fillOpen: a caller never reads "failed" while a close went out.
    const result = await this.broker.exit(p.coin, verdict.sizing.size, verdict.sizing.markPx, "exit", rec.id, this.now()).catch((err) => this.venueThrew(err));
    const patch = { status: result.ok ? ("executed" as const) : ("failed" as const), verdict, execution: result, decidedBy: by, decidedAt };
    const out = await this.store.updateProposal(rec.id, patch).catch((err) => (console.error(`[desk] proposal ${rec.id} ${patch.status} but not recorded`, err), null));
    const fill = result.fills[0];
    await this.alert(
      "info",
      result.ok ? (fill ? `Closed ${fill.size} ${p.coin} (${this.broker.venue})` : `Close sent: ${p.coin} (${this.broker.venue})`) : result.dryRun ? `Dry run: close ${p.coin} built, not sent (${this.broker.venue})` : `Exit failed: ${p.coin}`,
      result.ok
        ? `${fill ? `@ ${fmtPx(fill.px)} · PnL $${fill.pnl.toFixed(2)}\n` : ""}${result.note ? `${result.note}\n` : ""}${p.reason}`
        : (result.error ?? "unknown error"),
      rec.runId,
    ).catch((err) => console.error(`[desk] alert for proposal ${rec.id} failed`, err));
    return out ?? { ...rec, ...patch };
  }

  /**
   * A venue that threw from open/exit instead of answering: the outcome is unknown, an order may be live. Recorded as
   * failed with that said, so the proposal is never left claimed and pending for good (expirePending skips claimed rows).
   */
  private venueThrew(err: unknown): ExecutionResult {
    const error = `${this.broker.venue} threw (${err instanceof Error ? err.message : String(err)}): the outcome is unknown, an order may have been sent. Check the venue by hand`;
    return { ok: false, venue: this.broker.venue, fills: [], error };
  }

  /**
   * A claimed proposal whose re-check threw (market data or account unreadable) before the venue was called: nothing
   * was sent, so it is recorded as failed. Left pending it would stay claimed for good: expirePending skips it and every
   * approve answers "already being decided".
   */
  private async failUnsent(rec: ProposalRecord, coin: string, by: string, err: unknown): Promise<ProposalRecord> {
    const error = `not sent: ${err instanceof Error ? err.message : String(err)}`;
    const execution: ExecutionResult = { ok: false, venue: this.broker.venue, fills: [], error };
    const out = await this.store.updateProposal(rec.id, { status: "failed", execution, decidedBy: by, decidedAt: this.now().toISOString() });
    await this.alert("warn", `${rec.kind === "open" ? "Open" : "Exit"} failed: ${coin}`, error, rec.runId).catch((e) => console.error(`[desk] alert for proposal ${rec.id} failed`, e));
    return out!;
  }

  async expirePending(): Promise<number> {
    let n = 0;
    for (const rec of await this.store.listProposals({ status: "pending", limit: 100 })) {
      // A claimed proposal is being sent right now: the send records its outcome.
      if (rec.decidedBy) continue;
      // Conditional in the store: an approve that claimed it since the list was read keeps it.
      if (rec.expiresAt && new Date(rec.expiresAt) < this.now() && (await this.store.expireProposal(rec.id, this.now().toISOString()))) n++;
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
