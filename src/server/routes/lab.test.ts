import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { fakeRegistry } from "../mcp/testkit.js";
import { labRoutes } from "./lab.js";

function app(env: Record<string, string> = {}) {
  const kit = fakeRegistry();
  return { ...kit, app: new Hono().route("/lab", labRoutes(() => kit.registry, { env })) };
}

const post = (body?: string, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body,
});

describe("/lab routes", () => {
  test("GET /tools lists definitions without handlers", async () => {
    const res = await app().app.request("/lab/tools");
    expect(res.status).toBe(200);
    const { tools } = await res.json();
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["echo", "list", "bad_input", "boom"]);
    expect(tools[0]).toEqual({
      name: "echo",
      title: "Echo",
      description: "Returns its arguments.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, n: { type: "number" } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
    });
  });

  test("POST /tools/:name → { ok, result } with source api and the 50s deadline", async () => {
    const { app: a, calls } = app();
    const res = await a.request("/lab/tools/echo", post(JSON.stringify({ text: "hi" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { echoed: { text: "hi" }, source: "api" } });
    expect(calls[0].ctx).toEqual({ source: "api", deadlineMs: 50_000 });
  });

  test("x-lab-source is honoured only for known sources; env deadline applies", async () => {
    const { app: a, calls } = app({ LAB_SEARCH_DEADLINE_MS: "900" });
    await a.request("/lab/tools/echo", post("{}", { "x-lab-source": "cli" }));
    await a.request("/lab/tools/echo", post("{}", { "x-lab-source": "root" }));
    expect(calls.map((c) => c.ctx)).toEqual([
      { source: "cli", deadlineMs: 900 },
      { source: "api", deadlineMs: 900 },
    ]);
  });

  test("empty body means no arguments", async () => {
    const res = await app().app.request("/lab/tools/echo", { method: "POST" });
    expect(await res.json()).toEqual({ ok: true, result: { echoed: {}, source: "api" } });
  });

  test("ToolInputError → 400 with field", async () => {
    const res = await app().app.request("/lab/tools/bad_input", post("{}"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "asset is required", field: "asset" });
  });

  test("malformed or non-object body → 400", async () => {
    expect((await app().app.request("/lab/tools/echo", post("{nope"))).status).toBe(400);
    expect((await app().app.request("/lab/tools/echo", post("[1]"))).status).toBe(400);
    expect((await app().app.request("/lab/tools/echo", post("3"))).status).toBe(400);
  });

  test("unknown tool → 404", async () => {
    const res = await app().app.request("/lab/tools/nope", post("{}"));
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  test("other errors → 500 { ok: false, error }", async () => {
    const res = await app().app.request("/lab/tools/boom", post("{}"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "provider down" });
  });
});
