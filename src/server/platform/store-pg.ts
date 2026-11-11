import type postgres from "postgres";
import type { AddressRow, LedgerEntry, LedgerPayload, LiqMapSnapshot, NearMiss, NewLedgerEntry, NoveltyEntry, Opportunity, Position, SectorTag } from "../../shared/platform.js";
import { LIVE_STATUSES, PRE_DECISION_STATUSES, TERMINAL_STATUSES } from "../../shared/platform.js";
import type { AgentRecord, AgentRecordStatus, TriageItem } from "../../shared/agentRecords.js";
import type { MovesResponse, MoveWindow } from "../../shared/moves.js";
import { sql } from "../db.js";
import {
  byNewest,
  byCoin,
  byScore,
  parseAgentRecord,
  parseMovesRun,
  parseTriageItem,
  patchAgentRecord,
  type AgentRecordPatch,
  checkTransition,
  dedupeKey,
  diffPositions,
  normalizeSightings,
  parseEntry,
  parsePoll,
  pollSummary,
  transitionEntries,
  UUID,
  type AddressSighting,
  type OpportunityInput,
  type OutcomeRow,
  type PlatformStore,
  type QueueDismissal,
  type PolledPosition,
  type PositionChange,
  type ScanSnapshot,
  type TriageScan,
  type NoveltyProgress,
} from "./store.js";

/**
 * The SQL surface PgPlatformStore and db/migrate.ts need: positional-parameter
 * queries, multi-statement exec, and a transaction. postgres.js backs it in the
 * app (pgDb); PGlite backs it in tests, so the same SQL runs in both. Params
 * stay scalars (jsonb goes in as JSON text): db.ts runs with fetch_types off,
 * so array params are not available.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

function wrap(get: () => postgres.Sql | postgres.TransactionSql, inTx: boolean): Db {
  const db: Db = {
    query: async (text, params = []) => (await get().unsafe(text, params as never[])) as never,
    exec: async (text) => void (await get().unsafe(text).simple()),
    tx: async (fn) => (inTx ? fn(db) : ((await (get() as postgres.Sql).begin((tx) => fn(wrap(() => tx, true)))) as never)),
  };
  return db;
}
/** The app's Db over db.ts's shared client (sql() is resolved per call, so its idle reset still applies). */
export const pgDb = (): Db => wrap(sql, false);

const J = (v: unknown) => JSON.stringify(v);
const iso = (d: unknown) => new Date(d as string).toISOString();
const isoOrNull = (d: unknown) => (d == null ? null : iso(d));
/** Status lists as SQL literals (fixed enum values, not input). */
const sqlList = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(", ");
const LIVE_SQL = sqlList(LIVE_STATUSES);
const PRE_SQL = sqlList(PRE_DECISION_STATUSES);
const TERMINAL_SQL = sqlList(TERMINAL_STATUSES);

const ADDRESS_COLS = "address, first_seen_at, last_seen_at, polled_at, notional_usd, position_count, min_liq_distance";
const toAddress = (r: any): AddressRow => ({
  address: r.address, firstSeenAt: iso(r.first_seen_at), lastSeenAt: iso(r.last_seen_at), polledAt: isoOrNull(r.polled_at),
  notionalUsd: r.notional_usd, positionCount: r.position_count, minLiqDistance: r.min_liq_distance,
});
const toPosition = (r: any): Position => ({
  address: r.address, coin: r.coin, szi: r.szi, entryPx: r.entry_px, positionValue: r.position_value,
  liquidationPx: r.liquidation_px, leverage: r.leverage, updatedAt: iso(r.updated_at),
});
const toChange = (r: any): PositionChange => ({
  address: r.address, coin: r.coin, ts: iso(r.ts), kind: r.kind, szi: r.szi, liquidationPx: r.liquidation_px,
  prevSzi: r.prev_szi, prevLiquidationPx: r.prev_liquidation_px,
});
const toOpportunity = (r: any): Opportunity => ({
  id: r.id, coin: r.coin, direction: r.direction, setupKind: r.setup_kind, tradeType: r.trade_type, status: r.status,
  score: r.score, scoreVersion: r.score_version, netEdgeBps: r.net_edge_bps, grossEdgeBps: r.gross_edge_bps,
  edgeBasis: r.edge_basis, costs: r.costs, tags: r.tags, liquidityTier: r.liquidity_tier, regime: r.regime,
  invalidation: r.invalidation, entryPx: r.entry_px, stopPx: r.stop_px, targetPx: r.target_px, invalidationPx: r.invalidation_px,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), statusChangedAt: iso(r.status_changed_at), snoozedUntil: isoOrNull(r.snoozed_until), dedupeKey: r.dedupe_key,
});
const toEntry = (r: any): LedgerEntry =>
  ({ id: Number(r.id), opportunityId: r.opportunity_id, kind: r.kind, payload: r.payload, createdAt: iso(r.created_at) }) as LedgerEntry;

/** `skipDuplicates`: a row hitting the one-outcome-per-horizon index (012) is dropped, not raised. */
async function insertEntries(db: Db, entries: NewLedgerEntry[], skipDuplicates = false): Promise<LedgerEntry[]> {
  const rows = await db.query(
    `insert into ledger_entries (opportunity_id, kind, payload)
     select x.opportunity_id, x.kind, x.payload from jsonb_array_elements($1::text::jsonb) with ordinality as e(v, n), jsonb_to_record(e.v) as x(opportunity_id uuid, kind text, payload jsonb)
     order by e.n ${skipDuplicates ? "on conflict do nothing" : ""} returning *`,
    [J(entries.map((e) => ({ opportunity_id: e.opportunityId, kind: e.kind, payload: e.payload })))],
  );
  return rows.map(toEntry).sort((a, b) => a.id - b.id);
}

/** PlatformStore over Postgres (011_platform.sql). Every projection move and its ledger entry share a transaction. */
export class PgPlatformStore implements PlatformStore {
  constructor(private readonly db: Db = pgDb()) {}

  async insertAgentRecord(r: AgentRecord) {
    const row = parseAgentRecord(r);
    await this.db.query(`insert into agent_records (id, coin, status, created_at, model, body) values ($1, $2, $3, $4::timestamptz, $5, $6::text::jsonb)`, [
      row.id, row.coin, row.status, iso(row.createdAt), row.model, J(row),
    ]);
    return row;
  }

  async updateAgentRecord(id: string, patch: AgentRecordPatch, ifStatus?: AgentRecordStatus) {
    return this.db.tx(async (db) => {
      const [r] = await db.query<any>(`select body from agent_records where id = $1 and ($2::text is null or status = $2) for update`, [id, ifStatus ?? null]);
      if (!r) return null;
      const next = patchAgentRecord(r.body as AgentRecord, patch);
      await db.query(`update agent_records set status = $2, model = $3, body = $4::text::jsonb where id = $1`, [id, next.status, next.model, J(next)]);
      return next;
    });
  }

  async listAgentRecords({ coin, status, since, limit }: Parameters<PlatformStore["listAgentRecords"]>[0]) {
    const rows = await this.db.query<any>(
      `select body from agent_records where ($1::text is null or coin = $1) and ($2::text is null or status = $2) and ($3::timestamptz is null or created_at >= $3::timestamptz)
       order by created_at desc, id collate "C" limit $4::int`,
      [coin ?? null, status ?? null, since === undefined ? null : iso(since), limit],
    );
    return rows.map((r) => r.body as AgentRecord).sort(byNewest);
  }

  async agentRunsSince(since: string) {
    const [r] = await this.db.query<{ n: number }>(`select count(*)::int as n from agent_records where created_at >= $1::timestamptz and status <> 'capped' and model is not null`, [iso(since)]);
    return r!.n;
  }

  async upsertTriageItem(item: TriageItem) {
    const row = parseTriageItem(item);
    await this.db.query(
      `insert into triage_items (id, day, coin, score, body) values ($1, $2, $3, $4::float8, $5::text::jsonb)
       on conflict (day, coin) do update set id = excluded.id, score = excluded.score, body = excluded.body`,
      [row.id, row.day, row.coin, row.score, J(row)],
    );
    return row;
  }

  async listTriage(day: string) {
    const rows = await this.db.query<any>(`select body from triage_items where day = $1 order by score desc, coin collate "C"`, [day]);
    return rows.map((r) => r.body as TriageItem).sort(byScore);
  }

  async dismissTriage(id: string, at: string) {
    const [r] = await this.db.query<any>(
      `update triage_items set body = case when body->'dismissedAt' = 'null'::jsonb then jsonb_set(body, '{dismissedAt}', to_jsonb($2::text)) else body end
       where id = $1 returning body`,
      [id, iso(at)],
    );
    return r ? (r.body as TriageItem) : null;
  }

  async dismissQueue(day: string, coin: string, at: string) {
    const [r] = await this.db.query<any>(
      `insert into queue_dismissals (day, coin, dismissed_at) values ($1, $2, $3::timestamptz)
       on conflict (day, coin) do update set dismissed_at = excluded.dismissed_at returning day, coin, dismissed_at`,
      [day, coin, iso(at)],
    );
    return { day: r.day as string, coin: r.coin as string, dismissedAt: iso(r.dismissed_at) };
  }

  async listQueueDismissals(day: string) {
    const rows = await this.db.query<any>(`select day, coin, dismissed_at from queue_dismissals where day = $1 order by coin collate "C"`, [day]);
    return rows.map((r): QueueDismissal => ({ day: r.day, coin: r.coin, dismissedAt: iso(r.dismissed_at) })).sort(byCoin);
  }

  async saveMovesRun(run: MovesResponse) {
    const row = parseMovesRun(run);
    await this.db.query(
      `insert into moves_runs (win, as_of, computed_at, body) values ($1, $2::timestamptz, $3::timestamptz, $4::text::jsonb)
       on conflict (win) do update set as_of = excluded.as_of, computed_at = excluded.computed_at, body = excluded.body
       where moves_runs.computed_at <= excluded.computed_at`,
      [row.window, iso(row.asOf), iso(row.computedAt), J(row)],
    );
  }

  async latestMovesRun(window: MoveWindow) {
    const [r] = await this.db.query<any>(`select body from moves_runs where win = $1`, [window]);
    return r ? (r.body as MovesResponse) : null;
  }

  async movesRunAt(window: MoveWindow) {
    // The columns only: the body (every row of the run) is not read to state its age.
    const [r] = await this.db.query<any>(`select as_of, computed_at from moves_runs where win = $1`, [window]);
    return r ? { asOf: iso(r.as_of), computedAt: iso(r.computed_at) } : null;
  }

  async saveTriageScan(scan: TriageScan) {
    const row = { ...scan, at: iso(scan.at) };
    await this.db.query(
      `insert into moves_triage_scan (id, at, body) values ('latest', $1::timestamptz, $2::text::jsonb) on conflict (id) do update set at = excluded.at, body = excluded.body`,
      [row.at, J(row)],
    );
  }

  async loadTriageScan() {
    const [r] = await this.db.query<any>(`select body from moves_triage_scan where id = 'latest'`);
    return r ? (r.body as TriageScan) : null;
  }

  async recordAddresses(rows: AddressSighting[]) {
    const clean = normalizeSightings(rows);
    if (!clean.length) return 0;
    await this.db.query(
      `insert into hl_addresses (address, first_seen_at, last_seen_at)
       select x.address, x.seen_at, x.seen_at from jsonb_to_recordset($1::text::jsonb) as x(address text, seen_at timestamptz)
       on conflict (address) do update set last_seen_at = greatest(hl_addresses.last_seen_at, excluded.last_seen_at)`,
      [J(clean.map((r) => ({ address: r.address, seen_at: r.seenAt })))],
    );
    return clean.length;
  }

  async getAddress(address: string) {
    const [r] = await this.db.query(`select ${ADDRESS_COLS} from hl_addresses where address = $1`, [address.toLowerCase()]);
    return r ? toAddress(r) : null;
  }

  async addressCount() {
    const [r] = await this.db.query<{ n: number }>(`select count(*)::int as n from hl_addresses`);
    return r!.n;
  }

  async savePoll(address: string, polledAt: string, positions: PolledPosition[]) {
    address = address.toLowerCase();
    const ts = iso(polledAt);
    positions = parsePoll(positions);
    const s = pollSummary(positions);
    return this.db.tx(async (db) => {
      await db.query(
        `insert into hl_addresses (address, first_seen_at, last_seen_at, polled_at, notional_usd, position_count, min_liq_distance)
         values ($1, $2::timestamptz, $2::timestamptz, $2::timestamptz, $3::float8, $4::int, $5::float8)
         on conflict (address) do update set polled_at = excluded.polled_at, notional_usd = excluded.notional_usd,
           position_count = excluded.position_count, min_liq_distance = excluded.min_liq_distance`,
        [address, ts, s.notionalUsd, s.positionCount, s.minLiqDistance],
      );
      const prev = (await db.query(`select * from hl_positions where address = $1 for update`, [address])).map(toPosition);
      const changes = diffPositions(address, ts, prev, positions);
      await db.query(`delete from hl_positions where address = $1`, [address]);
      if (positions.length) {
        await db.query(
          `insert into hl_positions (address, coin, szi, entry_px, position_value, liquidation_px, leverage, updated_at)
           select $1, x.coin, x.szi, x.entry_px, x.position_value, x.liquidation_px, x.leverage, $2::timestamptz
           from jsonb_to_recordset($3::text::jsonb) as x(coin text, szi float8, entry_px float8, position_value float8, liquidation_px float8, leverage float8)`,
          [address, ts, J(positions.map((p) => ({ coin: p.coin, szi: p.szi, entry_px: p.entryPx, position_value: p.positionValue, liquidation_px: p.liquidationPx, leverage: p.leverage })))],
        );
      }
      if (changes.length) {
        await db.query(
          `insert into hl_position_changes (address, coin, ts, kind, szi, liquidation_px, prev_szi, prev_liquidation_px)
           select x.address, x.coin, x.ts, x.kind, x.szi, x.liquidation_px, x.prev_szi, x.prev_liquidation_px
           from jsonb_array_elements($1::text::jsonb) with ordinality as e(v, n),
             jsonb_to_record(e.v) as x(address text, coin text, ts timestamptz, kind text, szi float8, liquidation_px float8, prev_szi float8, prev_liquidation_px float8)
           order by e.n`,
          [J(changes.map((c) => ({ address, coin: c.coin, ts, kind: c.kind, szi: c.szi, liquidation_px: c.liquidationPx, prev_szi: c.prevSzi, prev_liquidation_px: c.prevLiquidationPx })))],
        );
      }
      return changes;
    });
  }

  async crawlCandidates({ idleBefore, limit }: { idleBefore: string; limit: number }) {
    const rows = await this.db.query(
      `select ${ADDRESS_COLS} from hl_addresses
       where polled_at is null or position_count > 0 or last_seen_at > polled_at or polled_at < $1::timestamptz
       order by polled_at asc nulls first, address limit $2::int`,
      [iso(idleBefore), limit],
    );
    return rows.map(toAddress);
  }

  async listPositions(coin?: string) {
    const rows = await this.db.query(`select * from hl_positions where ($1::text is null or coin = $1) order by coin, address`, [coin ?? null]);
    return rows.map(toPosition);
  }

  async positionChanges(address: string) {
    return (await this.db.query(`select * from hl_position_changes where address = $1 order by id`, [address.toLowerCase()])).map(toChange);
  }

  async insertLiqmapSnapshots(rows: LiqMapSnapshot[]) {
    if (!rows.length) return 0;
    await this.db.query(
      `insert into liqmap_snapshots (coin, ts, mark, bucket_bps, buckets)
       select x.coin, x.ts, x.mark, x.bucket_bps, x.buckets from jsonb_to_recordset($1::text::jsonb) as x(coin text, ts timestamptz, mark float8, bucket_bps float8, buckets jsonb)
       on conflict (coin, ts) do update set mark = excluded.mark, bucket_bps = excluded.bucket_bps, buckets = excluded.buckets`,
      [J(rows.map((r) => ({ coin: r.coin, ts: iso(r.ts), mark: r.mark, bucket_bps: r.bucketBps, buckets: r.buckets })))],
    );
    return rows.length;
  }

  async liqmapHistory(coin: string, since: string) {
    const rows = await this.db.query<any>(`select * from liqmap_snapshots where coin = $1 and ts >= $2::timestamptz order by ts`, [coin, iso(since)]);
    return rows.map((r): LiqMapSnapshot => ({ coin: r.coin, ts: iso(r.ts), mark: r.mark, bucketBps: r.bucket_bps, buckets: r.buckets }));
  }

  async insertScanSnapshots(rows: ScanSnapshot[]) {
    if (!rows.length) return 0;
    await this.db.query(
      `insert into scan_snapshots (coin, ts, inputs)
       select x.coin, x.ts, x.inputs from jsonb_to_recordset($1::text::jsonb) as x(coin text, ts timestamptz, inputs jsonb)
       on conflict (coin, ts) do update set inputs = excluded.inputs`,
      [J(rows.map((r) => ({ coin: r.coin, ts: iso(r.ts), inputs: r.inputs })))],
    );
    return rows.length;
  }

  async scanSnapshotsSince(since: string, coins?: readonly string[]) {
    // The coin list goes in as jsonb text (no array params: db.ts runs with fetch_types false).
    const rows = coins
      ? await this.db.query<any>(`select * from scan_snapshots where ts >= $1::timestamptz and coin in (select jsonb_array_elements_text($2::text::jsonb)) order by ts, coin`, [iso(since), J(coins)])
      : await this.db.query<any>(`select * from scan_snapshots where ts >= $1::timestamptz order by ts, coin`, [iso(since)]);
    return rows.map((r): ScanSnapshot => ({ coin: r.coin, ts: iso(r.ts), inputs: r.inputs }));
  }

  async saveNovelty(entries: NoveltyEntry[]) {
    for (const e of entries) {
      await this.db.query(`insert into platform_novelty (id, bar_date, entry) values ($1, $2, $3::text::jsonb) on conflict (id) do update set entry = excluded.entry`, [e.id, e.barDate, J(e)]);
    }
  }

  async listNovelty(sinceBar: string) {
    return (await this.db.query<any>(`select entry from platform_novelty where bar_date >= $1 order by bar_date, entry->>'coin'`, [sinceBar])).map((r): NoveltyEntry => r.entry);
  }

  async pruneNovelty(beforeBar: string) {
    return (await this.db.query(`delete from platform_novelty where bar_date < $1 returning 1`, [beforeBar])).length;
  }

  async saveNoveltyProgress(p: NoveltyProgress) {
    const row = { ...p, at: iso(p.at) };
    await this.db.query(
      `insert into sync_state (coin, series, synced_at, ext) values ('_platform', 'novelty-progress', $1::timestamptz, $2::text::jsonb)
       on conflict (coin, series) do update set synced_at = excluded.synced_at, ext = excluded.ext`,
      [row.at, J(row)],
    );
  }

  async loadNoveltyProgress() {
    const [r] = await this.db.query<any>(`select ext from sync_state where coin = '_platform' and series = 'novelty-progress'`);
    return r ? (r.ext as NoveltyProgress) : null;
  }

  async saveNearMisses(ts: string, items: NearMiss[]) {
    await this.db.query(`insert into platform_near_miss (id, ts, items) values ('latest', $1::timestamptz, $2::text::jsonb) on conflict (id) do update set ts = excluded.ts, items = excluded.items`, [iso(ts), J(items)]);
  }

  async latestNearMisses() {
    const [r] = await this.db.query<any>(`select ts, items from platform_near_miss where id = 'latest'`);
    return r ? { ts: iso(r.ts), items: r.items as NearMiss[] } : null;
  }

  async saveSectors(tags: SectorTag[]) {
    for (const t of tags) {
      await this.db.query(`insert into market_sectors (coin, sectors, tagged_at) values ($1, $2::text::jsonb, $3::timestamptz) on conflict (coin) do update set sectors = excluded.sectors, tagged_at = excluded.tagged_at`, [t.coin, J(t.sectors), iso(t.taggedAt)]);
    }
  }

  async listSectors() {
    return (await this.db.query<any>(`select coin, sectors, tagged_at from market_sectors order by coin`)).map((r): SectorTag => ({ coin: r.coin, sectors: r.sectors, taggedAt: iso(r.tagged_at) }));
  }

  async scanTickCount(since: string) {
    const [r] = await this.db.query<{ n: number }>(`select count(distinct ts)::int as n from scan_snapshots where ts >= $1::timestamptz`, [iso(since)]);
    return r!.n;
  }

  async pruneHistory(before: string, scansBefore = before) {
    const [r] = await this.db.query<{ n: number }>(
      `with a as (delete from liqmap_snapshots where ts < $1::timestamptz returning 1),
            b as (delete from scan_snapshots where ts < $2::timestamptz returning 1),
            c as (delete from hl_position_changes where ts < $1::timestamptz returning 1)
       select ((select count(*) from a) + (select count(*) from b) + (select count(*) from c))::int as n`,
      [iso(before), iso(scansBefore)],
    );
    return r!.n;
  }

  async upsertOpportunity(o: OpportunityInput, created: LedgerPayload<"created">) {
    // The id is ours, so the entry is validated before anything is written; a dedupe hit keeps the live row's id.
    const id = crypto.randomUUID();
    const entry = parseEntry({ opportunityId: id, kind: "created", payload: created });
    return this.db.tx(async (db) => {
      const [r] = await db.query<any>(
        `insert into opportunities (id, coin, direction, setup_kind, trade_type, status, score, score_version, edge_basis, tags,
           liquidity_tier, regime, invalidation, entry_px, stop_px, target_px, invalidation_px, dedupe_key)
         values ($16::uuid, $1, $2, $3, $4, 'new', $5::float8, $6, 'unvalidated', $7::text::jsonb, $8::int, $9, $10, $11::float8, $12::float8, $13::float8, $14::float8, $15)
         on conflict (dedupe_key) where status in (${LIVE_SQL}) do update set
           score = excluded.score, score_version = excluded.score_version, tags = excluded.tags, liquidity_tier = excluded.liquidity_tier,
           regime = excluded.regime, invalidation = excluded.invalidation, stop_px = excluded.stop_px, target_px = excluded.target_px,
           invalidation_px = excluded.invalidation_px, updated_at = now()
         where opportunities.status in (${PRE_SQL})
         returning *, (xmax = 0) as inserted`,
        [o.coin, o.direction, o.setupKind, o.tradeType, o.score, o.scoreVersion, J(o.tags), o.liquidityTier, o.regime, o.invalidation,
          o.entryPx, o.stopPx, o.targetPx, o.invalidationPx, dedupeKey(o), id],
      );
      // No row back: the live one is past the decision, so the rescan leaves it as is.
      if (!r) {
        const [live] = await db.query(`select * from opportunities where dedupe_key = $1 and status in (${LIVE_SQL})`, [dedupeKey(o)]);
        return { opportunity: toOpportunity(live), created: false };
      }
      if (r.inserted) await insertEntries(db, [entry]);
      return { opportunity: toOpportunity(r), created: Boolean(r.inserted) };
    });
  }

  async getOpportunity(id: string) {
    if (!UUID.test(id)) return null;
    const [r] = await this.db.query(`select * from opportunities where id = $1::uuid`, [id]);
    return r ? toOpportunity(r) : null;
  }

  async listOpportunities({ statuses, tier, limit }: Parameters<PlatformStore["listOpportunities"]>[0]) {
    const rows = await this.db.query(
      `select * from opportunities
       where ($1::text::jsonb is null or $1::text::jsonb ? status) and ($2::int is null or liquidity_tier = $2::int)
       order by score desc, created_at desc, id limit $3::int`,
      [statuses ? J(statuses) : null, tier ?? null, limit],
    );
    return rows.map(toOpportunity);
  }

  async transitionOpportunity(...[id, from, to, actor, decision, note]: Parameters<PlatformStore["transitionOpportunity"]>) {
    checkTransition(from, to, actor, decision);
    if (!UUID.test(id)) return null;
    const entries = transitionEntries(id, from, to, actor, decision, note);
    return this.db.tx(async (db) => {
      const [r] = await db.query(`update opportunities set status = $3, updated_at = now(), status_changed_at = now() where id = $1::uuid and status = $2 returning *`, [id, from, to]);
      if (!r) return null;
      await insertEntries(db, entries);
      return toOpportunity(r);
    });
  }

  async lastTerminalAt(key: string) {
    const [r] = await this.db.query<{ at: unknown }>(`select max(status_changed_at) as at from opportunities where dedupe_key = $1 and status in (${TERMINAL_SQL})`, [key]);
    return r?.at == null ? null : new Date(r.at as string);
  }

  async setOpportunityCosts(id: string, c: LedgerPayload<"costs">) {
    if (!UUID.test(id)) return null;
    const entry = parseEntry({ opportunityId: id, kind: "costs", payload: c });
    const { grossEdgeBps, netEdgeBps, edgeBasis, ...costs } = c;
    return this.db.tx(async (db) => {
      const [r] = await db.query(
        `update opportunities set costs = $2::text::jsonb, gross_edge_bps = $3::float8, net_edge_bps = $4::float8, edge_basis = $5, updated_at = now()
         where id = $1::uuid and status in (${PRE_SQL}) returning *`,
        [id, J(costs), grossEdgeBps, netEdgeBps, edgeBasis],
      );
      if (!r) return null;
      await insertEntries(db, [entry]);
      return toOpportunity(r);
    });
  }

  async snoozeOpportunity(id: string, until: string | null) {
    if (!UUID.test(id)) return null;
    const [r] = await this.db.query(`update opportunities set snoozed_until = $2::timestamptz, updated_at = now() where id = $1::uuid returning *`, [id, isoOrNull(until)]);
    return r ? toOpportunity(r) : null;
  }

  async appendLedger(e: Extract<NewLedgerEntry, { kind: "research" | "outcome" }>) {
    if (e.kind !== "research" && e.kind !== "outcome") throw new Error(`appendLedger takes research or outcome, not ${(e as NewLedgerEntry).kind}`);
    const entry = parseEntry(e);
    if (!(await this.getOpportunity(e.opportunityId))) throw new Error(`unknown opportunity ${e.opportunityId}`);
    const [row] = await insertEntries(this.db, [entry], e.kind === "outcome");
    return row ?? null;
  }

  async ledgerFor(opportunityId: string) {
    if (!UUID.test(opportunityId)) return [];
    return (await this.db.query(`select * from ledger_entries where opportunity_id = $1::uuid order by id`, [opportunityId])).map(toEntry);
  }

  async outcomeRows({ setupKind, regime, tier }: Parameters<PlatformStore["outcomeRows"]>[0]) {
    const rows = await this.db.query<any>(
      `select o.id, o.created_at as opp_created_at, o.setup_kind, o.regime, o.score_version, o.liquidity_tier, (o.costs is not null) as has_costs, l.payload from ledger_entries l join opportunities o on o.id = l.opportunity_id
       where l.kind = 'outcome' and ($1::text is null or o.setup_kind = $1) and ($2::text is null or o.regime = $2) and ($3::int is null or o.liquidity_tier = $3::int)
       order by l.id`,
      [setupKind ?? null, regime ?? null, tier ?? null],
    );
    return rows.map((r): OutcomeRow => ({
      opportunityId: r.id, setupKind: r.setup_kind, regime: r.regime, scoreVersion: r.score_version, liquidityTier: r.liquidity_tier,
      horizon: r.payload.horizon, createdAtMs: new Date(r.opp_created_at).getTime(), grossReturn: r.payload.grossReturn, netReturn: r.payload.netReturn, hasCosts: Boolean(r.has_costs),
    }));
  }
}
