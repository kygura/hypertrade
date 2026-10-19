import type { AddressRow, LedgerEntry, LedgerPayload, LiqMapSnapshot, NewLedgerEntry, Opportunity, Position } from "../../shared/platform.js";
import {
  checkTransition,
  dedupeKey,
  diffPositions,
  isLive,
  isPreDecision,
  isTerminal,
  transitionEntries,
  UUID,
  parsePoll,
  normalizeSightings,
  parseEntry,
  pollSummary,
  RESCAN_FIELDS,
  type AddressSighting,
  type OpportunityInput,
  type OutcomeRow,
  type PlatformStore,
  type PolledPosition,
  type PositionChange,
  type ScanSnapshot,
} from "./store.js";

const clone = <T>(v: T): T => structuredClone(v);
const iso = (s: string) => new Date(s).toISOString();
const byTs = <T extends { ts: string }>(a: T, b: T) => a.ts.localeCompare(b.ts);

/** In-process PlatformStore for tests and local runs without a database. Same rules as PgPlatformStore. */
export class MemoryPlatformStore implements PlatformStore {
  addresses = new Map<string, AddressRow>();
  positions = new Map<string, Position>();
  changes: PositionChange[] = [];
  liqmaps = new Map<string, LiqMapSnapshot>();
  scans = new Map<string, ScanSnapshot>();
  opportunities = new Map<string, Opportunity>();
  /** Append-only: nothing in this class splices, sets or reassigns an element. */
  readonly ledger: LedgerEntry[] = [];

  async recordAddresses(rows: AddressSighting[]): Promise<number> {
    const clean = normalizeSightings(rows);
    for (const { address, seenAt } of clean) {
      const a = this.addresses.get(address);
      if (a) a.lastSeenAt = a.lastSeenAt > seenAt ? a.lastSeenAt : seenAt;
      else this.addresses.set(address, { address, firstSeenAt: seenAt, lastSeenAt: seenAt, polledAt: null, notionalUsd: 0, positionCount: 0, minLiqDistance: null });
    }
    return clean.length;
  }

  async getAddress(address: string) {
    const a = this.addresses.get(address.toLowerCase());
    return a ? clone(a) : null;
  }

  async addressCount() {
    return this.addresses.size;
  }

  async savePoll(address: string, polledAt: string, positions: PolledPosition[]): Promise<PositionChange[]> {
    address = address.toLowerCase();
    const ts = iso(polledAt);
    positions = parsePoll(positions);
    if (!this.addresses.has(address)) await this.recordAddresses([{ address, seenAt: ts }]);
    const a = this.addresses.get(address);
    if (!a) throw new Error(`invalid address ${address}`);
    const prev = [...this.positions.values()].filter((p) => p.address === address);
    const changes = diffPositions(address, ts, prev, positions);
    for (const p of prev) this.positions.delete(`${address}|${p.coin}`);
    for (const p of positions) this.positions.set(`${address}|${p.coin}`, { ...clone(p), address, updatedAt: ts });
    this.changes.push(...changes);
    Object.assign(a, { polledAt: ts, ...pollSummary(positions) });
    return clone(changes);
  }

  async crawlCandidates({ idleBefore, limit }: { idleBefore: string; limit: number }) {
    const idle = iso(idleBefore);
    return [...this.addresses.values()]
      .filter((a) => a.polledAt === null || a.positionCount > 0 || a.lastSeenAt > a.polledAt || a.polledAt < idle)
      .sort((x, y) => (x.polledAt ?? "").localeCompare(y.polledAt ?? "") || x.address.localeCompare(y.address))
      .slice(0, limit)
      .map(clone);
  }

  async listPositions(coin?: string) {
    return [...this.positions.values()]
      .filter((p) => coin === undefined || p.coin === coin)
      .sort((x, y) => x.coin.localeCompare(y.coin) || x.address.localeCompare(y.address))
      .map(clone);
  }

  async positionChanges(address: string) {
    return this.changes.filter((c) => c.address === address.toLowerCase()).map(clone);
  }

  async insertLiqmapSnapshots(rows: LiqMapSnapshot[]) {
    for (const r of rows) this.liqmaps.set(`${r.coin}|${iso(r.ts)}`, { ...clone(r), ts: iso(r.ts) });
    return rows.length;
  }

  async liqmapHistory(coin: string, since: string) {
    const lo = iso(since);
    return [...this.liqmaps.values()].filter((r) => r.coin === coin && r.ts >= lo).sort(byTs).map(clone);
  }

  async insertScanSnapshots(rows: ScanSnapshot[]) {
    for (const r of rows) this.scans.set(`${r.coin}|${iso(r.ts)}`, { ...clone(r), ts: iso(r.ts) });
    return rows.length;
  }

  async scanSnapshotsSince(since: string) {
    const lo = iso(since);
    return [...this.scans.values()].filter((r) => r.ts >= lo).sort((a, b) => byTs(a, b) || a.coin.localeCompare(b.coin)).map(clone);
  }

  async pruneHistory(before: string) {
    const hi = iso(before);
    let n = 0;
    for (const m of [this.liqmaps, this.scans]) for (const [k, r] of m) if (r.ts < hi) (m.delete(k), n++);
    const kept = this.changes.filter((c) => c.ts >= hi);
    n += this.changes.length - kept.length;
    this.changes = kept;
    return n;
  }

  async upsertOpportunity(o: OpportunityInput, created: LedgerPayload<"created">) {
    const key = dedupeKey(o);
    const now = new Date().toISOString();
    const live = [...this.opportunities.values()].find((x) => x.dedupeKey === key && isLive(x.status));
    const id = crypto.randomUUID();
    const entry = parseEntry({ opportunityId: id, kind: "created", payload: created });
    if (live) {
      if (isPreDecision(live.status)) {
        for (const f of RESCAN_FIELDS) (live as Record<string, unknown>)[f] = clone(o[f]);
        live.updatedAt = now;
      }
      return { opportunity: clone(live), created: false };
    }
    const row: Opportunity = {
      ...clone(o), id, status: "new", netEdgeBps: null, grossEdgeBps: null, edgeBasis: "unvalidated",
      costs: null, createdAt: now, updatedAt: now, statusChangedAt: now, snoozedUntil: null, dedupeKey: key,
    };
    this.opportunities.set(row.id, row);
    this.push(entry);
    return { opportunity: clone(row), created: true };
  }

  async getOpportunity(id: string) {
    const o = this.opportunities.get(id);
    return o ? clone(o) : null;
  }

  async listOpportunities({ statuses, tier, limit }: Parameters<PlatformStore["listOpportunities"]>[0]) {
    return [...this.opportunities.values()]
      .filter((o) => (!statuses || statuses.includes(o.status)) && (tier === undefined || o.liquidityTier === tier))
      .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(clone);
  }

  async transitionOpportunity(...[id, from, to, actor, decision, note]: Parameters<PlatformStore["transitionOpportunity"]>) {
    checkTransition(from, to, actor, decision);
    if (!UUID.test(id)) return null;
    const entries = transitionEntries(id, from, to, actor, decision, note);
    const o = this.opportunities.get(id);
    if (!o || o.status !== from) return null;
    o.status = to;
    o.updatedAt = o.statusChangedAt = new Date().toISOString();
    entries.forEach((e) => this.push(e));
    return clone(o);
  }

  async lastTerminalAt(key: string) {
    const ts = [...this.opportunities.values()].filter((o) => o.dedupeKey === key && isTerminal(o.status)).map((o) => o.statusChangedAt).sort().at(-1);
    return ts ? new Date(ts) : null;
  }

  async setOpportunityCosts(id: string, c: LedgerPayload<"costs">) {
    if (!UUID.test(id)) return null;
    const entry = parseEntry({ opportunityId: id, kind: "costs", payload: c });
    const o = this.opportunities.get(id);
    if (!o || !isPreDecision(o.status)) return null;
    const { grossEdgeBps, netEdgeBps, edgeBasis, ...costs } = c;
    Object.assign(o, { costs, grossEdgeBps, netEdgeBps, edgeBasis, updatedAt: new Date().toISOString() });
    this.push(entry);
    return clone(o);
  }

  async snoozeOpportunity(id: string, until: string | null) {
    const o = this.opportunities.get(id);
    if (!o) return null;
    o.snoozedUntil = until === null ? null : iso(until);
    o.updatedAt = new Date().toISOString();
    return clone(o);
  }

  async appendLedger(e: Extract<NewLedgerEntry, { kind: "research" | "outcome" }>) {
    if (e.kind !== "research" && e.kind !== "outcome") throw new Error(`appendLedger takes research or outcome, not ${(e as NewLedgerEntry).kind}`);
    const entry = parseEntry(e);
    if (!this.opportunities.has(e.opportunityId)) throw new Error(`unknown opportunity ${e.opportunityId}`);
    if (e.kind === "outcome" && this.ledger.some((x) => x.kind === "outcome" && x.opportunityId === e.opportunityId && x.payload.horizon === e.payload.horizon)) return null;
    return clone(this.push(entry));
  }

  async ledgerFor(opportunityId: string) {
    return this.ledger.filter((e) => e.opportunityId === opportunityId).map(clone);
  }

  async outcomeRows({ setupKind, regime, tier }: Parameters<PlatformStore["outcomeRows"]>[0]): Promise<OutcomeRow[]> {
    const out: OutcomeRow[] = [];
    for (const e of this.ledger) {
      if (e.kind !== "outcome") continue;
      const o = this.opportunities.get(e.opportunityId)!;
      if ((setupKind && o.setupKind !== setupKind) || (regime && o.regime !== regime) || (tier !== undefined && o.liquidityTier !== tier)) continue;
      out.push({
        opportunityId: o.id, setupKind: o.setupKind, regime: o.regime, liquidityTier: o.liquidityTier,
        horizon: e.payload.horizon, createdAtMs: Date.parse(o.createdAt), grossReturn: e.payload.grossReturn, netReturn: e.payload.netReturn, hasCosts: o.costs != null,
      });
    }
    return out;
  }

  private push(e: NewLedgerEntry): LedgerEntry {
    const row = { ...clone(e), id: this.ledger.length + 1, createdAt: new Date().toISOString() } as LedgerEntry;
    this.ledger.push(row);
    return row;
  }
}
