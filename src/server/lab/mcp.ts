// Minimal MCP server core (JSON-RPC 2.0, tools only) for the Lab, so Claude
// Code, Claude Desktop or any MCP client can run the research loop the way
// Glassnode's Alpha Lab MCP does — on our own data. Transport-free: the stdio
// wiring lives in scripts/lab-mcp.ts.
import { LAB_READ_TOOL_SPECS, LAB_SAVE_TOOL_SPEC, runLabTool, defaultLabToolDeps, isLabTool, type LabToolDeps } from "./tools.js";

export const MCP_SERVER_INFO = { name: "hypertrade-lab", version: "1.0.0" };
const SUPPORTED_PROTOCOL = "2025-06-18";

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const TOOLS = [...LAB_READ_TOOL_SPECS, LAB_SAVE_TOOL_SPEC];

const INSTRUCTIONS =
  "Hypertrade Lab: rule research on free BTC on-chain, sentiment, liquidity and derivatives history. Typical loop: lab_features to see what has data, lab_search with a direction and a set of bases, then lab_evaluate_rule to stress-test the best result (nudge thresholds, drop a condition, later start date). Judge rules on holdout and walk-forward stats, deflated Sharpe >= 0.95 and stability >= 0.5, never on in-sample alone. Save only rules that pass with lab_save_rule; the catalogue then tracks them on unseen data.";

/** Handles one message; returns null for notifications. */
export async function handleMcp(msg: JsonRpcRequest, deps: LabToolDeps = defaultLabToolDeps): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (msg.id === undefined) return null; // notification (notifications/initialized, cancelled, ...)

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : SUPPORTED_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string" || !isLabTool(name)) return error(-32602, `unknown tool ${String(name)}`);
      const run = await runLabTool(name, msg.params?.arguments ?? {}, deps, "mcp");
      return reply({ content: [{ type: "text", text: run.content }], isError: run.isError });
    }
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}
