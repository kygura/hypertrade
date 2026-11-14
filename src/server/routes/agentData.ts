import { intelReadDeps, registerIntelReadDeps } from "../llm/intelTools.js";
import { defaultIntelDeps } from "./intel/index.js";
import { platformContext } from "./research.js";

// Production wiring for the analyst's and desk agents' intel/platform read tools.
// Lives in routes/ (not llm/) because it imports the intel and platform wiring,
// which import the desk, which imports llm/tools.ts. Resolved per call, so
// registering does no I/O.

export function wireAgentReadTools(): void {
  registerIntelReadDeps(
    intelReadDeps({
      intel: {
        listAlerts: (o) => defaultIntelDeps().store.listAlerts(o),
        latestBrief: (s) => defaultIntelDeps().store.latestBrief(s),
        listTheses: () => defaultIntelDeps().store.listTheses(),
      },
      platform: () => platformContext()?.store ?? null,
      exposure: () => defaultIntelDeps().exposure(),
    }),
  );
}
