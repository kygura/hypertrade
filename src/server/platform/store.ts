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
  type Opportunity,
  type OpportunityStatus,
  type PolledPosition,
  type Position,
} from "../../shared/platform.js";

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
  /** ts >= since, ascending by ts then coin. */
  scanSnapshotsSince(since: string): Promise<ScanSnapshot[]>;
  /** Retention (P0.4 prune): deletes scan and liqmap snapshots and position changes with ts < before. Never the ledger. */
  pruneHistory(before: string): Promise<number>;

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
}

// ---------------------------------------------------------------- shared rules

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
