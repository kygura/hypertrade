import {
  AddressSchema,
  LIVE_STATUSES,
  NewLedgerEntrySchema,
  OPERATOR_ONLY,
  OPPORTUNITY_TRANSITIONS,
  PolledPositionSchema,
  PRE_DECISION_STATUSES,
  SYSTEM_ONLY,
  TERMINAL_STATUSES,
  type AddressRow,
  type LedgerEntry,
  type LedgerPayload,
  type LiqMapSnapshot,
  type LiquidityTier,
  type NewLedgerEntry,
  type NearMiss,
  type NoveltyEntry,
  type SectorTag,
  type Opportunity,
  type OpportunityStatus,
  type PolledPosition,
  type Position,
} from "../../shared/platform.js";
import { AgentRecordSchema, TriageItemSchema, type AgentRecord, type AgentRecordStatus, type TriageItem } from "../../shared/agentRecords.js";
import { MovesResponseSchema, type MovesResponse, type MoveWindow } from "../../shared/moves.js";
import { ExtremeRecordSchema, ExtremeVerdictSchema, type ExtremeRecord, type ExtremeVerdict } from "../../shared/extremes.js";

// Platform persistence (db/migrations/011_platform.sql). Loops and routes run
// against PlatformStore: MemoryPlatformStore (store-memory.ts) in tests,
// PgPlatformStore (store-pg.ts) in the app. Both share the pure rules below;
// store.test.ts runs one scenario through both and compares.
//
// The ledger is append-only: the interface has no update or delete path for
// it, every append is zod-parsed first, and Postgres refuses UPDATE, DELETE
// and TRUNCATE with a trigger. `opportunities` is the projection; each method
// that moves it writes its ledger entry in the same transaction.

export interface AddressSighting {
  address: string;
  seenAt: string;
}

export type { PolledPosition };

export interface PositionChange {
  address: string;
  coin: string;
  ts: string;
  kind: "open" | "close" | "change";
  szi: number | null;
  liquidationPx: number | null;
  prevSzi: number | null;
  prevLiquidationPx: number | null;
}

/** Raw scan inputs for one asset (P0.9): rebuilds the z-score ring at boot. */
export interface ScanSnapshot {
  coin: string;
  ts: string;
  inputs: Record<string, unknown>;
}

/** What the scanner supplies. Status starts at "new"; costs and edge come later via setOpportunityCosts. */
export type OpportunityInput = Pick<
  Opportunity,
  | "coin" | "direction" | "setupKind" | "tradeType" | "score" | "scoreVersion" | "tags" | "liquidityTier"
  | "regime" | "invalidation" | "entryPx" | "stopPx" | "targetPx" | "invalidationPx"
>;
/** Fields a rescan refreshes on a pre-decision opportunity (entryPx stays the mark at creation; statusChangedAt untouched). */
export const RESCAN_FIELDS = ["score", "scoreVersion", "tags", "liquidityTier", "regime", "invalidation", "stopPx", "targetPx", "invalidationPx"] as const;

/** One resolved outcome with the opportunity fields stats group by (P0.14). */
export interface OutcomeRow {
  opportunityId: string;
  setupKind: string;
  regime: string;
  /** Score version the opportunity was scored under; the regime label's meaning follows it. */
  scoreVersion: string;
  liquidityTier: LiquidityTier;
  horizon: string;
  /** Opportunity creation time (ms): the cluster bucket for stats. */
  createdAtMs: number;
  grossReturn: number;
  netReturn: number;
  /** The opportunity has a cost breakdown; stats exclude rows without one (P0.13). */
  hasCosts: boolean;
}

/** Extra fields on a `status` entry: the desk proposal id and, for code-made moves, why. */
export type StatusNote = Pick<LedgerPayload<"status">, "ref" | "reason">;

export interface PlatformStore {
  /** Address book upsert (P0.4 ws). Invalid addresses are dropped; duplicates keep the latest sighting. Returns addresses written. */
  recordAddresses(rows: AddressSighting[]): Promise<number>;
  getAddress(address: string): Promise<AddressRow | null>;
  addressCount(): Promise<number>;
  /**
   * One crawler poll (P0.7): `positions` is the account's full position list. Replaces its hl_positions rows,
   * appends the changes (diffPositions) and stamps the address's poll summary. Returns the changes appended.
   */
  savePoll(address: string, polledAt: string, positions: PolledPosition[]): Promise<PositionChange[]>;
  /**
   * Crawler candidates (P0.6), unpolled first then stalest: never polled, holding positions, traded since the last
   * poll, or polled before `idleBefore` (the hourly tier). priority.ts ranks them.
   */
  crawlCandidates(opts: { idleBefore: string; limit: number }): Promise<AddressRow[]>;
  /** Live liqmap and liquidation-pressure input; every coin when omitted. Ordered by coin, then address. */
  listPositions(coin?: string): Promise<Position[]>;
  /** One address's change history, ascending. */
  positionChanges(address: string): Promise<PositionChange[]>;

  /** Upsert on (coin, ts). Returns rows written. */
  insertLiqmapSnapshots(rows: LiqMapSnapshot[]): Promise<number>;
  /** ts >= since, ascending. */
  liqmapHistory(coin: string, since: string): Promise<LiqMapSnapshot[]>;
  /** Upsert on (coin, ts). Returns rows written. */
  insertScanSnapshots(rows: ScanSnapshot[]): Promise<number>;
  /** ts >= since, ascending by ts then coin; only `coins` when given (an empty list reads nothing). */
  scanSnapshotsSince(since: string, coins?: readonly string[]): Promise<ScanSnapshot[]>;
  /** Distinct scan timestamps with ts >= since: scanner ticks persisted (at most one per 5 min). */
  scanTickCount(since: string): Promise<number>;
  /**
   * Retention (P0.4 prune): deletes liqmap snapshots and position changes with ts < before, and scan snapshots with
   * ts < scansBefore (default `before`; PLATFORM_SCAN_RETENTION_DAYS keeps them longer for replays). Never the ledger.
   */
  pruneHistory(before: string, scansBefore?: string): Promise<number>;

  /**
   * Dedupe upsert (P0.11): with a live opportunity on the same key, returns it with created false and no ledger
   * entry, refreshing RESCAN_FIELDS only while it is pre-decision (approved and open rows are left unchanged).
   * Otherwise inserts it as "new" with its `created` ledger entry.
   */
  upsertOpportunity(o: OpportunityInput, created: LedgerPayload<"created">): Promise<{ opportunity: Opportunity; created: boolean }>;
  getOpportunity(id: string): Promise<Opportunity | null>;
  /** Highest score first. */
  listOpportunities(opts: { statuses?: OpportunityStatus[]; tier?: LiquidityTier; limit: number }): Promise<Opportunity[]>;
  /**
   * Compare-and-set status move plus its `status` entry (and the operator's `decision` entry for approved/rejected).
   * Throws on an illegal transition (checkTransition) or a bad payload; null when the id is malformed, the row is
   * missing or no longer at `from`. Sets statusChangedAt.
   */
  transitionOpportunity(
    id: string,
    from: OpportunityStatus,
    to: OpportunityStatus,
    actor: LedgerPayload<"status">["actor"],
    decision?: LedgerPayload<"decision">,
    /** Recorded on the `status` entry (approved -> open | failed: the desk proposal id and reason). */
    note?: StatusNote,
  ): Promise<Opportunity | null>;
  /** Cooldown (P0.11): latest statusChangedAt among the key's rejected, expired, failed or closed rows; null when none. */
  lastTerminalAt(dedupeKey: string): Promise<Date | null>;
  /** Sets costs and edge on a pre-decision opportunity and appends the `costs` entry. Null when malformed, missing or past the decision. */
  setOpportunityCosts(id: string, c: LedgerPayload<"costs">): Promise<Opportunity | null>;
  /** Projection only: snooze is a field, not a state. Null when missing. */
  snoozeOpportunity(id: string, until: string | null): Promise<Opportunity | null>;

  /**
   * Appends a `research` or `outcome` entry (the other kinds go through the methods above). Throws for a missing
   * opportunity. An outcome for an (opportunity, horizon) that already has one is ignored: null (P0.13, unique index).
   */
  appendLedger(e: Extract<NewLedgerEntry, { kind: "research" | "outcome" }>): Promise<LedgerEntry | null>;
  /** Entries for one opportunity in insertion order. */
  ledgerFor(opportunityId: string): Promise<LedgerEntry[]>;
  /** Every outcome entry joined with its opportunity, in insertion order. */
  outcomeRows(filter: { setupKind?: string; regime?: string; tier?: LiquidityTier }): Promise<OutcomeRow[]>;

  /** Novelty journal (docs/FEATURES.md 4): upsert by entry id, so a rerun adds nothing and a delivery stamp replaces the entry. */
  saveNovelty(entries: NoveltyEntry[]): Promise<void>;
  /** Entries with barDate >= sinceBar (YYYY-MM-DD), ascending by barDate then coin. */
  listNovelty(sinceBar: string): Promise<NoveltyEntry[]>;
  /** Retention: deletes entries with barDate < beforeBar. Returns rows deleted. */
  pruneNovelty(beforeBar: string): Promise<number>;
  /** Novelty pass progress (one row in sync_state, coin '_platform', series 'novelty-progress'): lets a bounded job resume. */
  saveNoveltyProgress(p: NoveltyProgress): Promise<void>;
  /** The row saveNoveltyProgress wrote; null before the first pass. */
  loadNoveltyProgress(): Promise<NoveltyProgress | null>;

  /** Near-misses of the latest completed scan (one row, replaced each call): lets a process without the scanner serve them. */
  saveNearMisses(ts: string, items: NearMiss[]): Promise<void>;
  /** The row saveNearMisses wrote; null before the first scan. */
  latestNearMisses(): Promise<{ ts: string; items: NearMiss[] } | null>;

  /** Market sector tags (PS-B5): upsert by coin. Tags only filter universes, never score. */
  saveSectors(tags: SectorTag[]): Promise<void>;
  /** Every cached tag, ascending by coin. */
  listSectors(): Promise<SectorTag[]>;

  /** Agent watch (db/migrations/024): inserts a zod-parsed record; throws on a duplicate id. */
  insertAgentRecord(r: AgentRecord): Promise<AgentRecord>;
  /**
   * Compare-and-set patch: applied only while the record is at `ifStatus` (any status when omitted). The result is
   * zod-parsed before it is written (a bad patch throws). Null when the id is missing or the status moved on.
   */
  updateAgentRecord(id: string, patch: AgentRecordPatch, ifStatus?: AgentRecordStatus): Promise<AgentRecord | null>;
  /** Newest first (createdAt desc, then id). `since` is inclusive. */
  listAgentRecords(q: { coin?: string; status?: AgentRecordStatus; since?: string; limit: number }): Promise<AgentRecord[]>;
  /** Records since `since` (inclusive) whose call reached a provider (model set, status not capped): the daily agent count. */
  agentRunsSince(since: string): Promise<number>;
  /** Upsert on (day, coin): a re-surfaced coin replaces its item for the day. Zod-parsed first. */
  upsertTriageItem(item: TriageItem): Promise<TriageItem>;
  /** The day's items, score desc then coin. */
  listTriage(day: string): Promise<TriageItem[]>;
  /** Stamps dismissedAt once (a second dismiss keeps the first stamp). Null when the id is missing. */
  dismissTriage(id: string, at: string): Promise<TriageItem | null>;
  /** Queue dismissal (025): upsert on (day, coin); a re-dismiss after re-entry moves dismissedAt. */
  dismissQueue(day: string, coin: string, at: string): Promise<QueueDismissal>;
  /** The day's queue dismissals, coin order (code units). */
  listQueueDismissals(day: string): Promise<QueueDismissal[]>;

  /**
   * Moves runs (026): the latest `ok` run per window, zod-parsed first (a run that is not `ok` throws). A run whose
   * computedAt is older than the stored one is ignored, so two writers never move it back.
   */
  saveMovesRun(run: MovesResponse): Promise<void>;
  /** The window's stored run; null before the first one. */
  latestMovesRun(window: MoveWindow): Promise<MovesResponse | null>;
  /** When the window's stored run was computed and what hour it runs to, without its rows; null before the first one. */
  movesRunAt(window: MoveWindow): Promise<{ asOf: string; computedAt: string } | null>;
  /** The latest triage pass (026, one row, replaced each pass). */
  saveTriageScan(scan: TriageScan): Promise<void>;
  /** The row saveTriageScan wrote; null before the first pass. */
  loadTriageScan(): Promise<TriageScan | null>;

  /** Extreme events (027): inserts a zod-parsed record (verdict null). False when (key, ts) is already stored. */
  insertExtremeEvent(r: ExtremeRecord): Promise<boolean>;
  /** The key's record with the newest event ts (the cooldown and the verdict route read it); null when none. */
  latestExtreme(key: string): Promise<ExtremeRecord | null>;
  /** Records with event ts >= since whose delivery went out (woken or pushed): the daily cap's count. */
  extremesDeliveredSince(since: string): Promise<number>;
  /** Newest event ts first (then key, code units). `since` is inclusive. */
  listExtremes(q: { since: string; limit: number }): Promise<ExtremeRecord[]>;
  /** Writes the verdict once (zod-parsed first). Null when (key, ts) is missing or already has a verdict. */
  setExtremeVerdict(key: string, ts: string, verdict: ExtremeVerdict, at: string): Promise<ExtremeRecord | null>;
}

/** Where a novelty pass stands (noveltyLoop.ts): survives a stateless invocation, so the next one resumes. */
export interface NoveltyProgress {
  /** The pass: its newest closed bar (YYYY-MM-DD). A new day starts a new pass. */
  pass: string;
  /** Coins evaluated (hit or not) per bar of the window. */
  checked: Record<string, string[]>;
  /** Pushes admitted in this pass: NOVELTY.runBudget is per pass, however many invocations it takes. */
  pushed: number;
  /** The coin the last invocation reached; the next one starts after it. */
  cursor: string | null;
  at: string;
}

/** One triage pass of the moves agent (docs/SPEC.md § Moves M4): what the triage and queue routes report. */
export interface TriageScan {
  day: string;
  at: string;
  state: "ok" | "pending" | "unavailable";
  reason: string | null;
  /** Coins in the moves universe the pass read. */
  watched: number;
  /** Candidates over the day's budget in the pass. */
  overBudget: number;
}

/** The run as stored: zod-parsed, and only an `ok` run with an asOf. */
export function parseMovesRun(run: MovesResponse): MovesResponse & { asOf: string } {
  const r = MovesResponseSchema.parse(run);
  if (r.state !== "ok" || r.asOf === null) throw new Error(`only an ok moves run is stored (got ${r.state})`);
  return r as MovesResponse & { asOf: string };
}

/** One coin hidden from the queue for one UTC day (docs/SPEC.md § Queue). */
export interface QueueDismissal {
  day: string;
  coin: string;
  dismissedAt: string;
}

/** Fields an agent record may change after insert: the call's result and, later, its grade. */
export type AgentRecordPatch = Partial<Pick<AgentRecord, "claim" | "assets" | "direction" | "layer" | "falsifier" | "sources" | "status" | "grade" | "model" | "dropped" | "error">>;

/** The record with `patch` applied, zod-parsed (identity and inputs never change). */
export function patchAgentRecord(r: AgentRecord, patch: AgentRecordPatch): AgentRecord {
  const { id, coin, createdAt, trigger, inputs, horizonHours, promptVersion } = r;
  return AgentRecordSchema.parse({ ...r, ...patch, id, coin, createdAt, trigger, inputs, horizonHours, promptVersion });
}

/** The record as stored: zod-parsed, a new record carries no verdict yet. */
export function parseExtremeRecord(r: ExtremeRecord): ExtremeRecord {
  const row = ExtremeRecordSchema.parse(r);
  return { ...row, event: { ...row.event, ts: new Date(row.event.ts).toISOString() }, verdict: null, verdictAt: null };
}
export const parseExtremeVerdict = (v: ExtremeVerdict): ExtremeVerdict => ExtremeVerdictSchema.parse(v);
/** Store order for extreme records: newest event first, then key (code units). */
export const byExtremeNewest = (a: ExtremeRecord, b: ExtremeRecord) => Date.parse(b.event.ts) - Date.parse(a.event.ts) || codeUnit(a.event.key, b.event.key);

export const parseAgentRecord = (r: AgentRecord): AgentRecord => AgentRecordSchema.parse(r);
export const parseTriageItem = (t: TriageItem): TriageItem => TriageItemSchema.parse(t);
/** A record counts as an agent run when its call reached a provider. */
export const isAgentRun = (r: Pick<AgentRecord, "status" | "model">) => r.status !== "capped" && r.model !== null;
const codeUnit = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
/** Store order for agent records and triage items (code-unit ties, as `collate "C"` in SQL). */
export const byNewest = (a: AgentRecord, b: AgentRecord) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || codeUnit(a.id, b.id);
export const byScore = (a: TriageItem, b: TriageItem) => b.score - a.score || codeUnit(a.coin, b.coin);
export const byCoin = (a: { coin: string }, b: { coin: string }) => codeUnit(a.coin, b.coin);

// ---------------------------------------------------------------- shared rules

/** PLATFORM_RETENTION_DAYS (14): liqmap snapshots and position changes. */
export const retentionDays = (env: Record<string, string | undefined> = process.env) => Number(env.PLATFORM_RETENTION_DAYS ?? 14) || 14;
/**
 * PLATFORM_SCAN_RETENTION_DAYS (30): scan_snapshots, the only stored intraday OI, kept longer than the rest for the
 * snapshot replay. Never shorter than PLATFORM_RETENTION_DAYS.
 */
export const scanRetentionDays = (env: Record<string, string | undefined> = process.env) => Math.max(retentionDays(env), Number(env.PLATFORM_SCAN_RETENTION_DAYS ?? 30) || 30);

export const dedupeKey = (o: Pick<Opportunity, "coin" | "direction" | "setupKind">) => `${o.coin}|${o.direction}|${o.setupKind}`;
export const isLive = (s: OpportunityStatus) => LIVE_STATUSES.includes(s);
export const isPreDecision = (s: OpportunityStatus) => PRE_DECISION_STATUSES.includes(s);
export const isTerminal = (s: OpportunityStatus) => TERMINAL_STATUSES.includes(s);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless from → to is in the P0.11 machine, operator-only moves come from an operator with a matching decision, and system-only moves from the system. */
export function checkTransition(
  from: OpportunityStatus,
  to: OpportunityStatus,
  actor: LedgerPayload<"status">["actor"],
  decision?: LedgerPayload<"decision">,
): void {
  if (!OPPORTUNITY_TRANSITIONS[from].includes(to)) throw new Error(`illegal transition ${from} → ${to}`);
  if (OPERATOR_ONLY.includes(to)) {
    if (actor !== "operator") throw new Error(`${to} comes only from an operator`);
    if (decision?.decision !== (to === "approved" ? "approve" : "reject")) throw new Error(`${to} needs a matching decision entry`);
  } else if (decision) throw new Error(`a decision entry only goes with approved or rejected`);
  if (SYSTEM_ONLY.includes(to) && actor !== "system") throw new Error(`${to} comes only from the system`);
}

/** Zod gate in front of every ledger insert. */
export const parseEntry = (e: NewLedgerEntry): NewLedgerEntry => NewLedgerEntrySchema.parse(e);

/** The `status` (+ `decision`) entries of one move, validated. */
export function transitionEntries(...[id, from, to, actor, decision, note]: Parameters<PlatformStore["transitionOpportunity"]>): NewLedgerEntry[] {
  checkTransition(from, to, actor, decision);
  const payload = { from, to, actor, ...(note?.ref !== undefined ? { ref: note.ref } : {}), ...(note?.reason ? { reason: note.reason } : {}) };
  const entries = [parseEntry({ opportunityId: id, kind: "status", payload })];
  if (decision) entries.push(parseEntry({ opportunityId: id, kind: "decision", payload: decision }));
  return entries;
}

/** Lowercases, drops invalid addresses, and keeps the latest sighting per address. */
export function normalizeSightings(rows: AddressSighting[]): AddressSighting[] {
  const out = new Map<string, AddressSighting>();
  for (const r of rows) {
    const address = r.address.toLowerCase();
    const seenAt = new Date(r.seenAt).toISOString();
    if (!AddressSchema.safeParse(address).success) continue;
    const prev = out.get(address);
    if (!prev || prev.seenAt < seenAt) out.set(address, { address, seenAt });
  }
  return [...out.values()];
}

/** |x − y| / |y| above 1%, or one side null and the other not (P0.7). */
const moved = (x: number | null, y: number | null) => (x == null || y == null ? x !== y : Math.abs(x - y) > 0.01 * Math.abs(y));

/** P0.7 change log: opens, closes, and > 1% moves in szi or liquidationPx. A sign flip counts as a change. */
export function diffPositions(address: string, ts: string, prev: Position[], next: PolledPosition[]): PositionChange[] {
  const before = new Map(prev.map((p) => [p.coin, p]));
  const after = new Map(next.map((p) => [p.coin, p]));
  const out: PositionChange[] = [];
  const coins = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const coin of coins) {
    const a = before.get(coin);
    const b = after.get(coin);
    const base = { address, coin, ts, szi: b?.szi ?? null, liquidationPx: b?.liquidationPx ?? null, prevSzi: a?.szi ?? null, prevLiquidationPx: a?.liquidationPx ?? null };
    if (!a && b) out.push({ ...base, kind: "open" });
    else if (a && !b) out.push({ ...base, kind: "close" });
    else if (a && b && (moved(b.szi, a.szi) || moved(b.liquidationPx, a.liquidationPx))) out.push({ ...base, kind: "change" });
  }
  return out;
}

/** The address row's poll summary: total value, count, and the nearest liquidation as a fraction of mark. */
export function pollSummary(positions: PolledPosition[]): Pick<AddressRow, "notionalUsd" | "positionCount" | "minLiqDistance"> {
  let min: number | null = null;
  for (const p of positions) {
    if (p.liquidationPx == null || p.positionValue <= 0) continue;
    const mark = p.positionValue / Math.abs(p.szi);
    const d = Math.abs(mark - p.liquidationPx) / mark;
    if (min === null || d < min) min = d;
  }
  return { notionalUsd: positions.reduce((s, p) => s + p.positionValue, 0), positionCount: positions.length, minLiqDistance: min };
}

/** Validates one poll (zod, then one position per coin: HL returns one, two would silently drop one). Returns the parsed list. */
export function parsePoll(positions: PolledPosition[]): PolledPosition[] {
  const parsed = PolledPositionSchema.array().parse(positions);
  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p.coin)) throw new Error(`duplicate position for ${p.coin}`);
    seen.add(p.coin);
  }
  return parsed;
}
