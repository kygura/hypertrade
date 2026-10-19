import type { FeedRow, NearMiss, NoveltyEntry } from "../../shared/platform.js";
import type { Thesis } from "../../shared/intel.js";
import type { Trial } from "../lab/types.js";

// Assembly of one signals-routine snapshot (SIGNALS-ROUTINE.md). Pure: scripts/signals.ts does the I/O.
// Informational only; nothing here gates or places anything.

export interface SignalsRaw {
  nearMisses: NearMiss[];
  novelty: NoveltyEntry[];
  ready: Array<{ row: FeedRow; evidence: string }>;
  theses: Thesis[];
  /** null when the lab store is unreachable. `ruleInCatalogue`: the rule can be re-screened by id. */
  trials: Array<Trial & { ruleInCatalogue: boolean }> | null;
  myMarkets: string[];
}

export interface Signals {
  generatedAt: string;
  since: string;
  nearMiss: { top: NearMiss | null; all: NearMiss[] };
  novelty: NoveltyEntry[];
  ready: Array<{ id: string; coin: string; direction: string; setupKind: string; score: number; evidence: string }>;
  thesisWatch: Array<{ id: string; text: string; broken: string[] }>;
  lab: { universe: string[]; trials: SignalsRaw["trials"] };
  changes: { nearMiss: boolean; novelty: string[]; ready: { added: string[]; removed: string[] }; thesis: string[]; labTrials: number[] };
  changed: boolean;
}

const BAD = new Set(["contradicted", "triggered"]);
const nmKey = (n: NearMiss | null) => (n ? `${n.coin}|${n.setupKind}|${n.cond}` : "");
const DAY = 86_400_000;

/** Premises (claims, then invalidations, in stored order) whose latest check is bad after a good one at or before `since`. */
export function brokenPremises(t: Thesis, since: number): string[] {
  const h = t.history ?? [];
  const last = h.at(-1);
  const before = [...h].reverse().find((e) => Date.parse(e.ts) <= since) ?? (h.length > 1 ? h.at(-2) : undefined);
  if (!last || !before || last === before) return [];
  const texts = [...t.claims.map((c) => c.text), ...t.invalidation.map((i) => i.text)];
  return texts.filter((_, i) => BAD.has(last.checks[i]?.status ?? "") && !BAD.has(before.checks[i]?.status ?? "bad"));
}

export function assemble(raw: SignalsRaw, prev: Signals | null, now: Date): Signals {
  const since = prev?.generatedAt ?? new Date(now.getTime() - DAY).toISOString();
  const sinceMs = Date.parse(since);
  const novelty = raw.novelty.filter((e) => Date.parse(e.detectedAt) > sinceMs);
  const ready = raw.ready.map(({ row, evidence }) => ({ id: row.id, coin: row.coin, direction: row.direction, setupKind: row.setupKind, score: row.score, evidence }));
  const thesisWatch = raw.theses.map((t) => ({ id: t.id, text: t.text, broken: brokenPremises(t, sinceMs) })).filter((t) => t.broken.length);
  // Event-study screens are logged as trials too; only the other rows are authored ideas.
  const trials = raw.trials && raw.trials.filter((t) => Date.parse(t.at) > sinceMs && t.intent !== "lab_event_study");
  const prevReady = new Set(prev?.ready.map((r) => r.id));
  const top = raw.nearMisses[0] ?? null;
  const changes = {
    nearMiss: nmKey(top) !== nmKey(prev?.nearMiss.top ?? null),
    novelty: novelty.map((e) => e.id),
    ready: { added: ready.filter((r) => !prevReady.has(r.id)).map((r) => r.id), removed: [...prevReady].filter((id) => !ready.some((r) => r.id === id)) },
    thesis: thesisWatch.map((t) => t.id),
    labTrials: (trials ?? []).map((t) => t.n),
  };
  const changed = changes.nearMiss || changes.novelty.length > 0 || changes.ready.added.length > 0 || changes.ready.removed.length > 0 || changes.thesis.length > 0 || changes.labTrials.length > 0;
  return {
    generatedAt: now.toISOString(),
    since,
    nearMiss: { top, all: raw.nearMisses.slice(0, 5) },
    novelty,
    ready,
    thesisWatch,
    lab: { universe: raw.myMarkets, trials },
    changes,
    changed,
  };
}
