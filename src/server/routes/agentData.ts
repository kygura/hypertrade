import { intelReadDeps, registerIntelReadDeps } from "../llm/intelTools.js";
import { defaultIntelDeps } from "./intel/index.js";
import { defaultPlatformDeps } from "./platform.js";

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
      platform: () => platformDeps().context()?.store ?? null,
      exposure: () => defaultIntelDeps().exposure(),
    }),
  );
}

let platform: ReturnType<typeof defaultPlatformDeps> | null = null;
const platformDeps = () => (platform ??= defaultPlatformDeps());
