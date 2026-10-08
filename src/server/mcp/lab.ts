import { LAB_INSTRUCTIONS, labPrompts, labTools } from "../lab/tools.js";
import type { Registry } from "./types.js";

export const LAB_SERVER_INFO = { name: "hypertrade-lab", version: "0.1.0" };

export function labRegistry(): Registry {
  return { tools: labTools(), prompts: labPrompts(), instructions: LAB_INSTRUCTIONS, serverInfo: LAB_SERVER_INFO };
}

/**
 * LAB_SEARCH_DEADLINE_MS when set to a positive number, else `fallback`
 * (50 000 on the server; undefined = no deadline for local CLI/stdio).
 */
export function labDeadlineMs(env: Record<string, string | undefined> = process.env, fallback?: number): number | undefined {
  const n = Number(env.LAB_SEARCH_DEADLINE_MS);
  return env.LAB_SEARCH_DEADLINE_MS && Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SERVER_DEADLINE_MS = 50_000;
