// Reads the routine's committed outputs (data/marketstate/latest.json and
// data/sectors/latest.json) for the TUI's /brief command and the agent's
// get_brief tool. Read-only; the files are validated with the same zod
// schemas the routine and the web app use.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MarketStateDataSchema, SectorsDataSchema } from "../../../src/shared/schemas.js";

export interface BriefSector {
  name: string;
  /** mindshare_score, 0..1. */
  score: number;
  note: string;
}

export interface Brief {
  /** YYYY-MM-DD from marketstate generated_at. */
  date: string;
  headline: string;
  tldr: string;
  /** Regime phrase pulled from the tldr ("Regime: …"); undefined when the tldr has none. */
  regime?: string;
  risks: string[];
  /** Top 5 by mindshare_score, descending. Empty when the sectors file is missing. */
  sectors: BriefSector[];
}

const SECTOR_LIMIT = 5;

/** The repo root: tui/src/core → ../../.. */
export function defaultRepoRoot(): string {
  return resolve(import.meta.dir, "../../..");
}

async function readJson(path: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${path}: invalid JSON`);
  }
}

function regimeFrom(tldr: string): string | undefined {
  const m = /Regime:\s*([^(.;]+?)\s*(?:\(|\.|;|$)/i.exec(tldr);
  const phrase = m?.[1]?.trim();
  return phrase ? phrase : undefined;
}

/** Null when data/marketstate/latest.json is missing. Throws on unreadable or schema-invalid files. */
export async function loadBrief(repoRoot: string = defaultRepoRoot()): Promise<Brief | null> {
  const msPath = join(repoRoot, "data", "marketstate", "latest.json");
  const msRaw = await readJson(msPath);
  if (msRaw === null) return null;
  const ms = MarketStateDataSchema.safeParse(msRaw);
  if (!ms.success) throw new Error(`${msPath}: ${ms.error.issues[0]?.message ?? "invalid"}`);

  const secPath = join(repoRoot, "data", "sectors", "latest.json");
  const secRaw = await readJson(secPath);
  let sectors: BriefSector[] = [];
  if (secRaw !== null) {
    const sec = SectorsDataSchema.safeParse(secRaw);
    if (!sec.success) throw new Error(`${secPath}: ${sec.error.issues[0]?.message ?? "invalid"}`);
    sectors = [...sec.data.sectors]
      .sort((a, b) => b.mindshare_score - a.mindshare_score)
      .slice(0, SECTOR_LIMIT)
      .map((s) => ({ name: s.label, score: s.mindshare_score, note: s.rationale }));
  }

  const d = ms.data;
  const regime = regimeFrom(d.tldr);
  return {
    date: d.generated_at.slice(0, 10),
    headline: d.headline,
    tldr: d.tldr,
    ...(regime ? { regime } : {}),
    risks: [...d.risks],
    sectors,
  };
}
