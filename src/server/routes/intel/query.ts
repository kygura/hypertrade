import { Hono, type Context } from "hono";
import type { ZodError } from "zod";
import { QueryParseRequestSchema, QueryRunRequestSchema } from "../../../shared/intel.js";
import type { LlmDeps } from "../../intel/llm.js";
import { CompileError, compile, parseQuery, runQuery, sanitizeDbError, screenerClient, type ReadClient } from "../../intel/screener.js";
import { llmErrorStatus } from "./theses.js";

// /api/intel/query — NL screener (SPEC.md § Intel I0.17, I2).
// POST /query/parse {question} → {dsl, sql, params, trace}
// POST /query/run   {dsl}      → {sql, columns, rows, ms}  (read only, 5 s, ≤ 500 rows, ≤ 90 days)
// Errors are returned verbatim, minus connection strings.

export interface QueryRouteDeps {
  llm: LlmDeps;
  /** Read client; defaults to DATABASE_URL_READONLY or the main sql(). */
  client?: () => ReadClient;
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

const invalid = (c: Context, e: ZodError) => {
  const issue = e.issues[0];
  return c.json({ error: `invalid request: ${issue?.message ?? "bad body"}`, field: issue?.path.join(".") || undefined }, 400);
};

export function createQueryRoutes(deps: QueryRouteDeps) {
  const client = deps.client ?? (() => screenerClient());
  return new Hono()
    .post("/query/parse", async (c) => {
      const parsed = QueryParseRequestSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error);
      const r = await parseQuery({ llm: deps.llm }, parsed.data.question);
      if (!r.ok) return c.json({ error: r.error }, llmErrorStatus(r.error));
      try {
        const { sql, params } = compile(r.dsl);
        return c.json({ dsl: r.dsl, sql, params, trace: r.trace });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    })
    .post("/query/run", async (c) => {
      const parsed = QueryRunRequestSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error);
      const { dsl } = parsed.data;
      try {
        compile(dsl);
      } catch (err) {
        if (err instanceof CompileError) return c.json({ error: err.message, field: err.field ? `dsl.${err.field}` : undefined }, 400);
        throw err;
      }
      let db: ReadClient;
      try {
        db = client();
      } catch (err) {
        return c.json({ error: sanitizeDbError(err) }, 503);
      }
      try {
        return c.json(await runQuery(dsl, db));
      } catch (err) {
        return c.json({ error: sanitizeDbError(err) }, 500);
      }
    });
}
