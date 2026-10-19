import type { FeedRow, NearMiss, NoveltyEntry } from "../../shared/platform.js";
import type { Thesis } from "../../shared/intel.js";
import type { Trial } from "../lab/types.js";

// Assembly of one signals-routine snapshot (SIGNALS-ROUTINE.md). Pure: scripts/signals.ts does the I/O.
// Informational only; nothing here gates or places anything.

/** A section that could not be read this run: its source and a short code ("HTTP 503", "error"). */
export interface Gap { source: string; code: string }

/** A null section was unavailable (see `gaps`); it counts as no change and keeps the previous run's value. */
export interface SignalsRaw {
  nearMisses: NearMiss[] | null;
  novelty: NoveltyEntry[] | null;
  ready: Array<{ row: FeedRow; evidence: string }> | null;
  theses: Thesis[] | null;
  /** null when the lab store is unreachable. A trial with a `rule` can be re-screened; older rows have none. */
  trials: Trial[] | null;
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
  gaps: Gap[];
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

export function assemble(raw: SignalsRaw, prev: Signals | null, now: Date, gaps: Gap[] = []): Signals {
  const prevAt = Date.parse(prev?.generatedAt ?? "");
  const since = Number.isFinite(prevAt) ? prev!.generatedAt : new Date(now.getTime() - DAY).toISOString();
  const sinceMs = Date.parse(since);
  const novelty = (raw.novelty ?? []).filter((e) => Date.parse(e.detectedAt) > sinceMs);
  const prevReadyRows = prev?.ready ?? [];
  const ready = raw.ready
    ? raw.ready.map(({ row, evidence }) => ({ id: row.id, coin: row.coin, direction: row.direction, setupKind: row.setupKind, score: row.score, evidence }))
    : prevReadyRows;
  const thesisWatch = (raw.theses ?? []).map((t) => ({ id: t.id, text: t.text, broken: brokenPremises(t, sinceMs) })).filter((t) => t.broken.length);
  // Event-study screens are logged as trials too; only the other rows are authored ideas.
  const trials = raw.trials && raw.trials.filter((t) => Date.parse(t.at) > sinceMs && t.intent !== "lab_event_study");
  const prevReady = new Set(prevReadyRows.map((r) => r.id));
  const prevTop = prev?.nearMiss?.top ?? null;
  const nearMiss = raw.nearMisses ? { top: raw.nearMisses[0] ?? null, all: raw.nearMisses.slice(0, 5) } : { top: prevTop, all: prev?.nearMiss?.all ?? [] };
  const changes = {
    nearMiss: nmKey(nearMiss.top) !== nmKey(prevTop),
    novelty: novelty.map((e) => e.id),
    ready: { added: ready.filter((r) => !prevReady.has(r.id)).map((r) => r.id), removed: [...prevReady].filter((id) => !ready.some((r) => r.id === id)) },
    thesis: thesisWatch.map((t) => t.id),
    labTrials: (trials ?? []).map((t) => t.n),
  };
  const changed = changes.nearMiss || changes.novelty.length > 0 || changes.ready.added.length > 0 || changes.ready.removed.length > 0 || changes.thesis.length > 0 || changes.labTrials.length > 0;
  return { generatedAt: now.toISOString(), since, nearMiss, novelty, ready, thesisWatch, lab: { universe: raw.myMarkets, trials }, changes, changed, gaps };
}

const codeOf = (err: unknown) => /HTTP \d+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "error";

export interface Fetchers {
  prev: () => Promise<Signals | null>;
  nearMisses: () => Promise<SignalsRaw["nearMisses"]>;
  novelty: () => Promise<SignalsRaw["novelty"]>;
  ready: () => Promise<SignalsRaw["ready"]>;
  theses: () => Promise<SignalsRaw["theses"]>;
  trials: () => Promise<SignalsRaw["trials"]>;
  myMarkets: string[];
}

/** Reads every section on its own: a failure becomes a gap, never an abort. */
export async function collectSignals(f: Fetchers, now: Date): Promise<Signals> {
  const gaps: Gap[] = [];
  const guard = async <T>(source: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      gaps.push({ source, code: codeOf(err) });
      return null;
    }
  };
  const prev = await guard("prev", f.prev);
  const raw: SignalsRaw = {
    nearMisses: await guard("near-miss", f.nearMisses),
    novelty: await guard("novelty", f.novelty),
    ready: await guard("opportunities", f.ready),
    theses: await guard("theses", f.theses),
    trials: await guard("lab-trials", f.trials),
    myMarkets: f.myMarkets,
  };
  return assemble(raw, prev, now, gaps);
}
