import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";

// Request/response helpers shared by the /api/intel sub-routers.

/** The JSON body, or `{}` when it is missing or not JSON (the schema then names what is missing). */
export async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** 400 for a failed zod parse: `invalid <what>: <first issue>`, plus `field` when the issue has a path. */
export function invalid(c: Context, err: ZodError, what = "request") {
  const issue = err.issues[0];
  const field = issue?.path.join(".");
  return c.json({ error: `invalid ${what}: ${issue?.message ?? "bad body"}`, ...(field ? { field } : {}) }, 400);
}

type TypedError = Error & { status: number; field?: string };

const isTyped = (err: unknown): err is TypedError =>
  err instanceof Error && typeof (err as { status?: unknown }).status === "number" && (err as TypedError).status >= 400 && (err as TypedError).status <= 599;

/**
 * An error a route did not handle. Typed errors that carry their own HTTP
 * status (OrderError, DeskError) pass through with their message and field.
 * Anything else is a 500, logged under `[tag]`; with `generic`, the body says
 * only that (store and upstream errors can carry SQL or connection strings),
 * otherwise the message is returned verbatim.
 */
export function failure(c: Context, err: unknown, tag: string, generic?: string) {
  if (isTyped(err)) return c.json({ error: err.message, ...(err.field ? { field: err.field } : {}) }, err.status as ContentfulStatusCode);
  console.error(`[${tag}]`, err);
  return c.json({ error: generic ?? (err instanceof Error ? err.message : `${tag} error`) }, 500);
}
