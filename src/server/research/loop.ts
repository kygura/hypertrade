import { STUDY_DEFAULTS, type ResearchSignal, type StudyRequest } from "../../shared/research.js";
import type { LoopDef } from "../platform/runtime.js";
import { studyScope, utcDay, type StudyRunner } from "./study.js";

// Always-on precompute (docs/RESEARCH.md B2): studies for the board's rule-bearing signals, so it opens with evidence
// attached. Bounded: at most MAX_STUDIES_PER_CYCLE per beat and never the same study twice in a UTC day, whether it
// succeeded or failed. Each study is a Lab trial like any other.

export const MAX_STUDIES_PER_CYCLE = 3;
export const RESEARCH_LOOP_SEC = 900;

/** The next studies to run: rule-bearing signals without evidence, newest first, skipping scopes tried today. Pure. */
export function pickStudies(signals: Pick<ResearchSignal, "rule" | "coin" | "evidence" | "at">[], triedToday: ReadonlySet<string>, max = MAX_STUDIES_PER_CYCLE): StudyRequest[] {
  const out: StudyRequest[] = [];
  const seen = new Set(triedToday);
  for (const s of [...signals].sort((a, b) => b.at - a.at)) {
    if (out.length >= max) break;
    if (!s.rule || s.evidence) continue;
    const q: StudyRequest = { rule: s.rule, coin: s.coin, ...STUDY_DEFAULTS };
    const scope = studyScope(q);
    if (seen.has(scope)) continue;
    seen.add(scope);
    out.push(q);
  }
  return out;
}

export interface ResearchLoopDeps {
  /** The board's signals (evidence attached from the cache). */
  signals: () => Promise<ResearchSignal[]>;
  runStudy: StudyRunner;
  now?: () => number;
  max?: number;
}

export function createResearchLoop(deps: ResearchLoopDeps) {
  const now = deps.now ?? Date.now;
  let day = "";
  const tried = new Set<string>();

  async function tick() {
    const today = utcDay(now());
    if (today !== day) (day = today), tried.clear();
    const picks = pickStudies(await deps.signals(), tried, deps.max ?? MAX_STUDIES_PER_CYCLE);
    for (const q of picks) {
      tried.add(studyScope(q));
      try {
        await deps.runStudy(q, { source: "api" });
      } catch (err) {
        console.error(`[research] study ${q.coin} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return { tick, tried: () => new Set(tried), def: { name: "research", intervalSec: RESEARCH_LOOP_SEC, run: tick } satisfies LoopDef };
}
