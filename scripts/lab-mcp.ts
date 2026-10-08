// bun run lab:mcp — MCP over stdio: newline-delimited JSON-RPC on stdin/stdout.
// stdout carries protocol frames only; every log goes to stderr.
// Remote (LAB_URL set, no --local): each message is forwarded to
// ${LAB_URL}/api/mcp with Authorization: Bearer $LAB_API_TOKEN.
// Local: the lab registry in-process (LAB_LOCAL=1), no deadline unless
// LAB_SEARCH_DEADLINE_MS is set.
import { handleJsonRpcText, INTERNAL_ERROR, PARSE_ERROR, rpcError, type JsonRpcReply } from "../src/server/mcp/server.js";
import { frame, owedIds, splitLines } from "../src/server/mcp/stdio.js";
import type { Registry } from "../src/server/mcp/types.js";

// Anything the engine logs must not corrupt the protocol stream.
const write = process.stdout.write.bind(process.stdout);
const out = (s: string) => new Promise<void>((resolve) => write(s, () => resolve()));
console.log = console.info = console.debug = (...a: unknown[]) => console.error(...a);

const send = async (reply: JsonRpcReply | unknown) => {
  if (reply !== null && reply !== undefined) await out(frame(reply));
};

const isRemote = !!process.env.LAB_URL && !process.argv.includes("--local");

let registry: Promise<Registry> | null = null;
function localRegistry(): Promise<Registry> {
  process.env.LAB_LOCAL = "1";
  registry ??= import("../src/server/mcp/lab.js").then((m) => m.labRegistry());
  return registry;
}

async function handleLocal(line: string) {
  const { labDeadlineMs } = await import("../src/server/mcp/lab.js");
  await send(await handleJsonRpcText(await localRegistry(), line, { source: "mcp", deadlineMs: labDeadlineMs(process.env) }));
}

async function handleRemote(line: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return send(rpcError(null, PARSE_ERROR, "Parse error"));
  }
  const fail = async (why: string) => {
    console.error(`[lab-mcp] ${why}`);
    for (const id of owedIds(parsed)) await send(rpcError(id, INTERNAL_ERROR, why));
  };
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (process.env.LAB_API_TOKEN) headers.authorization = `Bearer ${process.env.LAB_API_TOKEN}`;
  let res: Response;
  try {
    res = await fetch(`${process.env.LAB_URL!.replace(/\/+$/, "")}/api/mcp`, { method: "POST", headers, body: line });
  } catch (err) {
    return fail(`upstream unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 202) return;
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON-RPC
  }
  const isRpc = (b: unknown) => typeof b === "object" && b !== null && (b as { jsonrpc?: unknown }).jsonrpc === "2.0";
  if (Array.isArray(body) ? body.every(isRpc) : isRpc(body)) return send(body);
  await fail(res.status === 401 ? "upstream 401 unauthorized: set LAB_API_TOKEN" : `upstream HTTP ${res.status}: ${text.slice(0, 200)}`);
}

const handle = isRemote ? handleRemote : handleLocal;
console.error(`[lab-mcp] ${isRemote ? `remote ${process.env.LAB_URL}` : "local registry"} on stdio`);
if (isRemote && !process.env.LAB_API_TOKEN) console.error("[lab-mcp] LAB_API_TOKEN is not set; upstream will likely answer 401");

// Requests run concurrently (a long search must not block ping); replies carry ids.
const pending = new Set<Promise<void>>();
const track = (line: string) => {
  const p = handle(line)
    .catch((err) => console.error("[lab-mcp]", err))
    .finally(() => pending.delete(p));
  pending.add(p);
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const { lines, rest } = splitLines(buffer + chunk);
  buffer = rest;
  for (const line of lines) track(line);
});
process.stdin.on("end", async () => {
  if (buffer.trim()) track(buffer);
  await Promise.allSettled([...pending]);
  process.exit(0);
});
