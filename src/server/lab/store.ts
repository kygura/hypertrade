import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { databaseUrl, sql } from "../db.js";
import type { CatalogueEntry, Direction, SearchConfig, SearchResult } from "./types.js";

// Lab persistence (db/migrations/004_lab.sql). Three LabStore implementations:
// Postgres (deployed), in-memory (no DB), and a JSON file (local CLI/stdio).
// defaultStore() picks one from the environment.

export type RunSource = "api" | "mcp" | "cli" | "ui";

export interface StoredRun {
  id: string;
  createdAt: string;
  source: RunSource;
  config: SearchConfig;
  status: "ok" | "error";
  error: string | null;
  result: SearchResult | null;
  durationMs: number | null;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  source: RunSource;
  status: "ok" | "error";
  asset: string;
  direction: Direction;
  horizonDays: number;
  metrics: number;
  rules: number;
  bestSharpe: number | null;
  error: string | null;
}

export type NewRun = Omit<StoredRun, "id" | "createdAt">;
export type NewCatalogueEntry = Omit<CatalogueEntry, "savedAt"> & { savedAt?: string };
export type CatalogueFilter = { asset?: string; direction?: Direction };

export interface LabStore {
  readonly kind: "pg" | "memory" | "file";
  saveRun(r: NewRun): Promise<StoredRun>;
  /** null for an unknown or malformed id. */
  getRun(id: string): Promise<StoredRun | null>;
  /** Newest first. */
  listRuns(limit: number): Promise<RunSummary[]>;
  /** Active (not archived) entries, newest savedAt first. */
  listCatalogue(filter?: CatalogueFilter): Promise<CatalogueEntry[]>;
  getCatalogueEntry(id: string): Promise<CatalogueEntry | null>;
  /**
   * Upsert by id. Re-saving updates name/note and un-archives, but keeps the
   * original savedAt, evaluation, origin and run: the live window starts at
   * the first save.
   */
  saveCatalogueEntry(e: NewCatalogueEntry): Promise<CatalogueEntry>;
  /** false when there was no active entry with that id. */
  archiveCatalogueEntry(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------- helpers

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);
/** Rule ids are hashes; anything printable and short is accepted. */
export const isRuleId = (s: unknown): s is string => typeof s === "string" && /^[\w.:-]{1,128}$/.test(s);

/** Runs kept by the memory and file stores; older ones are dropped. */
export const LOCAL_RUN_CAP = 200;
/** Runs kept in Postgres; older ones are pruned on insert. */
export const PG_RUN_CAP = 500;

const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

function checkEntry(e: NewCatalogueEntry) {
  if (!isRuleId(e.id)) throw new Error(`invalid rule id: ${JSON.stringify(e.id)}`);
  if (e.runId != null && !isUuid(e.runId)) throw new Error(`invalid run id: ${JSON.stringify(e.runId)}`);
  if (e.savedAt !== undefined && Number.isNaN(Date.parse(e.savedAt))) throw new Error(`invalid savedAt: ${e.savedAt}`);
}

function bestSharpe(result: SearchResult | null): number | null {
  const top = result?.rules[0];
  // Walk-forward only: an in-sample number under a WF label would overstate the run.
  return top?.walkForward?.sharpe ?? null;
}

/** Summary of a full run. Exported for tests. */
export function summarize(r: StoredRun): RunSummary {
  return {
    id: r.id,
    createdAt: r.createdAt,
    source: r.source,
    status: r.status,
    asset: r.config.asset,
    direction: r.config.direction,
    horizonDays: r.config.horizonDays,
    metrics: r.config.metrics.length,
    rules: r.result?.rules.length ?? 0,
    bestSharpe: bestSharpe(r.result),
    error: r.error,
  };
}

// ---------------------------------------------------------------- postgres

/** Pure row mappers for lab_runs / lab_rules. Exported for tests. */
export function toStoredRun(r: any): StoredRun {
  return {
    id: r.id,
    createdAt: iso(r.created_at)!,
    source: r.source,
    config: r.config,
    status: r.status,
    error: r.error ?? null,
    result: r.result ?? null,
    durationMs: r.duration_ms ?? null,
  };
}

export function toRunSummary(r: any): RunSummary {
  return {
    id: r.id,
    createdAt: iso(r.created_at)!,
    source: r.source,
    status: r.status,
    asset: r.asset,
    direction: r.direction,
    horizonDays: Number(r.horizon_days ?? 0),
    metrics: Number(r.metrics ?? 0),
    rules: Number(r.rules ?? 0),
    bestSharpe: r.best_sharpe == null ? null : Number(r.best_sharpe),
    error: r.error ?? null,
  };
}

export function toCatalogueEntry(r: any): CatalogueEntry {
  return {
    id: r.id,
    name: r.name,
    note: r.note ?? null,
    origin: r.origin,
    runId: r.run_id ?? null,
    rule: r.rule,
    saved: r.saved,
    savedAt: iso(r.saved_at)!,
  };
}

export function pgStore(): LabStore {
  const json = (v: unknown) => sql().json(v as never);
  return {
    kind: "pg",
    async saveRun(r) {
      const [row] = await sql()`
        insert into lab_runs (source, config, status, error, result, duration_ms)
        values (${r.source}, ${json(r.config)}, ${r.status}, ${r.error}, ${r.result == null ? null : json(r.result)}, ${r.durationMs})
        returning *`;
      // Keep the newest PG_RUN_CAP; saved rules keep their evaluation (run_id goes null).
      await sql()`delete from lab_runs where id in (select id from lab_runs order by created_at desc offset ${PG_RUN_CAP})`;
      return toStoredRun(row);
    },
    async getRun(id) {
      if (!isUuid(id)) return null;
      const [row] = await sql()`select * from lab_runs where id = ${id}`;
      return row ? toStoredRun(row) : null;
    },
    async listRuns(limit) {
      const rows = await sql()`
        select id, created_at, source, status, error,
               config->>'asset' as asset, config->>'direction' as direction,
               (config->>'horizonDays')::int as horizon_days,
               coalesce(jsonb_array_length(config->'metrics'), 0) as metrics,
               coalesce(jsonb_array_length(result->'rules'), 0) as rules,
               (result->'rules'->0->'walkForward'->>'sharpe')::float8 as best_sharpe
        from lab_runs order by created_at desc limit ${Math.max(0, Math.floor(limit))}`;
      return rows.map(toRunSummary);
    },
    async listCatalogue(filter = {}) {
      const db = sql();
      const rows = await db`
        select * from lab_rules where archived_at is null
          ${filter.asset ? db`and asset = ${filter.asset}` : db``}
          ${filter.direction ? db`and direction = ${filter.direction}` : db``}
        order by saved_at desc`;
      return rows.map(toCatalogueEntry);
    },
    async getCatalogueEntry(id) {
      if (!isRuleId(id)) return null;
      const [row] = await sql()`select * from lab_rules where id = ${id} and archived_at is null`;
      return row ? toCatalogueEntry(row) : null;
    },
    async saveCatalogueEntry(e) {
      checkEntry(e);
      const [row] = await sql()`
        insert into lab_rules (id, name, note, origin, run_id, asset, direction, rule, saved, saved_at)
        values (${e.id}, ${e.name}, ${e.note}, ${e.origin}, ${e.runId}, ${e.rule.asset}, ${e.rule.direction},
                ${json(e.rule)}, ${json(e.saved)}, coalesce(${e.savedAt ?? null}::timestamptz, now()))
        on conflict (id) do update set name = excluded.name, note = excluded.note, archived_at = null
        returning *`;
      return toCatalogueEntry(row);
    },
    async archiveCatalogueEntry(id) {
      if (!isRuleId(id)) return false;
      const res = await sql()`update lab_rules set archived_at = now() where id = ${id} and archived_at is null`;
      return res.count > 0;
    },
  };
}

// ---------------------------------------------------------------- memory / file

type StoredRule = CatalogueEntry & { archivedAt: string | null };
interface State {
  runs: StoredRun[]; // insertion order, oldest first
  rules: StoredRule[];
}

const emptyState = (): State => ({ runs: [], rules: [] });
const entryOf = ({ archivedAt: _a, ...e }: StoredRule): CatalogueEntry => structuredClone(e);

/**
 * The shared in-process implementation. `load` resolves the state (lazily for
 * the file store); `persist` runs after every mutation.
 */
function localStore(
  kind: "memory" | "file",
  load: () => Promise<State>,
  persist: (s: State) => Promise<void>,
  clock: () => Date,
): LabStore {
  return {
    kind,
    async saveRun(r) {
      const s = await load();
      const run: StoredRun = structuredClone({ ...r, id: crypto.randomUUID(), createdAt: clock().toISOString() });
      s.runs.push(run);
      if (s.runs.length > LOCAL_RUN_CAP) s.runs.splice(0, s.runs.length - LOCAL_RUN_CAP);
      await persist(s);
      return structuredClone(run);
    },
    async getRun(id) {
      if (!isUuid(id)) return null;
      const run = (await load()).runs.find((r) => r.id === id);
      return run ? structuredClone(run) : null;
    },
    async listRuns(limit) {
      const runs = (await load()).runs;
      return runs.slice().reverse().slice(0, Math.max(0, Math.floor(limit))).map(summarize);
    },
    async listCatalogue(filter = {}) {
      return (await load()).rules
        .filter((e) => !e.archivedAt)
        .filter((e) => !filter.asset || e.rule.asset === filter.asset)
        .filter((e) => !filter.direction || e.rule.direction === filter.direction)
        .reverse() // newest insert first among equal savedAt (sort is stable)
        .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))
        .map(entryOf);
    },
    async getCatalogueEntry(id) {
      const e = (await load()).rules.find((r) => r.id === id && !r.archivedAt);
      return e ? entryOf(e) : null;
    },
    async saveCatalogueEntry(e) {
      checkEntry(e);
      const s = await load();
      const cur = s.rules.find((r) => r.id === e.id);
      let out: StoredRule;
      if (cur) {
        Object.assign(cur, { name: e.name, note: e.note, archivedAt: null });
        out = cur;
      } else {
        const { savedAt, ...rest } = e;
        out = structuredClone({ ...rest, savedAt: new Date(savedAt ?? clock()).toISOString(), archivedAt: null });
        s.rules.push(out);
      }
      await persist(s);
      return entryOf(out);
    },
    async archiveCatalogueEntry(id) {
      const s = await load();
      const cur = s.rules.find((r) => r.id === id && !r.archivedAt);
      if (!cur) return false;
      cur.archivedAt = clock().toISOString();
      await persist(s);
      return true;
    },
  };
}

export function memoryStore(clock: () => Date = () => new Date()): LabStore {
  const state = emptyState();
  return localStore("memory", async () => state, async () => {}, clock);
}

function parseState(text: string): State | null {
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && Array.isArray(raw.runs) && Array.isArray(raw.rules)) {
      return { runs: raw.runs, rules: raw.rules };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Memory store backed by a JSON file. Loaded on first use; a missing file
 * starts empty, a corrupt one is moved to `<path>.bak` and the store starts
 * empty. Every mutation rewrites the file atomically (tmp + rename).
 */
export function fileStore(path: string, clock: () => Date = () => new Date()): LabStore {
  let loading: Promise<State> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const load = () =>
    (loading ??= (async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
        throw err;
      }
      const state = parseState(text);
      if (state) return state;
      await rename(path, `${path}.bak`);
      return emptyState();
    })().catch((err) => {
      loading = null; // retry on the next call
      throw err;
    }));

  const persist = (s: State) => {
    const body = JSON.stringify({ version: 1, runs: s.runs, rules: s.rules });
    const tmp = `${path}.${process.pid}.tmp`;
    // Chained so concurrent mutations never interleave their tmp writes.
    writing = writing
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, body);
        await rename(tmp, path);
      });
    return writing;
  };

  return localStore("file", load, persist, clock);
}

// ---------------------------------------------------------------- selection

const singletons = new Map<string, LabStore>();

/** The default local file, used when LAB_LOCAL=1. */
export const localLabFile = () => join(homedir(), ".hypertrade", "lab.json");

/**
 * Postgres when a database URL is set; else a file store at LAB_STORE_FILE,
 * or at ~/.hypertrade/lab.json when LAB_LOCAL=1; else an in-memory store.
 * One instance per choice, per process.
 */
export function defaultStore(env: Record<string, string | undefined> = process.env): LabStore {
  const file = env.LAB_STORE_FILE || (env.LAB_LOCAL === "1" ? localLabFile() : null);
  const key = databaseUrl(env) ? "pg" : file ? `file:${file}` : "memory";
  let store = singletons.get(key);
  if (!store) {
    store = key === "pg" ? pgStore() : file ? fileStore(file) : memoryStore();
    singletons.set(key, store);
  }
  return store;
}
