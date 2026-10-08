import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mcpRoutes } from "./http.js";
import { fakeRegistry } from "./testkit.js";

function app(env: Record<string, string> = {}) {
  const kit = fakeRegistry();
  return { ...kit, app: new Hono().route("/mcp", mcpRoutes(() => kit.registry, { env })) };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("POST /mcp", () => {
  test("answers initialize as JSON", async () => {
    const res = await app().app.request("http://lab.test/mcp", post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  test("tools/call runs with source mcp and the default 50s deadline", async () => {
    const { app: a, calls } = app();
    const res = await a.request("http://lab.test/mcp", post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { n: 1 } } }));
    expect((await res.json()).result.structuredContent).toEqual({ echoed: { n: 1 }, source: "mcp" });
    expect(calls[0].ctx).toEqual({ source: "mcp", deadlineMs: 50_000 });
  });

  test("LAB_SEARCH_DEADLINE_MS overrides the deadline", async () => {
    const { app: a, calls } = app({ LAB_SEARCH_DEADLINE_MS: "1500" });
    await a.request("http://lab.test/mcp", post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo" } }));
    expect(calls[0].ctx.deadlineMs).toBe(1500);
  });

  test("notifications only → 202 with no body", async () => {
    const res = await app().app.request("http://lab.test/mcp", post({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("batch → array", async () => {
    const res = await app().app.request("http://lab.test/mcp", post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]));
    expect(await res.json()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  test("malformed JSON → 400 parse error", async () => {
    const res = await app().app.request("http://lab.test/mcp", post("{nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  test("non-JSON content type → 415", async () => {
    const res = await app().app.request("http://lab.test/mcp", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  test("MCP-Protocol-Version: supported passes, unsupported → 400", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await app().app.request("http://lab.test/mcp", post(ping, { "mcp-protocol-version": "2025-03-26" }))).status).toBe(200);
    expect((await app().app.request("http://lab.test/mcp", post(ping, { "mcp-protocol-version": "1999-01-01" }))).status).toBe(400);
  });

  test("Origin: same host and listed origins pass, others → 403", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const a = app({ LAB_ALLOWED_ORIGINS: " https://claude.ai/ , https://other.test" }).app;
    expect((await a.request("http://lab.test/mcp", post(ping, { origin: "http://lab.test" }))).status).toBe(200);
    expect((await a.request("http://lab.test/mcp", post(ping, { origin: "https://claude.ai" }))).status).toBe(200);
    expect((await a.request("http://lab.test/mcp", post(ping, { origin: "https://other.test" }))).status).toBe(200);
    expect((await a.request("http://lab.test/mcp", post(ping, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await a.request("http://lab.test/mcp", post(ping, { origin: "null" }))).status).toBe(403);
    expect((await a.request("http://lab.test/mcp", post(ping, { origin: "http://lab.test.evil.test" }))).status).toBe(403);
    expect((await app().app.request("http://lab.test/mcp", post(ping, { origin: "https://claude.ai" }))).status).toBe(403);
  });

  test("GET and DELETE → 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app().app.request("http://lab.test/mcp", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});
