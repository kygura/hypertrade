import { expect, test } from "bun:test";
import { registeredIntelReadDeps } from "../llm/intelTools.js";
import { wireAgentReadTools } from "./agentData.js";

// scripts/desk-worker.ts never imports routes/analyst.ts, so it must call this itself.
test("wireAgentReadTools connects the intel read deps without the analyst route", async () => {
  wireAgentReadTools();
  // Reaches the store (which needs a database here), not the "not connected" guard.
  const err = await Promise.resolve(registeredIntelReadDeps.theses()).catch((e: Error) => e);
  expect(String(err)).not.toContain("not connected");
});
