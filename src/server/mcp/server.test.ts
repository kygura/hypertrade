import { describe, expect, test } from "bun:test";
import { handleJsonRpc, handleJsonRpcText, LATEST_PROTOCOL_VERSION, MAX_BATCH } from "./server.js";
import { fakeRegistry } from "./testkit.js";
import type { ToolContext } from "./types.js";

const ctx: ToolContext = { source: "mcp", deadlineMs: 1234 };
const req = (method: string, params?: unknown, id: string | number | null = 1) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) });

async function call(method: string, params?: unknown) {
  const { registry } = fakeRegistry();
  return (await handleJsonRpc(registry, req(method, params), ctx)) as any;
}

describe("initialize", () => {
  test("echoes a supported client version and declares capabilities", async () => {
    for (const v of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const res = await call("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } });
      expect(res).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: v,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: "fake-lab", version: "9.9.9" },
          instructions: "Use echo.",
        },
      });
    }
  });

  test("answers the latest version for unknown or missing ones", async () => {
    expect((await call("initialize", { protocolVersion: "2099-01-01" })).result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect((await call("initialize")).result.protocolVersion).toBe("2025-06-18");
  });
});

describe("ping and listing", () => {
  test("ping → empty result, string ids preserved", async () => {
    const { registry } = fakeRegistry();
    expect(await handleJsonRpc(registry, req("ping", undefined, "abc"), ctx)).toEqual({ jsonrpc: "2.0", id: "abc", result: {} });
  });

  test("tools/list describes every tool without handlers", async () => {
    const { tools } = (await call("tools/list")).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["echo", "list", "bad_input", "boom", "upstream"]);
    expect(tools[0]).toEqual({
      name: "echo",
      title: "Echo",
      description: "Returns its arguments.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, n: { type: "number" } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
    });
    expect(tools[1]).not.toHaveProperty("title");
    expect(tools[1]).not.toHaveProperty("run");
  });

  test("prompts/list", async () => {
    const { prompts } = (await call("prompts/list")).result;
    expect(prompts).toEqual([
      {
        name: "autoresearch",
        description: "Research loop.",
        arguments: [
          { name: "asset", description: "Asset", required: true },
          { name: "goal", description: "Goal" },
        ],
      },
    ]);
  });
});

describe("tools/call", () => {
  test("object result → text + structuredContent, ctx passed through", async () => {
    const { registry, calls } = fakeRegistry();
    const res = (await handleJsonRpc(registry, req("tools/call", { name: "echo", arguments: { text: "hi" } }), ctx)) as any;
    const expected = { echoed: { text: "hi" }, source: "mcp" };
    expect(res.result).toEqual({ content: [{ type: "text", text: JSON.stringify(expected) }], structuredContent: expected, isError: false });
    expect(calls[0].ctx).toEqual(ctx);
  });

  test("missing arguments default to {}", async () => {
    const res = await call("tools/call", { name: "echo" });
    expect(res.result.structuredContent).toEqual({ echoed: {}, source: "mcp" });
  });

  test("non-object result has no structuredContent", async () => {
    const res = await call("tools/call", { name: "list" });
    expect(res.result).toEqual({ content: [{ type: "text", text: "[1,2,3]" }], isError: false });
  });

  test("ToolInputError → isError result naming the field, not a protocol error", async () => {
    const res = await call("tools/call", { name: "bad_input", arguments: {} });
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("Invalid arguments (asset): asset is required");
  });

  test("UpstreamError → isError result with its message", async () => {
    const res = await call("tools/call", { name: "upstream" });
    expect(res.result).toEqual({ content: [{ type: "text", text: "provider down" }], isError: true });
  });

  test("unexpected Error → generic isError text; details only in the log", async () => {
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      const res = await call("tools/call", { name: "boom" });
      expect(res.result).toEqual({ content: [{ type: "text", text: "Internal error" }], isError: true });
    } finally {
      console.error = orig;
    }
    expect(String((logged[0]![1] as Error).message)).toContain("hunter2");
  });

  test("unknown tool, missing name, non-object arguments → -32602", async () => {
    expect((await call("tools/call", { name: "nope" })).error).toEqual({ code: -32602, message: "Unknown tool: nope" });
    expect((await call("tools/call", {})).error.code).toBe(-32602);
    expect((await call("tools/call", { name: "echo", arguments: [1] })).error.code).toBe(-32602);
  });
});

describe("prompts/get", () => {
  test("renders a user message", async () => {
    const res = await call("prompts/get", { name: "autoresearch", arguments: { asset: "BTC", goal: "swing" } });
    expect(res.result).toEqual({ description: "Research loop.", messages: [{ role: "user", content: { type: "text", text: "Research BTC for swing." } }] });
  });

  test("unknown prompt, missing required or non-string args → -32602", async () => {
    expect((await call("prompts/get", { name: "nope" })).error.code).toBe(-32602);
    expect((await call("prompts/get", { name: "autoresearch", arguments: {} })).error.message).toContain("asset");
    expect((await call("prompts/get", { name: "autoresearch", arguments: { asset: 1 } })).error.code).toBe(-32602);
  });
});

describe("JSON-RPC envelope", () => {
  const { registry } = fakeRegistry();

  test("unknown method → -32601", async () => {
    expect((await call("resources/list")).error).toEqual({ code: -32601, message: "Method not found: resources/list" });
  });

  test("notifications (no id) → null, even for unknown methods", async () => {
    expect(await handleJsonRpc(registry, { jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
    expect(await handleJsonRpc(registry, { jsonrpc: "2.0", method: "whatever" }, ctx)).toBeNull();
  });

  test("a notification does not run tools", async () => {
    const { registry: r, calls } = fakeRegistry();
    expect(await handleJsonRpc(r, { jsonrpc: "2.0", method: "tools/call", params: { name: "echo" } }, ctx)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("client responses are accepted silently", async () => {
    expect(await handleJsonRpc(registry, { jsonrpc: "2.0", id: 5, result: {} }, ctx)).toBeNull();
    expect(await handleJsonRpc(registry, { jsonrpc: "2.0", id: 5, error: { code: 1, message: "x" } }, ctx)).toBeNull();
  });

  test("invalid requests → -32600", async () => {
    const bad = [42, "x", null, { id: 1, method: "ping" }, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1, method: 7 }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, method: "ping", params: "x" }];
    for (const m of bad) {
      const res = (await handleJsonRpc(registry, m, ctx)) as any;
      expect(res.error.code).toBe(-32600);
    }
    expect(((await handleJsonRpc(registry, { jsonrpc: "1.0", id: 9, method: "ping" }, ctx)) as any).id).toBe(9);
    expect(((await handleJsonRpc(registry, { jsonrpc: "2.0", id: {}, method: "ping" }, ctx)) as any).id).toBeNull();
  });

  test("a request with id null → -32600 and runs nothing", async () => {
    const { registry: r, calls } = fakeRegistry();
    const res = (await handleJsonRpc(r, { jsonrpc: "2.0", id: null, method: "tools/call", params: { name: "echo" } }, ctx)) as any;
    expect(res).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: id must not be null" } });
    expect(calls).toHaveLength(0);
  });

  test("parse error → -32700 with null id", async () => {
    expect(await handleJsonRpcText(registry, "{nope", ctx)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  test("text entry point handles valid messages", async () => {
    expect(await handleJsonRpcText(registry, JSON.stringify(req("ping")), ctx)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("batch: replies in order, drops notifications", async () => {
    const res = await handleJsonRpc(registry, [req("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, req("nope", undefined, 2), 7], ctx);
    expect(res).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found: nope" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
    ]);
  });

  test("batch of notifications → null; empty batch → -32600", async () => {
    expect(await handleJsonRpc(registry, [{ jsonrpc: "2.0", method: "notifications/initialized" }], ctx)).toBeNull();
    expect(((await handleJsonRpc(registry, [], ctx)) as any).error.code).toBe(-32600);
  });

  test("batch over MAX_BATCH → -32600 and runs nothing", async () => {
    const { registry: r, calls } = fakeRegistry();
    const batch = Array.from({ length: MAX_BATCH + 1 }, (_, i) => req("tools/call", { name: "echo" }, i + 1));
    expect(((await handleJsonRpc(r, batch, ctx)) as any).error.code).toBe(-32600);
    expect(calls).toHaveLength(0);
    expect(await handleJsonRpc(r, batch.slice(0, MAX_BATCH), ctx)).toHaveLength(MAX_BATCH);
  });

  test("batch elements run one at a time", async () => {
    let active = 0;
    let peak = 0;
    const { registry: r } = fakeRegistry();
    r.tools.push({
      name: "slow",
      description: "Sleeps.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        peak = Math.max(peak, ++active);
        await new Promise((ok) => setTimeout(ok, 5));
        active--;
        return {};
      },
    });
    await handleJsonRpc(r, [1, 2, 3].map((id) => req("tools/call", { name: "slow" }, id)), ctx);
    expect(peak).toBe(1);
  });

  test("protocol 2025-06-18+ → batches refused; older versions accepted", async () => {
    const batch = [req("ping", undefined, 1)];
    expect(((await handleJsonRpc(registry, batch, { ...ctx, protocolVersion: "2025-06-18" })) as any).error.code).toBe(-32600);
    expect(await handleJsonRpc(registry, batch, { ...ctx, protocolVersion: "2025-03-26" })).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });
});
