// Stdio MCP server for the Lab. Reads DATABASE_URL like the app does.
//
//   claude mcp add hypertrade-lab -e DATABASE_URL=postgres://... -- bun run /path/to/hypertrade/scripts/lab-mcp.ts
//
// Newline-delimited JSON-RPC on stdin/stdout; logs go to stderr only, since
// stdout is the protocol channel.
import { createInterface } from "node:readline";
import { releaseConnection } from "../src/server/db.js";
import { handleMcp } from "../src/server/lab/mcp.js";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closing = false;

const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  pending++;
  try {
    const res = await handleMcp(msg);
    if (res) write(res);
  } catch (err) {
    console.error("[lab-mcp]", err);
    if (msg?.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : "internal error" } });
  } finally {
    pending--;
    if (closing && pending === 0) await shutdown();
  }
});

async function shutdown() {
  await releaseConnection().catch(() => {});
  process.exit(0);
}

rl.on("close", () => {
  closing = true;
  if (pending === 0) void shutdown();
});
