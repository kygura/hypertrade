import type { ToolInputSchema } from "./types.js";

// Pure argument parsing for scripts/lab-cli.ts (kept here so `bun test src` covers it).

export const CLI_USAGE = `Usage:
  bun run lab tools                         list tools
  bun run lab sync [--local] [--force]      collect Lab history into Postgres now
                                            (needs DATABASE_URL; --force refetches full history)
  bun run lab <tool> [--key value ...]      run a tool
                     [--json '{...}']       arguments as one JSON object (merged in order)
                     [--local]              run in-process even when LAB_URL is set
                     [--pretty]             indent the JSON output
  bun run lab --help

Values are parsed as JSON when they can be (numbers, booleans, ["a","b"]),
otherwise taken as strings. For array arguments, a,b,c is split on commas.
A flag with no value is true. --some-key also matches someKey.

Remote when LAB_URL is set (Authorization: Bearer $LAB_API_TOKEN), otherwise
local (LAB_LOCAL=1, no deadline unless LAB_SEARCH_DEADLINE_MS is set).`;

export class CliUsageError extends Error {}

export interface CliArgs {
  command?: string;
  args: Record<string, unknown>;
  local: boolean;
  pretty: boolean;
  help: boolean;
}

type PropSchema = { type?: unknown; items?: unknown } | undefined;

function primaryType(p: PropSchema): string | undefined {
  if (!p || typeof p !== "object") return undefined;
  if (typeof p.type === "string") return p.type;
  if (Array.isArray(p.type)) return p.type.find((t): t is string => typeof t === "string" && t !== "null");
  return undefined;
}

function coerce(raw: string, prop: PropSchema): unknown {
  const type = primaryType(prop);
  if (type === "string") return raw;
  if (type === "array") {
    if (!raw.trimStart().startsWith("[") && raw.includes(",")) {
      const items = (prop as { items?: PropSchema }).items;
      return raw.split(",").map((s) => coerce(s.trim(), items));
    }
    const v = coerce(raw, undefined);
    return Array.isArray(v) ? v : [v];
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const camel = (k: string) => k.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * argv after the script name. `schema` (the tool's inputSchema, once known)
 * steers coercion: string props stay strings, array props split on commas.
 */
export function parseArgs(argv: string[], schema?: ToolInputSchema): CliArgs {
  const out: CliArgs = { args: {}, local: false, pretty: false, help: false };
  const props = (schema?.properties ?? {}) as Record<string, PropSchema>;
  const keyFor = (k: string) => (k in props || !(camel(k) in props) ? k : camel(k));

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--local" || a === "--pretty") {
      out[a === "--local" ? "local" : "pretty"] = true;
      continue;
    }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value: string | undefined = eq === -1 ? undefined : a.slice(eq + 1);
      if (value === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];

      if (name === "json") {
        if (value === undefined) throw new CliUsageError("--json needs a value");
        let obj: unknown;
        try {
          obj = JSON.parse(value);
        } catch {
          throw new CliUsageError("--json is not valid JSON");
        }
        if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new CliUsageError("--json must be a JSON object");
        Object.assign(out.args, obj);
        continue;
      }
      const key = keyFor(name);
      out.args[key] = value === undefined ? true : coerce(value, props[key]);
      continue;
    }
    if (out.command === undefined) {
      out.command = a;
      continue;
    }
    throw new CliUsageError(`unexpected argument: ${a}`);
  }
  return out;
}

export const SYNC_REMOTE_MESSAGE =
  "sync has no remote mode: the deployed cron (/api/cron/lab-collect) collects Lab history daily. Run `bun run lab sync --local` with DATABASE_URL set to collect from this machine.";
export const SYNC_NO_DB_MESSAGE = "sync --local writes to Postgres: set DATABASE_URL (or DATABASE_POSTGRES_URL / POSTGRES_URL)";

/**
 * `bun run lab sync`: the Lab collector in-process. Remote when LAB_URL is
 * set without --local (refused: the cron does it); local needs a database.
 */
export function syncPlan(cli: CliArgs, env: Record<string, string | undefined>): { ok: true; force: boolean } | { ok: false; message: string } {
  const unknown = Object.keys(cli.args).filter((k) => k !== "force");
  if (unknown.length) return { ok: false, message: `sync: unknown option --${unknown[0]}` };
  if (env.LAB_URL && !cli.local) return { ok: false, message: SYNC_REMOTE_MESSAGE };
  if (!(env.DATABASE_URL || env.DATABASE_POSTGRES_URL || env.POSTGRES_URL)) return { ok: false, message: SYNC_NO_DB_MESSAGE };
  return { ok: true, force: cli.args.force === true };
}
