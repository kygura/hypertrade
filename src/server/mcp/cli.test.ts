import { describe, expect, test } from "bun:test";
import { CliUsageError, parseArgs } from "./cli.js";
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
