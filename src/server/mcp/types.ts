// Transport-neutral tool registry contract. One ToolDef serves REST
// (/api/lab/tools), MCP over HTTP (/api/mcp), MCP over stdio and the CLI.

export type ToolSource = "api" | "mcp" | "cli" | "ui";
export const TOOL_SOURCES: readonly ToolSource[] = ["api", "mcp", "cli", "ui"];

export interface ToolContext {
  source: ToolSource;
  /** Wall-clock budget for long tools (search); undefined = no deadline. */
  deadlineMs?: number;
  /** MCP-Protocol-Version the client declared (HTTP header); undefined = not declared. */
  protocolVersion?: string;
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
}

/** Bad arguments: REST answers 400, MCP answers an isError tool result. */
export class ToolInputError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "ToolInputError";
    this.field = field;
  }
}

/** An upstream data source failed or returned nothing usable: REST answers 502, MCP an isError tool result. */
export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  description: string;
  arguments?: PromptArgument[];
  render(args: Record<string, string>): string;
}

export interface Registry {
  tools: ToolDef[];
  prompts?: PromptDef[];
  instructions?: string;
  serverInfo: { name: string; version: string };
}

/** The wire description of a tool (everything but the handler). */
export function describeTool(t: ToolDef) {
  return {
    name: t.name,
    ...(t.title !== undefined && { title: t.title }),
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations !== undefined && { annotations: t.annotations }),
  };
}
