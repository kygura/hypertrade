import { describeTool, ToolInputError, type Registry, type ToolContext } from "./types.js";

// Hand-rolled MCP server core (LAB.md "Surfaces"): JSON-RPC 2.0 in, JSON-RPC
// out, no transport. HTTP (http.ts) and stdio (scripts/lab-mcp.ts) wrap it.

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: JsonRpcError };

export type JsonRpcReply = JsonRpcResponse | JsonRpcResponse[] | null;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function isSupportedProtocolVersion(v: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v);
}

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!isObject(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isId = (v: unknown): v is JsonRpcId => typeof v === "string" || typeof v === "number" || v === null;

/** Parses a raw body/line first: malformed JSON is a -32700 reply. */
export async function handleJsonRpcText(registry: Registry, text: string, ctx: ToolContext): Promise<JsonRpcReply> {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(null, PARSE_ERROR, "Parse error");
  }
  return handleJsonRpc(registry, message, ctx);
}

/**
 * One message or a batch. Returns null when nothing is owed (notifications,
 * client responses, or a batch made only of those).
 */
export async function handleJsonRpc(registry: Registry, message: unknown, ctx: ToolContext): Promise<JsonRpcReply> {
  if (Array.isArray(message)) {
    if (message.length === 0) return rpcError(null, INVALID_REQUEST, "Invalid Request: empty batch");
    const replies = await Promise.all(message.map((m) => handleOne(registry, m, ctx)));
    const owed = replies.filter((r): r is JsonRpcResponse => r !== null);
    return owed.length ? owed : null;
  }
  return handleOne(registry, message, ctx);
}

async function handleOne(registry: Registry, msg: unknown, ctx: ToolContext): Promise<JsonRpcResponse | null> {
  if (!isObject(msg)) return rpcError(null, INVALID_REQUEST, "Invalid Request");
  const hasId = "id" in msg;
  const id: JsonRpcId = hasId && isId(msg.id) ? msg.id : null;
  if (msg.jsonrpc !== "2.0" || (hasId && !isId(msg.id))) return rpcError(id, INVALID_REQUEST, "Invalid Request");

  if (msg.method === undefined) {
    // A client's response to a server request (we never send any): accept, owe nothing.
    if (hasId && ("result" in msg || "error" in msg)) return null;
    return rpcError(id, INVALID_REQUEST, "Invalid Request");
  }
  if (typeof msg.method !== "string") return rpcError(id, INVALID_REQUEST, "Invalid Request");
  if (msg.params !== undefined && !isObject(msg.params) && !Array.isArray(msg.params)) {
    return rpcError(id, INVALID_REQUEST, "Invalid Request: params must be an object");
  }
  // Notifications (initialized, cancelled, ...) need no reply and change nothing here.
  if (!hasId) return null;

  const params = isObject(msg.params) ? msg.params : {};
  try {
    const result = await dispatch(registry, msg.method, params, ctx);
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(id, err.code, err.message);
    console.error("[mcp]", err);
    return rpcError(id, INTERNAL_ERROR, "Internal error");
  }
}

async function dispatch(registry: Registry, method: string, params: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        protocolVersion: isSupportedProtocolVersion(asked) ? asked : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: registry.serverInfo,
        ...(registry.instructions && { instructions: registry.instructions }),
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: registry.tools.map(describeTool) };
    case "tools/call":
      return callTool(registry, params, ctx);
    case "prompts/list":
      return {
        prompts: (registry.prompts ?? []).map((p) => ({
          name: p.name,
          description: p.description,
          ...(p.arguments && { arguments: p.arguments }),
        })),
      };
    case "prompts/get":
      return getPrompt(registry, params);
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

async function callTool(registry: Registry, params: Record<string, unknown>, ctx: ToolContext) {
  if (typeof params.name !== "string") throw new RpcError(INVALID_PARAMS, "tools/call: name is required");
  const tool = registry.tools.find((t) => t.name === params.name);
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
  if (params.arguments !== undefined && !isObject(params.arguments)) {
    throw new RpcError(INVALID_PARAMS, "tools/call: arguments must be an object");
  }
  try {
    const result = await tool.run(params.arguments ?? {}, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(result ?? null) }],
      ...(isPlainObject(result) && { structuredContent: result }),
      isError: false,
    };
  } catch (err) {
    // Tool failures go back to the model as a result it can read and correct.
    const text =
      err instanceof ToolInputError
        ? `Invalid arguments${err.field ? ` (${err.field})` : ""}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { content: [{ type: "text", text }], isError: true };
  }
}

function getPrompt(registry: Registry, params: Record<string, unknown>) {
  if (typeof params.name !== "string") throw new RpcError(INVALID_PARAMS, "prompts/get: name is required");
  const prompt = (registry.prompts ?? []).find((p) => p.name === params.name);
  if (!prompt) throw new RpcError(INVALID_PARAMS, `Unknown prompt: ${params.name}`);
  const raw = params.arguments ?? {};
  if (!isObject(raw)) throw new RpcError(INVALID_PARAMS, "prompts/get: arguments must be an object");
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new RpcError(INVALID_PARAMS, `prompts/get: argument ${k} must be a string`);
    args[k] = v;
  }
  for (const a of prompt.arguments ?? []) {
    if (a.required && !args[a.name]) throw new RpcError(INVALID_PARAMS, `prompts/get: missing required argument ${a.name}`);
  }
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text: prompt.render(args) } }],
  };
}
