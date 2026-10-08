import { describe, expect, test } from "bun:test";
import { CliUsageError, parseArgs, SYNC_NO_DB_MESSAGE, SYNC_REMOTE_MESSAGE, syncPlan } from "./cli.js";
import type { ToolInputSchema } from "./types.js";

const schema: ToolInputSchema = {
  type: "object",
  properties: {
    asset: { type: "string" },
    assets: { type: "array", items: { type: "string" } },
    windows: { type: "array", items: { type: "integer" } },
    horizonDays: { type: "integer" },
    note: { type: ["string", "null"] },
  },
};

describe("parseArgs", () => {
  test("command, flags and JSON-ish values", () => {
    expect(parseArgs(["lab_search", "--trials", "50", "--fast", "--ratio", "0.5", "--on", "false", "--tags", '["a","b"]', "--name", "BTC"])).toEqual({
      command: "lab_search",
      args: { trials: 50, fast: true, ratio: 0.5, on: false, tags: ["a", "b"], name: "BTC" },
      local: false,
      pretty: false,
      help: false,
    });
  });

  test("--key=value, negative numbers, trailing flag", () => {
    expect(parseArgs(["t", "--a=1", "--b", "-2", "--c"]).args).toEqual({ a: 1, b: -2, c: true });
  });

  test("reserved flags", () => {
    expect(parseArgs(["tools", "--local", "--pretty"])).toMatchObject({ command: "tools", local: true, pretty: true, args: {} });
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["t", "-h"]).help).toBe(true);
  });

  test("without a schema, commas stay in strings", () => {
    expect(parseArgs(["t", "--assets", "BTC,ETH"]).args).toEqual({ assets: "BTC,ETH" });
  });

  test("schema: string props stay strings, arrays split on commas with typed items", () => {
    const { args } = parseArgs(["t", "--asset", "123", "--assets", "BTC, ETH", "--windows", "7,30", "--note", "true"], schema);
    expect(args).toEqual({ asset: "123", assets: ["BTC", "ETH"], windows: [7, 30], note: "true" });
  });

  test("schema: single array value is wrapped; JSON arrays pass through", () => {
    expect(parseArgs(["t", "--assets", "BTC"], schema).args).toEqual({ assets: ["BTC"] });
    expect(parseArgs(["t", "--windows", "[7,30]"], schema).args).toEqual({ windows: [7, 30] });
  });

  test("kebab-case maps to a camelCase property", () => {
    expect(parseArgs(["t", "--horizon-days", "10"], schema).args).toEqual({ horizonDays: 10 });
    expect(parseArgs(["t", "--horizon-days", "10"]).args).toEqual({ "horizon-days": 10 });
  });

  test("--json merges in order with flags", () => {
    expect(parseArgs(["t", "--json", '{"a":1,"b":2}', "--b", "3"]).args).toEqual({ a: 1, b: 3 });
    expect(parseArgs(["t", "--b", "3", "--json", '{"b":2}']).args).toEqual({ b: 2 });
  });

  test("usage errors", () => {
    expect(() => parseArgs(["t", "--json", "{nope"])).toThrow(CliUsageError);
    expect(() => parseArgs(["t", "--json", "[1]"])).toThrow(CliUsageError);
    expect(() => parseArgs(["t", "--json"])).toThrow(CliUsageError);
    expect(() => parseArgs(["t", "extra"])).toThrow("unexpected argument: extra");
  });
});

describe("sync", () => {
  test("parses as a command with --local / --force", () => {
    const cli = parseArgs(["sync", "--local", "--force"]);
    expect(cli.command).toBe("sync");
    expect(cli.local).toBe(true);
    expect(syncPlan(cli, { DATABASE_URL: "postgres://x" })).toEqual({ ok: true, force: true });
  });

  test("local by default without LAB_URL; needs a database", () => {
    expect(syncPlan(parseArgs(["sync"]), { POSTGRES_URL: "postgres://x" })).toEqual({ ok: true, force: false });
    expect(syncPlan(parseArgs(["sync"]), {})).toEqual({ ok: false, message: SYNC_NO_DB_MESSAGE });
    expect(syncPlan(parseArgs(["sync", "--local"]), { LAB_URL: "https://x" })).toEqual({ ok: false, message: SYNC_NO_DB_MESSAGE });
  });

  test("remote is refused: the deployed cron collects", () => {
    const plan = syncPlan(parseArgs(["sync"]), { LAB_URL: "https://x", DATABASE_URL: "postgres://x" });
    expect(plan).toEqual({ ok: false, message: SYNC_REMOTE_MESSAGE });
    expect(SYNC_REMOTE_MESSAGE).toContain("cron");
  });

  test("unknown options are refused", () => {
    expect(syncPlan(parseArgs(["sync", "--asset", "BTC"]), { DATABASE_URL: "postgres://x" })).toEqual({ ok: false, message: "sync: unknown option --asset" });
  });
});
