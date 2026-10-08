// bun run lab tools | bun run lab <tool> [--key value ...] [--json '{...}'] [--local] [--pretty]
// Remote (LAB_URL set, no --local): the deployed REST surface with a bearer.
// Local: the tool registry in-process (LAB_LOCAL=1), source "cli", no deadline
// unless LAB_SEARCH_DEADLINE_MS is set. Result JSON on stdout, errors on stderr.
import { CLI_USAGE, CliUsageError, parseArgs } from "../src/server/mcp/cli.js";
import { describeTool, ToolInputError, type ToolDef, type ToolInputSchema } from "../src/server/mcp/types.js";

type Listed = { name: string; inputSchema: ToolInputSchema };

class CliError extends Error {}

const write = (stream: NodeJS.WriteStream, text: string) => new Promise<void>((resolve) => stream.write(text, () => resolve()));

async function remote(path: string, init?: { body: unknown }): Promise<unknown> {
  const base = process.env.LAB_URL!.replace(/\/+$/, "");
  const headers: Record<string, string> = { "x-lab-source": "cli", accept: "application/json" };
  if (process.env.LAB_API_TOKEN) headers.authorization = `Bearer ${process.env.LAB_API_TOKEN}`;
  if (init) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api/lab${path}`, {
    method: init ? "POST" : "GET",
    headers,
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: { ok?: boolean; result?: unknown; error?: string; field?: string } | undefined;
  try {
    body = JSON.parse(text);
  } catch {
    // fall through with the raw text
  }
  if (res.status === 401) throw new CliError(`unauthorized at ${base} (set LAB_API_TOKEN)`);
  if (!res.ok || body?.ok === false) {
    const msg = body?.error ?? text.slice(0, 300) ?? res.statusText;
    throw new CliError(`${msg}${body?.field ? ` (field: ${body.field})` : ""} [HTTP ${res.status}]`);
  }
  return init ? body?.result : body;
}

async function localTools(): Promise<ToolDef[]> {
  process.env.LAB_LOCAL = "1";
  const { labTools } = await import("../src/server/lab/tools.js");
  return labTools();
}

async function main(argv: string[]): Promise<unknown> {
  const first = parseArgs(argv);
  if (first.help || !first.command) {
    await write(first.help ? process.stdout : process.stderr, `${CLI_USAGE}\n`);
    if (!first.help) throw new CliError("missing <tool>");
    return undefined;
  }
  const isRemote = !!process.env.LAB_URL && !first.local;
  const local = isRemote ? null : await localTools();
  const listing = isRemote ? (((await remote("/tools")) as { tools: Listed[] }).tools ?? []) : local!.map(describeTool);

  if (first.command === "tools") return { tools: listing };

  const listed = listing.find((t) => t.name === first.command);
  if (!listed) throw new CliError(`unknown tool: ${first.command} (bun run lab tools lists them)`);
  const { args } = parseArgs(argv, listed.inputSchema);

  if (isRemote) return remote(`/tools/${encodeURIComponent(listed.name)}`, { body: args });

  const { labDeadlineMs } = await import("../src/server/mcp/lab.js");
  const tool = local!.find((t) => t.name === listed.name)!;
  try {
    return await tool.run(args, { source: "cli", deadlineMs: labDeadlineMs(process.env) });
  } catch (err) {
    if (err instanceof ToolInputError) throw new CliError(`${err.message}${err.field ? ` (field: ${err.field})` : ""}`);
    throw err;
  }
}

const argv = process.argv.slice(2);
const pretty = argv.includes("--pretty");
try {
  const result = await main(argv);
  if (result !== undefined) await write(process.stdout, `${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`);
  process.exit(0);
} catch (err) {
  const msg = err instanceof CliError || err instanceof CliUsageError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
  await write(process.stderr, `lab: ${msg}\n`);
  process.exit(1);
}
