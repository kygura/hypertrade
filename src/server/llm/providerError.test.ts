import { expect, test } from "bun:test";
import { providerError } from "./providerError.js";

test("providerError maps status codes and plain errors without leaking details", () => {
  const cases: [unknown, string][] = [
    [{ status: 401 }, "analyst provider rejected the credentials"],
    [{ status: 403 }, "analyst provider rejected the credentials"],
    [{ status: 429 }, "analyst provider is rate limiting; try again shortly"],
    [{ status: 500 }, "analyst provider error (HTTP 500)"],
    [new Error("boom"), "analyst provider error: boom"],
    ["str", "analyst provider error: str"],
  ];
  for (const [err, want] of cases) expect(providerError(err, "analyst provider")).toBe(want);
  expect(providerError(new Error("x".repeat(500)), "model provider")).toBe(`model provider error: ${"x".repeat(200)}`);
});
