import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { databaseUrl, sql as client } from "../db.js";
import { historyEntry } from "../../shared/regime/build.js";
import { RegimeHistorySchema, RegimeThesisSchema } from "../../shared/regime/schema.js";
import type { HistoryEntry, RegimeThesis } from "../../shared/regime/types.js";

// Where the regime thesis lives (docs/REGIME.md). Three RegimeStore twins with one contract (store.test.ts):
//   pg      db/migrations/030_regime_thesis.sql: regime_theses (every version, the last REGIME_VERSIONS_KEPT),
//           regime_history (one changelog row per version, plus seeded rows), regime_seen (report ids already read),
//           regime_lock (one row while a rewrite runs)
//   file    one JSON file (REGIME_STORE_FILE, or ~/.hypertrade/regime.json with REGIME_LOCAL=1): local runs, no database
//   memory  tests, and a deployment with neither (the route then says it keeps nothing)
// Every thesis and history row is parsed again on the way out; a row that fails to parse is skipped, never served.

export const REGIME_VERSIONS_KEPT = 60;
export const REGIME_HISTORY_KEPT = 400;
export const REGIME_SEEN_KEPT = 1000;
export const REGIME_LOCK_STALE_MS = 10 * 60_000;

export interface RegimeStore {
  readonly kind: "pg" | "file" | "memory";
  /** The current version (the last one saved), or null before the first. */
  thesis(): Promise<RegimeThesis | null>;
  /** Full versions, newest saved first. */
  versions(limit?: number): Promise<RegimeThesis[]>;
  /** The changelog, newest first. */
  history(limit?: number): Promise<HistoryEntry[]>;
  /** Evidence ids already read, so a report counts as new once. */
  seen(): Promise<Set<string>>;
  /** The new version becomes current; its changelog row (plus any seeded rows) joins the history. */
  save(t: RegimeThesis, extraHistory?: HistoryEntry[]): Promise<void>;
  remember(ids: string[], at: Date): Promise<void>;
  /** True when this caller now holds the rewrite lock (a lock older than REGIME_LOCK_STALE_MS is taken over). */
  lock(now: Date): Promise<boolean>;
  unlock(): Promise<void>;
}

const parseThesis = (v: unknown): RegimeThesis | null => {
  const r = RegimeThesisSchema.safeParse(v);
  return r.success ? r.data : null;
};
const parseHistory = (v: unknown): HistoryEntry | null => {
  const r = RegimeHistorySchema.safeParse(v);
  return r.success ? r.data : null;
};
const byCreatedDesc = (a: HistoryEntry, b: HistoryEntry) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? 1 : -1);

// ---------------------------------------------------------------- memory and file

interface State {
  /** Newest saved first. */
  theses: unknown[];
  history: unknown[];
  /** Newest first. */
  seen: string[];
  lock: string | null;
}
const emptyState = (): State => ({ theses: [], history: [], seen: [], lock: null });

function localStore(kind: "file" | "memory", load: () => Promise<State>, mutate: <T>(fn: (s: State) => T) => Promise<T>): RegimeStore {
  const versions = async (limit = REGIME_VERSIONS_KEPT) =>
    (await load()).theses
      .map(parseThesis)
      .filter((t): t is RegimeThesis => t !== null)
      .slice(0, limit);
  return {
    kind,
    thesis: async () => (await versions(1))[0] ?? null,
    versions,
    history: async (limit = REGIME_HISTORY_KEPT) =>
      (await load()).history
        .map(parseHistory)
        .filter((h): h is HistoryEntry => h !== null)
        .sort(byCreatedDesc)
        .slice(0, limit),
    seen: async () => new Set((await load()).seen),
    save: (t, extra = []) =>
      mutate((s) => {
        s.theses = [t, ...s.theses.filter((x) => (x as { id?: unknown })?.id !== t.id)].slice(0, REGIME_VERSIONS_KEPT);
        const rows = [historyEntry(t), ...extra];
        const ids = new Set(rows.map((r) => r.id));
        s.history = [...rows, ...s.history.filter((h) => !ids.has((h as { id?: string })?.id ?? ""))]
          .map(parseHistory)
          .filter((h): h is HistoryEntry => h !== null)
          .sort(byCreatedDesc)
          .slice(0, REGIME_HISTORY_KEPT);
      }),
    remember: (ids) =>
      mutate((s) => {
        if (!ids.length) return;
        const fresh = new Set(ids);
        s.seen = [...fresh, ...s.seen.filter((k) => !fresh.has(k))].slice(0, REGIME_SEEN_KEPT);
      }),
    lock: (now) =>
      mutate((s) => {
        if (s.lock && now.getTime() - Date.parse(s.lock) < REGIME_LOCK_STALE_MS) return false;
        s.lock = now.toISOString();
        return true;
      }),
    unlock: () =>
      mutate((s) => {
        s.lock = null;
      }),
  };
}

export function memoryRegimeStore(): RegimeStore {
  const state = emptyState();
  return localStore("memory", async () => state, async (fn) => fn(state));
}

function parseState(text: string): State | null {
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && Array.isArray(raw.theses) && Array.isArray(raw.history)) {
      return { theses: raw.theses, history: raw.history, seen: Array.isArray(raw.seen) ? raw.seen.filter((k: unknown) => typeof k === "string") : [], lock: typeof raw.lock === "string" ? raw.lock : null };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * One JSON file. A missing file starts empty; a corrupt one makes every call throw and is left as it is (the changelog
 * is the point of the store: it never restarts empty over a damaged file). Each mutation re-reads the file, applies its
 * change and writes atomically (tmp + rename), one at a time within the process.
 */
export function fileRegimeStore(path: string): RegimeStore {
  let writing: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<State> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
    const s = parseState(text);
    if (s) return s;
    throw new Error(`regime store file ${path} is corrupt; fix or remove it by hand (the store will not start empty)`);
  };
  const mutate = <T>(fn: (s: State) => T): Promise<T> => {
    const next = writing
      .catch(() => {})
      .then(async () => {
        const s = await read();
        const out = fn(s);
        const tmp = `${path}.${process.pid}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, JSON.stringify({ version: 1, ...s }));
        await rename(tmp, path);
        return out;
      });
    writing = next;
    return next;
  };
  return localStore("file", read, mutate);
}

// ---------------------------------------------------------------- postgres

type Sql = ReturnType<typeof client>;

export function pgRegimeStore(sql: () => Sql = client): RegimeStore {
  const json = (v: unknown) => sql().json(v as never);
  const versions = async (limit = REGIME_VERSIONS_KEPT) => {
    const rows = await sql()`select doc from regime_theses order by saved_at desc, version desc limit ${limit}`;
    return rows.map((r) => parseThesis(r.doc)).filter((t): t is RegimeThesis => t !== null);
  };
  return {
    kind: "pg",
    thesis: async () => (await versions(1))[0] ?? null,
    versions,
    history: async (limit = REGIME_HISTORY_KEPT) => {
      const rows = await sql()`select entry from regime_history order by created desc, id desc limit ${limit}`;
      return rows.map((r) => parseHistory(r.entry)).filter((h): h is HistoryEntry => h !== null);
    },
    seen: async () => new Set((await sql()`select key from regime_seen order by seen_at desc limit ${REGIME_SEEN_KEPT}`).map((r) => String(r.key))),
    save: async (t, extra = []) => {
      const rows = [historyEntry(t), ...extra];
      await sql().begin(async (tx) => {
        await tx`insert into regime_theses (id, version, created, doc) values (${t.id}, ${t.version}, ${t.created}::timestamptz, ${json(t)})
                 on conflict (id) do update set version = excluded.version, created = excluded.created, doc = excluded.doc, saved_at = now()`;
        for (const h of rows) {
          await tx`insert into regime_history (id, created, entry) values (${h.id}, ${h.created}::timestamptz, ${json(h)})
                   on conflict (id) do update set created = excluded.created, entry = excluded.entry`;
        }
        await tx`delete from regime_theses where id not in (select id from regime_theses order by saved_at desc, version desc limit ${REGIME_VERSIONS_KEPT})`;
        await tx`delete from regime_history where id not in (select id from regime_history order by created desc, id desc limit ${REGIME_HISTORY_KEPT})`;
      });
    },
    remember: async (ids, at) => {
      if (!ids.length) return;
      const rows = [...new Set(ids)].map((key) => ({ key, seen_at: at.toISOString() }));
      await sql()`insert into regime_seen ${sql()(rows, "key", "seen_at")} on conflict (key) do update set seen_at = excluded.seen_at`;
    },
    lock: async (now) => {
      const stale = new Date(now.getTime() - REGIME_LOCK_STALE_MS).toISOString();
      const rows = await sql()`insert into regime_lock (name, started_at) values ('rewrite', ${now.toISOString()}::timestamptz)
                               on conflict (name) do update set started_at = excluded.started_at where regime_lock.started_at < ${stale}::timestamptz
                               returning name`;
      return rows.length === 1;
    },
    unlock: async () => {
      await sql()`delete from regime_lock where name = 'rewrite'`;
    },
  };
}

// ---------------------------------------------------------------- selection

const singletons = new Map<string, RegimeStore>();

export const localRegimeFile = () => join(homedir(), ".hypertrade", "regime.json");

/**
 * Postgres when a database URL is set; else the file at REGIME_STORE_FILE, or ~/.hypertrade/regime.json when
 * REGIME_LOCAL=1; else memory (which keeps nothing past the process). One instance per choice, per process.
 */
export function defaultRegimeStore(env: Record<string, string | undefined> = process.env): RegimeStore {
  const file = env.REGIME_STORE_FILE?.trim() || (env.REGIME_LOCAL === "1" ? localRegimeFile() : null);
  const key = databaseUrl(env) ? "pg" : file ? `file:${file}` : "memory";
  let store = singletons.get(key);
  if (!store) {
    store = key === "pg" ? pgRegimeStore() : file ? fileRegimeStore(file) : memoryRegimeStore();
    singletons.set(key, store);
  }
  return store;
}
