import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// /engine/* — authenticated proxy to the hyperion core's strategy API
// (hyperion/docs/jev/PROTOCOL.md "hypertrade proxy"):
//   /api/engine/<rest>  ⇄  ${ENGINE_URL}/api/strategy/<rest>
// Same method, body and query string; the core's bearer token is added here
// so it never reaches the browser. Session-cookie protection comes from the
// global requireAuth gate in api/index.ts.
//
// Failure vocabulary (the UI maps both to DESIGN.md §6 OfflineBlock):
//   503 { error: "engine not configured" }  — ENGINE_URL unset
//   502 { error: "engine unreachable" }     — fetch rejected (DNS, refused…)
//   502 { error: "engine timeout" }         — no response within TIMEOUT_MS
// Any HTTP response from the core, including its own 4xx/5xx and
// { error, field } bodies, passes through verbatim.

export const TIMEOUT_MS = 10_000;

/** Path after the /engine mount, whether the router runs standalone or under /api. */
function restOf(pathname: string): string {
  const marker = "/engine/";
  const idx = pathname.indexOf(marker);
  const rest = idx >= 0 ? pathname.slice(idx + marker.length) : pathname.replace(/^\/+/, "");
  return rest.replace(/\/+$/, "");
}

export const engineRoutes = new Hono().all("/*", async (c) => {
  const base = process.env.ENGINE_URL;
  if (!base) return c.json({ error: "engine not configured" }, 503);

  const inUrl = new URL(c.req.url);
  const target = `${base.replace(/\/+$/, "")}/api/strategy/${restOf(inUrl.pathname)}${inUrl.search}`;

  const headers: Record<string, string> = { accept: "application/json" };
  const token = process.env.ENGINE_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const method = c.req.method.toUpperCase();
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const text = await c.req.text();
    if (text.length > 0) {
      body = text;
      headers["content-type"] = c.req.header("content-type") ?? "application/json";
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return c.json({ error: timedOut ? "engine timeout" : "engine unreachable" }, 502);
  }

  const text = await upstream.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = { error: text || upstream.statusText || `HTTP ${upstream.status}` };
  }
  if (json === null) json = upstream.ok ? {} : { error: upstream.statusText || `HTTP ${upstream.status}` };
  return c.json(json, upstream.status as ContentfulStatusCode);
});
