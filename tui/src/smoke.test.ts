import { expect, test } from "bun:test";
import { signL1Action } from "../../src/server/desk/hl/signing.js";
import { evaluateRisk } from "../../src/server/desk/governor.js";
import { evaluateTriggers } from "../../src/server/desk/triggers.js";
import { resolveOrder } from "../../src/server/intel/order-resolve.js";
import { walkBook } from "../../src/server/platform/costs.js";
import { resolveProvider } from "../../src/server/llm/provider.js";

test("light hypertrade modules resolve from tui/", () => {
  for (const fn of [resolveOrder, evaluateTriggers, evaluateRisk, signL1Action, walkBook, resolveProvider]) {
    expect(typeof fn).toBe("function");
  }
});
