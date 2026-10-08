// Lab tool registry (LAB.md "Surfaces"). PLACEHOLDER: the tool set is filled
// in by the engine work; the transports (REST, MCP, CLI) are built against
// these three exports.
import type { PromptDef, ToolDef } from "../mcp/types.js";

export type { PromptDef, ToolContext, ToolDef, ToolSource } from "../mcp/types.js";
export { ToolInputError } from "../mcp/types.js";

export function labTools(): ToolDef[] {
  return [];
}

export function labPrompts(): PromptDef[] {
  return [];
}

export const LAB_INSTRUCTIONS = "Hypertrade Lab: heuristic research engine for crypto trading rules.";
