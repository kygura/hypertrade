import { Hono } from "hono";
import { labDeadlineMs, labRegistry, SERVER_DEADLINE_MS } from "../mcp/lab.js";
import { describeTool, TOOL_SOURCES, ToolInputError, UpstreamError, type Registry, type ToolSource } from "../mcp/types.js";

// /lab — REST face of the lab tool registry (LAB.md "Surfaces"). Cookie or
// LAB_API_TOKEN bearer, both checked by the global gate in auth.ts.
//
// GET  /lab/tools        → { tools: [{ name, title, description, inputSchema, annotations }] }
// POST /lab/tools/:name  JSON args → { ok: true, result }
//                        | 400 { ok: false, error, field? } (bad args)
//                        | 404 unknown tool | 502 { ok: false, error } (upstream data)
//                        | 500 { ok: false, error }
// Header x-lab-source: api|mcp|cli|ui (default api) is passed to the tool.

export interface LabRouteOptions {
  env?: Record<string, string | undefined>;
}

export function labRoutes(registryFactory: () => Registry = labRegistry, opts: LabRouteOptions = {}) {
  const env = opts.env ?? process.env;
  return new Hono()
    .get("/tools", (c) => c.json({ tools: registryFactory().tools.map(describeTool) }))
    .post("/tools/:name", async (c) => {
      const name = c.req.param("name");
      const tool = registryFactory().tools.find((t) => t.name === name);
      if (!tool) return c.json({ ok: false, error: `unknown tool: ${name}` }, 404);

      const text = await c.req.text();
      let args: unknown = {};
      if (text.trim()) {
        try {
          args = JSON.parse(text);
        } catch {
          return c.json({ ok: false, error: "body must be JSON" }, 400);
        }
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return c.json({ ok: false, error: "body must be a JSON object of tool arguments" }, 400);
      }

      const header = c.req.header("x-lab-source") as ToolSource | undefined;
      const source: ToolSource = header && TOOL_SOURCES.includes(header) ? header : "api";
      try {
        const result = await tool.run(args, { source, deadlineMs: labDeadlineMs(env, SERVER_DEADLINE_MS) });
        return c.json({ ok: true, result: result ?? null });
      } catch (err) {
        if (err instanceof ToolInputError) {
          return c.json({ ok: false, error: err.message, ...(err.field !== undefined && { field: err.field }) }, 400);
        }
        if (err instanceof UpstreamError) return c.json({ ok: false, error: err.message }, 502);
        console.error(`[lab] ${name}`, err);
        return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });
}
