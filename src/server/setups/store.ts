import { isOpenSetup as isOpen, OPEN_STATUSES, SetupSchema, type Ledger, type Setup } from "../../shared/setups.js";
import type { Db } from "../platform/store-pg.js";
import { CLOSED_RETENTION_MS, settleLedger } from "../routine/ledger.js";

// Setups ledger persistence (db/migrations/021_setups.sql). MemorySetupStore
// in tests and runs without a database, PgSetupStore in the app; store.test.ts
// runs one scenario through both and compares. Status and R are decided by
// src/server/routine/ledger.ts; the store only keeps what it is given.

export interface SetupStore {
  /** Inserts or replaces by id. Every row is zod-parsed first; within one call the last row for an id wins. */
  save(setups: Setup[]): Promise<void>;
  get(id: string): Promise<Setup | null>;
  /** Watching and triggered setups, oldest created first. */
  open(): Promise<Setup[]>;
  /** Closed setups updated at or after `since`, newest first. */
  closedSince(since: string): Promise<Setup[]>;
}

/** Parses each row and keeps the last one per id, in first-seen order. */
export function prepare(setups: Setup[]): Setup[] {
  const last = new Map<string, Setup>();
  for (const s of setups) last.set(s.id, SetupSchema.parse(s));
  return [...last.values()];
}

/** The data/setups/ledger.json shape: open setups plus closed ones within the 90-day retention, with stats. */
export async function exportLedger(store: SetupStore, now: Date): Promise<Ledger> {
  const since = new Date(now.getTime() - CLOSED_RETENTION_MS).toISOString();
  const [open, closed] = await Promise.all([store.open(), store.closedSince(since)]);
  return settleLedger(open, closed, now);
}

const ms = (iso: string) => Date.parse(iso);
/** Byte order, matching `collate "C"` in PgSetupStore. */
const byId = (a: Setup, b: Setup) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class MemorySetupStore implements SetupStore {
  readonly rows = new Map<string, Setup>();

  async save(setups: Setup[]) {
    for (const s of prepare(setups)) this.rows.set(s.id, structuredClone(s));
  }

  async get(id: string) {
    const s = this.rows.get(id);
    return s ? structuredClone(s) : null;
  }

  async open() {
    return [...this.rows.values()].filter(isOpen).sort((a, b) => ms(a.created_at) - ms(b.created_at) || byId(a, b)).map((s) => structuredClone(s));
  }

  async closedSince(since: string) {
    const from = ms(since);
    return [...this.rows.values()]
      .filter((s) => !isOpen(s) && ms(s.updated_at) >= from)
      .sort((a, b) => ms(b.updated_at) - ms(a.updated_at) || byId(a, b))
      .map((s) => structuredClone(s));
  }
}

/** Fixed enum values as SQL literals (not input). */
const OPEN_SQL = OPEN_STATUSES.map((s) => `'${s}'`).join(", ");
const toSetup = (r: { body: unknown }) => SetupSchema.parse(r.body);

export class PgSetupStore implements SetupStore {
  constructor(private readonly db: Db) {}

  async save(setups: Setup[]) {
    const rows = prepare(setups);
    if (!rows.length) return;
    // jsonb goes in as text and is cast in SQL (db.ts runs with fetch_types off; see 020_platform_jsonb_repair.sql).
    await this.db.query(
      `insert into setups (id, setup_id, asset, direction, status, created_at, updated_at, body)
       select e.v->>'id', e.v->>'setup_id', e.v->>'asset', e.v->>'direction', e.v->>'status',
              (e.v->>'created_at')::timestamptz, (e.v->>'updated_at')::timestamptz, e.v
       from jsonb_array_elements($1::text::jsonb) as e(v)
       on conflict (id) do update set setup_id = excluded.setup_id, asset = excluded.asset, direction = excluded.direction,
         status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at, body = excluded.body`,
      [JSON.stringify(rows)],
    );
  }

  async get(id: string) {
    const [r] = await this.db.query<{ body: unknown }>(`select body from setups where id = $1`, [id]);
    return r ? toSetup(r) : null;
  }

  async open() {
    return (await this.db.query<{ body: unknown }>(`select body from setups where status in (${OPEN_SQL}) order by created_at, id collate "C"`)).map(toSetup);
  }

  async closedSince(since: string) {
    return (
      await this.db.query<{ body: unknown }>(`select body from setups where status not in (${OPEN_SQL}) and updated_at >= $1::timestamptz order by updated_at desc, id collate "C"`, [since])
    ).map(toSetup);
  }
}
