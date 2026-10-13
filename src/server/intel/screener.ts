import postgres from "postgres";
import type { ZodType } from "zod";
import { SCREENER_TABLES, ScreenerDslSchema, type QueryResult, type ScreenerDsl, type ScreenerSource } from "../../shared/intel.js";
import { databaseUrl, sql as mainSql } from "../db.js";
import { completeStructured, type LlmDeps, type LlmTrace } from "./llm.js";

// NL screener (SPEC.md § Intel I0.17). The strong model turns a question into
// the screener DSL (ScreenerDslSchema is the authority); compile() turns the
// DSL into one parameterized SELECT. Identifiers only ever come from the
// SCREENER_TABLES allowlist (looked up, never echoed from input); every value
// is a $n parameter. runQuery executes it in a read-only transaction with a
// 5 s statement timeout, on DATABASE_URL_READONLY when set.
//
// `changes` semantics: percent change of a numeric column between each row
// and the latest row of the same series (same text-column key: asset/coin,
// +tf for candles, series_id for observations) at least window_h earlier and
// no more than 2·window_h earlier — (now − then) / then × 100. Rows without
// such a baseline (or a zero one) drop out. Change columns are returned as
// `<col>_chg_<window>h`.
//
// Example — "funding flipped negative while OI rose 20% in 7 days":
//   { "source": "snapshots", "select": ["asset", "ts", "funding", "oi_usd"],
//     "filters": [{ "col": "funding", "op": "<", "value": 0 }],
//     "changes": [{ "col": "funding", "window_h": 168, "op": "<", "pct": -100 },
//                 { "col": "oi_usd", "window_h": 168, "op": ">", "pct": 20 }],
//     "since_h": 1, "orderBy": { "col": "oi_usd", "dir": "desc" }, "limit": 100 }
// With funding < 0 now, a change below −100% means the baseline was positive:
// the sign flipped. since_h = 1 keeps roughly the latest snapshots.

export const SCREENER_PROMPT_VERSION = "screener.v1";
export const MAX_ROWS = 500;
/** Hours of data one query may read: since_h plus twice the longest change window. */
export const MAX_RANGE_H = 90 * 24;
export const STATEMENT_TIMEOUT = "5s";

const TABLE_SQL: Record<ScreenerSource, string> = {
  snapshots: "intel_snapshots",
  funding: "funding",
  candles: "candles",
  observations: "observations",
};
const OPS = { "=": "=", "!=": "<>", ">": ">", ">=": ">=", "<": "<", "<=": "<=" } as const;

export class CompileError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export type SqlParam = string | number;
export interface Compiled {
  sql: string;
  params: SqlParam[];
  columns: string[];
}

type ColKind = "num" | "text" | "ts";

/** Compiles a parsed DSL to one SELECT. Pure; throws CompileError on anything outside the allowlist or the caps. */
export function compile(dsl: ScreenerDsl): Compiled {
  if (!Object.prototype.hasOwnProperty.call(TABLE_SQL, dsl.source)) throw new CompileError(`unknown source: ${String(dsl.source)}`, "source");
  const source = dsl.source;
  const table = SCREENER_TABLES[source];
  const cols = table.cols as Record<string, ColKind>;
  const tableSql = TABLE_SQL[source];
  /** The allowlist's own spelling of a column, quoted; never the input string. */
  const col = (name: string, field: string, kinds?: ColKind[]): string => {
    const key = Object.keys(cols).find((k) => k === name);
    if (!key || (kinds && !kinds.includes(cols[key]!))) throw new CompileError(`column not allowed for ${source}: ${String(name).slice(0, 40)}`, field);
    return key;
  };
  const q = (alias: string, key: string) => `${alias}."${key}"`;
  const op = (o: string, field: string): string => {
    if (!Object.prototype.hasOwnProperty.call(OPS, o)) throw new CompileError(`operator not allowed: ${String(o).slice(0, 10)}`, field);
    return OPS[o as keyof typeof OPS];
  };
  const int = (v: unknown, lo: number, hi: number, field: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new CompileError(`${field} must be an integer ${lo}–${hi}`, field);
    return v;
  };

  const params: SqlParam[] = [];
  const p = (v: SqlParam, cast: "float8" | "int" | "text") => {
    if (typeof v === "number" && !Number.isFinite(v)) throw new CompileError("non-finite number");
    params.push(v);
    return `$${params.length}::${cast}`;
  };

  const sinceH = int(dsl.since_h, 1, MAX_RANGE_H, "since_h");
  const limit = int(dsl.limit, 1, MAX_ROWS, "limit");
  const changes = dsl.changes ?? [];
  const maxWindow = Math.max(0, ...changes.map((c, i) => int(c.window_h, 1, MAX_RANGE_H, `changes.${i}.window_h`)));
  if (sinceH + 2 * maxWindow > MAX_RANGE_H) throw new CompileError(`range too long: since_h + 2 × window_h must be ≤ ${MAX_RANGE_H} h (90 days)`, "since_h");

  if (!dsl.select?.length || dsl.select.length > 20) throw new CompileError("select 1–20 columns", "select");
  const select = dsl.select.map((c, i) => col(c, `select.${i}`));
  const columns = [...select];
  const out = select.map((k) => q("t", k));
  const joins: string[] = [];
  const where: string[] = [`${q("t", "ts")} >= now() - make_interval(hours => ${p(sinceH, "int")})`];

  if (dsl.assets?.length) {
    if (!table.assetCol) throw new CompileError(`${source} has no asset column`, "assets");
    const ac = col(table.assetCol, "assets", ["text"]);
    where.push(`${q("t", ac)} in (${dsl.assets.map((a) => p(String(a), "text")).join(", ")})`);
  }

  (dsl.filters ?? []).forEach((f, i) => {
    const key = col(f.col, `filters.${i}.col`, ["num", "text"]);
    const kind = cols[key]!;
    const o = op(f.op, `filters.${i}.op`);
    if (kind === "num") {
      if (typeof f.value !== "number") throw new CompileError("numeric column needs a number", `filters.${i}.value`);
      where.push(`${q("t", key)} ${o} ${p(f.value, "float8")}`);
    } else {
      if (typeof f.value !== "string" || (o !== "=" && o !== "<>")) throw new CompileError("text column takes = or != with a string", `filters.${i}`);
      where.push(`${q("t", key)} ${o} ${p(f.value, "text")}`);
    }
  });

  // Series key for change baselines: every text column of the table (asset/coin, tf, series_id).
  const keyCols = Object.keys(cols).filter((k) => cols[k] === "text");
  changes.forEach((c, i) => {
    const key = col(c.col, `changes.${i}.col`, ["num"]);
    const o = op(c.op, `changes.${i}.op`);
    if (o === "=" || o === "<>") throw new CompileError("change takes > >= < <=", `changes.${i}.op`);
    const alias = `c${i}`;
    const w = p(c.window_h, "int");
    const sameSeries = keyCols.map((k) => `${q("b", k)} = ${q("t", k)}`).join(" and ");
    joins.push(
      `cross join lateral (select ${q("b", key)} as v from ${tableSql} b where ${sameSeries}` +
        ` and ${q("b", "ts")} <= ${q("t", "ts")} - make_interval(hours => ${w})` +
        ` and ${q("b", "ts")} >= ${q("t", "ts")} - make_interval(hours => 2 * ${w})` +
        ` order by ${q("b", "ts")} desc limit 1) ${alias}`,
    );
    const expr = `(${q("t", key)} - ${alias}.v) / nullif(${alias}.v, 0) * 100`;
    const name = `${key}_chg_${c.window_h}h`;
    out.push(`${expr} as "${name}"`);
    columns.push(name);
    where.push(`${expr} ${o} ${p(c.pct, "float8")}`);
  });

  const order = dsl.orderBy
    ? `${q("t", col(dsl.orderBy.col, "orderBy.col"))} ${dsl.orderBy.dir === "asc" ? "asc" : "desc"} nulls last, ${q("t", "ts")} desc`
    : `${q("t", "ts")} desc`;

  const text = [
    `select ${out.join(", ")}`,
    `from ${tableSql} t`,
    ...joins,
    `where ${where.join("\n  and ")}`,
    `order by ${order}`,
    `limit ${p(limit, "int")}`,
  ].join("\n");
  return { sql: text, params, columns };
}

// ---------------------------------------------------------------- execution

type Row = Record<string, unknown>;
export interface ReadTx {
  unsafe(query: string, params?: SqlParam[]): PromiseLike<Row[] & { columns?: ReadonlyArray<{ name: string }> }>;
}
/** The slice of postgres.js runQuery uses; tests inject a fake. */
export interface ReadClient {
  begin<T>(mode: string, fn: (tx: ReadTx) => Promise<T>): Promise<T>;
}

function fromPostgres(s: postgres.Sql): ReadClient {
  return { begin: (mode, fn) => s.begin(mode, (tx) => fn(tx as unknown as ReadTx)) as Promise<never> };
}

let readonlyClient: ReadClient | null = null;

/** DATABASE_URL_READONLY when set (own lazy client, max 1, prepare off like db.ts), else the main sql(). */
export function screenerClient(env: Record<string, string | undefined> = process.env): ReadClient {
  if (!env.DATABASE_URL_READONLY) return fromPostgres(mainSql());
  if (!readonlyClient) {
    const url = databaseUrl({ DATABASE_URL: env.DATABASE_URL_READONLY })!;
    readonlyClient = fromPostgres(postgres(url, { max: 1, prepare: false, idle_timeout: 20, fetch_types: false }));
  }
  return readonlyClient;
}

/** Error text safe to show: connection strings and passwords removed. */
export function sanitizeDbError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s'"]+/gi, "$1://***")
    .replace(/\b(password|passwd|pwd)\s*[=:]\s*[^\s'"]+/gi, "$1=***")
    .slice(0, 500);
}

const cell = (v: unknown): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

/** Runs a compiled DSL read-only with a 5 s statement timeout. Throws with sanitized messages. */
export async function runQuery(dsl: ScreenerDsl, client: ReadClient): Promise<QueryResult> {
  const c = compile(dsl);
  const t0 = Date.now();
  try {
    const rows = await client.begin("read only", async (tx) => {
      await tx.unsafe(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
      return tx.unsafe(c.sql, c.params);
    });
    const columns = rows.columns?.map((x) => x.name) ?? c.columns;
    return { sql: c.sql, columns, rows: rows.map((r) => columns.map((k) => cell(r[k]))), ms: Date.now() - t0 };
  } catch (e) {
    throw new Error(sanitizeDbError(e));
  }
}

// ---------------------------------------------------------------- parsing

function describeTables(): string {
  return (Object.keys(SCREENER_TABLES) as ScreenerSource[])
    .map((s) => {
      const t = SCREENER_TABLES[s];
      const cols = Object.entries(t.cols as Record<string, ColKind>).map(([k, v]) => `${k} (${v})`);
      return `- ${s}: ${cols.join(", ")}${t.assetCol ? ` — asset column ${t.assetCol}` : " — no asset column; filter series_id"}`;
    })
    .join("\n");
}

export const SCREENER_SYSTEM = `You translate a trader's question into a screener query over stored Hyperliquid market data. You never write SQL and never answer the question yourself.

Sources and columns:
${describeTables()}
snapshots: one row per asset every ~15 min (price, 24 h volume, hourly funding rate, OI in USD, premium, basis, book depth in USD within ±1%/±2% of mid, spread in bps). funding: hourly funding history (rate, premium). candles: OHLCV with tf in 1h/4h/1d. observations: collected series by series_id (fng.value, hl.oi.BTC, hl.funding.ETH, fred.DGS10, cg.btc_dominance …).

DSL fields:
- source, select (columns of that source), filters [{col, op, value}] (numeric columns: = != > >= < <= with a number; text columns: = or != with a coin/series/tf name), assets (coin names, for sources with an asset column).
- changes [{col, window_h, op, pct}]: percent change of a numeric column versus the same series window_h hours earlier, e.g. OI up more than 20% in 7 days = {"col":"oi_usd","window_h":168,"op":">","pct":20}. A funding sign flip from positive to negative = filter funding < 0 plus change funding < −100 over the window.
- since_h: rows from the last since_h hours (use 1 for "now"/"currently", up to 2160). since_h + 2 × the longest window_h must stay ≤ 2160.
- orderBy {col, dir}, limit (≤ 500).
Use only listed columns. Funding values are hourly rates (0.0001 = 0.01%/h).`;

const colJson = { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" };
const hoursJson = { type: "integer", minimum: 1, maximum: 2160 };
const dslJsonSchema = {
  type: "object" as const,
  properties: {
    source: { type: "string", enum: Object.keys(SCREENER_TABLES) },
    select: { type: "array", minItems: 1, maxItems: 20, items: colJson },
    filters: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: { col: colJson, op: { type: "string", enum: Object.keys(OPS) }, value: { anyOf: [{ type: "number" }, { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,64}$" }] } },
        required: ["col", "op", "value"],
        additionalProperties: false,
      },
    },
    changes: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: { col: colJson, window_h: hoursJson, op: { type: "string", enum: [">", ">=", "<", "<="] }, pct: { type: "number" } },
        required: ["col", "window_h", "op", "pct"],
        additionalProperties: false,
      },
    },
    assets: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", pattern: "^([A-Za-z0-9]+:)?[A-Za-z0-9]+$" } },
    since_h: hoursJson,
    orderBy: { type: "object", properties: { col: colJson, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["col"], additionalProperties: false },
    limit: { type: "integer", minimum: 1, maximum: MAX_ROWS },
  },
  required: ["source", "select"],
  additionalProperties: false,
};

/** The DSL schema plus compile's own caps, so a model answer that cannot compile is retried, not returned. */
const ParseSchema = ScreenerDslSchema.superRefine((d, ctx) => {
  try {
    compile(d);
  } catch (e) {
    ctx.addIssue({ code: "custom", path: e instanceof CompileError && e.field ? e.field.split(".") : [], message: e instanceof Error ? e.message : String(e) });
  }
}) as unknown as ZodType<ScreenerDsl>;

export type ParseResult = { ok: true; dsl: ScreenerDsl; trace: LlmTrace & { cached: boolean } } | { ok: false; error: string; trace: LlmTrace };

/** Strong-tier question → DSL. Never throws. */
export async function parseQuery(deps: { llm: LlmDeps; signal?: AbortSignal }, question: string): Promise<ParseResult> {
  const res = await completeStructured({
    tier: "strong",
    system: SCREENER_SYSTEM,
    user: `Question: ${question}`,
    schema: ParseSchema,
    jsonSchema: dslJsonSchema,
    promptVersion: SCREENER_PROMPT_VERSION,
    cacheKey: `screener:${question.trim().toLowerCase()}`,
    signal: deps.signal,
    deps: deps.llm,
  });
  return res.ok ? { ok: true, dsl: res.value, trace: { ...res.trace, cached: res.cached } } : res;
}
