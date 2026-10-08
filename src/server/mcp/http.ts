import { Hono } from "hono";
import { labDeadlineMs, SERVER_DEADLINE_MS } from "./lab.js";
import { handleJsonRpcText, INVALID_REQUEST, isSupportedProtocolVersion, PARSE_ERROR, rpcError } from "./server.js";
import type { Registry } from "./types.js";

// POST /api/mcp — MCP Streamable HTTP, stateless: JSON responses only (no SSE,
// no Mcp-Session-Id). Auth (cookie or LAB_API_TOKEN bearer) is the global gate
// in auth.ts; this module adds the transport rules from the spec.

export interface McpRouteOptions {
  env?: Record<string, string | undefined>;
}

function allowedOrigins(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env.LAB_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

/**
 * Spec's DNS-rebinding guard: a browser-sent Origin must be this host or an
 * operator-listed origin. Non-browser clients send no Origin and pass.
 */
function originAllowed(origin: string | undefined, requestUrl: string, host: string | undefined, env: Record<string, string | undefined>): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  const self = host ?? new URL(requestUrl).host;
  if (parsed.host === self) return true;
  return allowedOrigins(env).has(parsed.origin);
}

export function mcpRoutes(registryFactory: () => Registry, opts: McpRouteOptions = {}) {
  const env = opts.env ?? process.env;
  return new Hono()
    .post("/", async (c) => {
      if (!originAllowed(c.req.header("origin"), c.req.url, c.req.header("host"), env)) {
        return c.json(rpcError(null, INVALID_REQUEST, "Forbidden origin"), 403);
      }
      const version = c.req.header("mcp-protocol-version");
      if (version !== undefined && !isSupportedProtocolVersion(version)) {
        return c.json(rpcError(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version}`), 400);
      }
      if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) {
        return c.json(rpcError(null, INVALID_REQUEST, "Content-Type must be application/json"), 415);
      }
      const reply = await handleJsonRpcText(registryFactory(), await c.req.text(), {
        source: "mcp",
        deadlineMs: labDeadlineMs(env, SERVER_DEADLINE_MS),
      });
      if (reply === null) return c.body(null, 202);
      const status = !Array.isArray(reply) && "error" in reply && reply.error.code === PARSE_ERROR ? 400 : 200;
      return c.json(reply, status);
    })
    .all("/", (c) => {
      c.header("Allow", "POST");
      return c.json(rpcError(null, INVALID_REQUEST, "Method not allowed: this server is stateless and has no SSE stream"), 405);
    });
}
