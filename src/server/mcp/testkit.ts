import { ToolInputError, UpstreamError, type Registry, type ToolContext } from "./types.js";

/** Fake registry for transport tests; records the contexts tools ran with. */
export function fakeRegistry() {
  const calls: Array<{ name: string; args: unknown; ctx: ToolContext }> = [];
  const registry: Registry = {
    serverInfo: { name: "fake-lab", version: "9.9.9" },
    instructions: "Use echo.",
    tools: [
      {
        name: "echo",
        title: "Echo",
        description: "Returns its arguments.",
        inputSchema: { type: "object", properties: { text: { type: "string" }, n: { type: "number" } }, additionalProperties: false },
        annotations: { readOnlyHint: true },
        async run(args, ctx) {
          calls.push({ name: "echo", args, ctx });
          return { echoed: args, source: ctx.source };
        },
      },
      {
        name: "list",
        description: "Returns an array.",
        inputSchema: { type: "object", properties: {} },
        async run() {
          return [1, 2, 3];
        },
      },
      {
        name: "bad_input",
        description: "Always rejects its input.",
        inputSchema: { type: "object", properties: { asset: { type: "string" } }, required: ["asset"] },
        async run() {
          throw new ToolInputError("asset is required", "asset");
        },
      },
      {
        name: "boom",
        description: "Always fails.",
        inputSchema: { type: "object", properties: {} },
        async run() {
          throw new Error("db connection refused");
        },
      },
      {
        name: "upstream",
        description: "Upstream data failure.",
        inputSchema: { type: "object", properties: {} },
        async run() {
          throw new UpstreamError("provider down");
        },
      },
    ],
    prompts: [
      {
        name: "autoresearch",
        description: "Research loop.",
        arguments: [
          { name: "asset", description: "Asset", required: true },
          { name: "goal", description: "Goal" },
        ],
        render: (a) => `Research ${a.asset}${a.goal ? ` for ${a.goal}` : ""}.`,
      },
    ],
  };
  return { registry, calls };
}
