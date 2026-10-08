import { sql } from "../db.js";
import type { AlertLevel, ProposalRecord, ProposalStatus, Side } from "./types.js";

// Desk persistence (db/migrations/003_desk.sql). Everything goes through the
// DeskStore interface so routes, the watch tick and the agents run against
// MemoryStore in tests and against Postgres in the app.

export interface RunRow {
  id: string;
  kind: "ask" | "cycle";
  question: string;
  trigger: unknown;
  status: "running" | "done" | "error" | "timeout";
  answer: string | null;
  usage: unknown;
  costUsd: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface EventRow {
  seq: number;
  ts: string;
  agent: string;
  type: string;
  data: unknown;
}

export interface PaperPosition {
  coin: string;
  side: Side;
  size: number;
  entryPx: number;
  stopPx: number;
  tpPx: number | null;
  proposalId: string | null;
  openedAt: string;
}

export interface PaperFill {
  id?: number;
  ts: string;
  coin: string;
  side: "buy" | "sell";
  size: number;
  px: number;
  fee: number;
  pnl: number;
  reason: string;
  proposalId: string | null;
}

export interface AlertRow {
  id?: number;
  ts: string;
  level: AlertLevel;
  title: string;
  body: string;
  runId: string | null;
  channels: string[];
}

export type NewProposal = Omit<ProposalRecord, "id" | "createdAt" | "decidedBy" | "decidedAt"> & { decidedBy?: string | null };

export interface DeskStore {
  createRun(kind: RunRow["kind"], question: string, trigger: unknown): Promise<string>;
  appendEvents(runId: string, events: Array<{ seq: number; agent: string; type: string; data: unknown }>): Promise<void>;
  finishRun(id: string, f: { status: "done" | "error" | "timeout"; answer: string | null; usage: unknown; costUsd: number | null; error: string | null }): Promise<void>;
  listRuns(limit: number): Promise<RunRow[]>;
  getRun(id: string): Promise<(RunRow & { events: EventRow[] }) | null>;
  countRunsSince(kind: RunRow["kind"], since: Date): Promise<number>;

  insertProposal(p: NewProposal): Promise<ProposalRecord>;
  updateProposal(id: string, patch: Partial<Pick<ProposalRecord, "status" | "verdict" | "execution" | "decidedBy" | "decidedAt">>): Promise<ProposalRecord | null>;
  getProposal(id: string): Promise<ProposalRecord | null>;
  listProposals(opts: { status?: ProposalStatus; limit: number }): Promise<ProposalRecord[]>;

  paperPositions(): Promise<PaperPosition[]>;
  savePaperPosition(p: PaperPosition): Promise<void>;
  deletePaperPosition(coin: string): Promise<void>;
  insertFill(f: PaperFill): Promise<void>;
  listFills(limit: number): Promise<PaperFill[]>;

  insertAlert(a: AlertRow): Promise<void>;
  listAlerts(limit: number): Promise<AlertRow[]>;

  getState<T>(key: string): Promise<T | null>;
  setState(key: string, value: unknown): Promise<void>;
}

// ---------------------------------------------------------------- postgres

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

function toProposal(r: any): ProposalRecord {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind,
    status: r.status,
    venue: r.venue,
    proposal: r.proposal,
    verdict: r.verdict,
    execution: r.execution,
    decidedBy: r.decided_by,
    decidedAt: iso(r.decided_at),
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at)!,
  };
}

function toRun(r: any): RunRow {
  return {
    id: r.id,
    kind: r.kind,
    question: r.question,
    trigger: r.trigger,
    status: r.status,
    answer: r.answer,
    usage: r.usage,
    costUsd: r.cost_usd,
    error: r.error,
    startedAt: iso(r.started_at)!,
    finishedAt: iso(r.finished_at),
  };
}

export class PgStore implements DeskStore {
  async createRun(kind: RunRow["kind"], question: string, trigger: unknown) {
    const [row] = await sql()`insert into desk_runs (kind, question, trigger) values (${kind}, ${question}, ${sql().json((trigger ?? null) as any)}) returning id`;
    return row!.id as string;
  }
  async appendEvents(runId: string, events: Array<{ seq: number; agent: string; type: string; data: unknown }>) {
    if (!events.length) return;
    const rows = events.map((e) => ({ run_id: runId, seq: e.seq, agent: e.agent, type: e.type, data: sql().json(e.data as any) }));
    await sql()`insert into desk_events ${sql()(rows, "run_id", "seq", "agent", "type", "data")} on conflict do nothing`;
  }
  async finishRun(id: string, f: { status: "done" | "error" | "timeout"; answer: string | null; usage: unknown; costUsd: number | null; error: string | null }) {
    await sql()`update desk_runs set status = ${f.status}, answer = ${f.answer}, usage = ${sql().json((f.usage ?? null) as any)},
      cost_usd = ${f.costUsd}, error = ${f.error}, finished_at = now() where id = ${id}`;
  }
  async listRuns(limit: number) {
    const rows = await sql()`select * from desk_runs order by started_at desc limit ${limit}`;
    return rows.map(toRun);
  }
  async getRun(id: string) {
    const [row] = await sql()`select * from desk_runs where id = ${id}`;
    if (!row) return null;
    const events = await sql()`select seq, ts, agent, type, data from desk_events where run_id = ${id} order by seq`;
    return { ...toRun(row), events: events.map((e: any) => ({ seq: e.seq, ts: iso(e.ts)!, agent: e.agent, type: e.type, data: e.data })) };
  }
  async countRunsSince(kind: RunRow["kind"], since: Date) {
    const [row] = await sql()`select count(*)::int as n from desk_runs where kind = ${kind} and started_at >= ${since}`;
    return row!.n as number;
  }
  async insertProposal(p: NewProposal) {
    const [row] = await sql()`insert into desk_proposals (run_id, kind, status, venue, proposal, verdict, execution, decided_by, decided_at, expires_at)
      values (${p.runId}, ${p.kind}, ${p.status}, ${p.venue}, ${sql().json(p.proposal as any)}, ${sql().json(p.verdict as any)},
        ${sql().json((p.execution ?? null) as any)}, ${p.decidedBy ?? null}, ${p.decidedBy ? new Date() : null}, ${p.expiresAt})
      returning *`;
    return toProposal(row);
  }
  async updateProposal(id: string, patch: Partial<Pick<ProposalRecord, "status" | "verdict" | "execution" | "decidedBy" | "decidedAt">>) {
    const cur = await this.getProposal(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    const [row] = await sql()`update desk_proposals set status = ${next.status}, verdict = ${sql().json(next.verdict as any)},
      execution = ${sql().json((next.execution ?? null) as any)}, decided_by = ${next.decidedBy}, decided_at = ${next.decidedAt}
      where id = ${id} returning *`;
    return row ? toProposal(row) : null;
  }
  async getProposal(id: string) {
    const [row] = await sql()`select * from desk_proposals where id = ${id}`;
    return row ? toProposal(row) : null;
  }
  async listProposals(opts: { status?: ProposalStatus; limit: number }) {
    const rows = opts.status
      ? await sql()`select * from desk_proposals where status = ${opts.status} order by created_at desc limit ${opts.limit}`
      : await sql()`select * from desk_proposals order by created_at desc limit ${opts.limit}`;
    return rows.map(toProposal);
  }
  async paperPositions() {
    const rows = await sql()`select * from desk_paper_positions order by opened_at`;
    return rows.map((r: any) => ({
      coin: r.coin,
      side: r.side,
      size: r.size,
      entryPx: r.entry_px,
      stopPx: r.stop_px,
      tpPx: r.tp_px,
      proposalId: r.proposal_id,
      openedAt: iso(r.opened_at)!,
    }));
  }
  async savePaperPosition(p: PaperPosition) {
    await sql()`insert into desk_paper_positions (coin, side, size, entry_px, stop_px, tp_px, proposal_id, opened_at)
      values (${p.coin}, ${p.side}, ${p.size}, ${p.entryPx}, ${p.stopPx}, ${p.tpPx}, ${p.proposalId}, ${p.openedAt})
      on conflict (coin) do update set side = excluded.side, size = excluded.size, entry_px = excluded.entry_px,
        stop_px = excluded.stop_px, tp_px = excluded.tp_px, proposal_id = excluded.proposal_id`;
  }
  async deletePaperPosition(coin: string) {
    await sql()`delete from desk_paper_positions where coin = ${coin}`;
  }
  async insertFill(f: PaperFill) {
    await sql()`insert into desk_paper_fills (ts, coin, side, size, px, fee, pnl, reason, proposal_id)
      values (${f.ts}, ${f.coin}, ${f.side}, ${f.size}, ${f.px}, ${f.fee}, ${f.pnl}, ${f.reason}, ${f.proposalId})`;
  }
  async listFills(limit: number) {
    const rows = await sql()`select * from desk_paper_fills order by ts desc limit ${limit}`;
    return rows.map((r: any) => ({
      id: Number(r.id),
      ts: iso(r.ts)!,
      coin: r.coin,
      side: r.side,
      size: r.size,
      px: r.px,
      fee: r.fee,
      pnl: r.pnl,
      reason: r.reason,
      proposalId: r.proposal_id,
    }));
  }
  async insertAlert(a: AlertRow) {
    await sql()`insert into desk_alerts (ts, level, title, body, run_id, channels)
      values (${a.ts}, ${a.level}, ${a.title}, ${a.body}, ${a.runId}, ${sql().json(a.channels)})`;
  }
  async listAlerts(limit: number) {
    const rows = await sql()`select * from desk_alerts order by ts desc limit ${limit}`;
    return rows.map((r: any) => ({ id: Number(r.id), ts: iso(r.ts)!, level: r.level, title: r.title, body: r.body, runId: r.run_id, channels: r.channels }));
  }
  async getState<T>(key: string) {
    const [row] = await sql()`select value from desk_state where key = ${key}`;
    return row ? (row.value as T) : null;
  }
  async setState(key: string, value: unknown) {
    await sql()`insert into desk_state (key, value, updated_at) values (${key}, ${sql().json(value as any)}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
}

// ---------------------------------------------------------------- memory

/** In-process store for tests and local runs without a database. */
export class MemoryStore implements DeskStore {
  runs = new Map<string, RunRow & { events: EventRow[] }>();
  proposals = new Map<string, ProposalRecord>();
  positions = new Map<string, PaperPosition>();
  fills: PaperFill[] = [];
  alerts: AlertRow[] = [];
  state = new Map<string, unknown>();
  private n = 0;
  constructor(private readonly clock: () => Date = () => new Date()) {}
  private id() {
    this.n++;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
  }

  async createRun(kind: RunRow["kind"], question: string, trigger: unknown) {
    const id = this.id();
    this.runs.set(id, {
      id,
      kind,
      question,
      trigger,
      status: "running",
      answer: null,
      usage: null,
      costUsd: null,
      error: null,
      startedAt: this.clock().toISOString(),
      finishedAt: null,
      events: [],
    });
    return id;
  }
  async appendEvents(runId: string, events: Array<{ seq: number; agent: string; type: string; data: unknown }>) {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const e of events) run.events.push({ ...e, ts: this.clock().toISOString() });
  }
  async finishRun(id: string, f: { status: "done" | "error" | "timeout"; answer: string | null; usage: unknown; costUsd: number | null; error: string | null }) {
    const run = this.runs.get(id);
    if (run) Object.assign(run, f, { finishedAt: this.clock().toISOString() });
  }
  async listRuns(limit: number) {
    return [...this.runs.values()].reverse().slice(0, limit).map(({ events: _e, ...r }) => r);
  }
  async getRun(id: string) {
    return this.runs.get(id) ?? null;
  }
  async countRunsSince(kind: RunRow["kind"], since: Date) {
    return [...this.runs.values()].filter((r) => r.kind === kind && new Date(r.startedAt) >= since).length;
  }
  async insertProposal(p: NewProposal) {
    const rec: ProposalRecord = {
      ...p,
      id: this.id(),
      decidedBy: p.decidedBy ?? null,
      decidedAt: p.decidedBy ? this.clock().toISOString() : null,
      createdAt: this.clock().toISOString(),
    };
    this.proposals.set(rec.id, rec);
    return rec;
  }
  async updateProposal(id: string, patch: Partial<Pick<ProposalRecord, "status" | "verdict" | "execution" | "decidedBy" | "decidedAt">>) {
    const cur = this.proposals.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.proposals.set(id, next);
    return next;
  }
  async getProposal(id: string) {
    return this.proposals.get(id) ?? null;
  }
  async listProposals(opts: { status?: ProposalStatus; limit: number }) {
    return [...this.proposals.values()]
      .filter((p) => !opts.status || p.status === opts.status)
      .reverse()
      .slice(0, opts.limit);
  }
  async paperPositions() {
    return [...this.positions.values()];
  }
  async savePaperPosition(p: PaperPosition) {
    this.positions.set(p.coin, p);
  }
  async deletePaperPosition(coin: string) {
    this.positions.delete(coin);
  }
  async insertFill(f: PaperFill) {
    this.fills.push({ ...f, id: this.fills.length + 1 });
  }
  async listFills(limit: number) {
    return [...this.fills].reverse().slice(0, limit);
  }
  async insertAlert(a: AlertRow) {
    this.alerts.push({ ...a, id: this.alerts.length + 1 });
  }
  async listAlerts(limit: number) {
    return [...this.alerts].reverse().slice(0, limit);
  }
  async getState<T>(key: string) {
    return (this.state.has(key) ? (this.state.get(key) as T) : null) as T | null;
  }
  async setState(key: string, value: unknown) {
    this.state.set(key, value);
  }
}
