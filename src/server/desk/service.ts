import type { AssetCtx } from "../../shared/types.js";
import type { DeskConfig } from "./config.js";
import type { MarketData } from "./data.js";
import { evaluateExit, evaluateOpen, type GovernorContext, type MarketRef } from "./governor.js";
import type { Alert, AlertAction, Notifier } from "./notify.js";
import { PaperBroker } from "./paper.js";
import type { DeskStore } from "./store.js";
import type { AccountState, AlertLevel, ExitProposal, ProposalRecord, TradeProposal, Verdict } from "./types.js";

// The desk service: the single path from a proposal to the book.
//
//   agent → propose_trade/propose_exit → submit*() → governor → record
//     approval "auto"   → execute now (re-checked against the live mark)
//     approval "manual" → pending; alert with approve/reject; approve() re-runs
//                         the governor on fresh prices before executing
//
// The kill switch blocks every new entry (exits stay allowed). Every
// decision, fill and failure raises a stored alert.

export const KILL_KEY = "kill_switch";
export const APPROVAL_KEY = "approval_override";

export interface DeskDeps {
  config: DeskConfig;
  store: DeskStore;
  data: MarketData;
  notifier: Notifier;
  now?: () => Date;
}

export class DeskService {
  readonly config: DeskConfig;
  readonly store: DeskStore;
  readonly data: MarketData;
  readonly notifier: Notifier;
  readonly broker: PaperBroker;
  private readonly clock: () => Date;

  constructor(d: DeskDeps) {
    this.config = d.config;
    this.store = d.store;
    this.data = d.data;
    this.notifier = d.notifier;
    this.clock = d.now ?? (() => new Date());
    this.broker = new PaperBroker(d.store, {
      startingEquity: d.config.paperStartingEquity,
      slippage: d.config.paperSlippage,
      takerFee: d.config.limits.takerFee,
    });
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
      market: DeskService.findMarket(ctxs, coin),
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
    const result = await this.broker.open(p, verdict.sizing, rec.id, this.now());
    const out = await this.store.updateProposal(rec.id, { status: result.ok ? "executed" : "failed", verdict, execution: result, decidedBy: by, decidedAt });
    const fill = result.fills[0];
    await this.alert(
      result.ok ? "info" : "warn",
      result.ok ? `Opened ${p.side} ${p.coin} (${this.broker.venue})` : `Open failed: ${p.coin}`,
      result.ok && fill
        ? `${fill.size} @ ${fmtPx(fill.px)} · stop ${fmtPx(p.stop)} · target ${fmtPx(p.target)} · risk $${verdict.sizing.riskUsd} · R:R ${verdict.sizing.rr}\n${p.setup}`
        : (result.error ?? "unknown error"),
      rec.runId,
    );
    return out!;
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

export function fmtPx(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  return a >= 1000 ? x.toFixed(1) : a >= 1 ? x.toFixed(3) : x.toPrecision(4);
}

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
