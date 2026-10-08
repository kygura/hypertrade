import { describe, expect, test } from "bun:test";
import { frame, owedIds, splitLines } from "./stdio.js";

describe("stdio framing", () => {
  test("splits complete lines and keeps the partial tail", () => {
    expect(splitLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' });
  });

  test("drops blank lines and CR", () => {
    expect(splitLines('\n{"a":1}\r\n  \n')).toEqual({ lines: ['{"a":1}'], rest: "" });
  });

  test("no newline yet → everything is rest", () => {
    expect(splitLines('{"a"')).toEqual({ lines: [], rest: '{"a"' });
  });

  test("frame is one compact line even with newlines in strings", () => {
    const out = frame({ text: "a\nb" });
    expect(out).toBe('{"text":"a\\nb"}\n');
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("owedIds", () => {
  test("requests owe replies; notifications and responses do not", () => {
    expect(owedIds({ jsonrpc: "2.0", id: 1, method: "ping" })).toEqual([1]);
    expect(owedIds({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual([]);
    expect(owedIds([{ id: "a", method: "x" }, { method: "n" }, { id: 2, result: {} }, 5])).toEqual(["a"]);
  });
});
