import type { AgentRecord, TriageItem } from "../../shared/agentRecords.js";
import { AssetSchema } from "../../shared/intel.js";
import type { NoveltyEntry, Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import { QUEUE_SOURCES, queueItemId, QueueResponseSchema, type QueueItem, type QueuePart, type QueueResponse, type QueueSource, type QueueSourceStatus, type QueueState } from "../../shared/queue.js";
import type { CatalogueEntry } from "../lab/types.js";
import type { QueueDismissal } from "../platform/store.js";
import { definitionSignal, noveltySignal, ruleSignal } from "../research/signals.js";
import { definitionForKind } from "../signals/definitions.js";
import type { DefinitionHit } from "../signals/scan.js";

// The queue merge (docs/SPEC.md § Queue). Pure: the same sources give the same queue.
// - One item per coin per UTC day, at most one part per source (opportunity: a ready one over a decided one, then
//   newest; radar: newest call; moves: the day's triage item; novelty: a pushed entry over one that was not, then
//   newest). Scores: 1 = crossed the source's own bar.
// - Witnesses (score 0): a catalogue rule or a signal definition in zone, and a novelty hit that was not pushed. They
//   fire daily on many coins, so they never list a coin and never re-open a dismissed one; they join a coin a
//   bar-crossing part listed, and count toward its ideas.
// - Ideas: parts that share a `thesis` (a setup and its daily definition) count once; every other part counts for
//   itself. No cross-source weighting: the sources' own numbers stay in their reasons.
// - One attention budget (`cap`, MOVES_TRIAGE_DAILY) across sources, strongest first: all the day's items by score,
//   then ideas, then earlier firstAt, then coin; the first `cap` are listed, the rest only counted
//   (`overCap`). A stronger arrival displaces the weakest listed item. Dismissed and acted items still count and compete.
//   Scores are not comparable across sources (a moves score is |z| / 2.5, unbounded; a ready setup and a radar call
//   are 1), so each source that crossed its bar first keeps one slot for its strongest item (slotOrder): eight triage
//   items cannot push the day's only ready setup or radar call over the cap.
// - State: acted (an opportunity decided today) > dismissed (every part at or before the dismissal) > new.
// - Display: new, acted, dismissed; then the same strength order as the slots.
// - Reasons are facts written by code; the radar thesis (LLM text) never enters a reason.

export type SourceInput<T> = { ok: T[] } | { unavailable: string };

/** Opportunity statuses that mean the operator decided it (approved or rejected, and what follows an approval). */
const DECIDED = new Set(["approved", "rejected", "open", "closed", "failed"]);
const SOURCE_ORDER = new Map(QUEUE_SOURCES.map((s, i) => [s, i]));
const STATE_ORDER: Record<QueueState, number> = { new: 0, acted: 1, dismissed: 2 };
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const coinHref = (coin: string) => `/coin/${encodeURIComponent(coin)}`;
const ms = (iso: string) => Date.parse(iso);
const isoOf = (t: number) => new Date(t).toISOString();
/** A price as the source states it, without float noise: 31.2, 0.0001234. */
const px = (x: number) => String(Number(x.toPrecision(6)));
const clip = (s: string) => s.slice(0, 200);

/** The UTC day before `day` (YYYY-MM-DD). */
const prevDay = (day: string) => isoOf(ms(`${day}T00:00:00Z`) - 86_400_000).slice(0, 10);

export function movesPart(t: TriageItem): QueuePart {
  return {
    source: "moves", ref: t.id, direction: null, reason: clip(t.reason), score: Math.max(0, t.score), thesis: null,
    at: isoOf(ms(t.surfacedAt)), actedAt: null, href: `/moves?coin=${encodeURIComponent(t.coin)}`,
  };
}

/** A ready opportunity, or one the operator decided since `dayStart`; null otherwise. */
export function opportunityPart(o: Opportunity, dayStart: Date): QueuePart | null {
  const decided = DECIDED.has(o.status) && ms(o.statusChangedAt) >= dayStart.getTime();
  if (o.status !== "ready" && !decided) return null;
  const net = o.netEdgeBps == null ? "" : ` · net ${o.netEdgeBps.toFixed(0)} bps`;
  return {
    source: "opportunity", ref: o.id, direction: o.direction, reason: clip(`${o.setupKind} ${o.direction} · ${o.status}${net}`), score: 1,
    thesis: definitionForKind(o.setupKind, o.direction)?.id ?? null,
    at: isoOf(ms(o.createdAt)), actedAt: decided ? isoOf(ms(o.statusChangedAt)) : null, href: `/feed?id=${encodeURIComponent(o.id)}`,
  };
}

/** A landed radar call as facts: stance, direction, kind and kill level (never the thesis). */
export function radarPart(c: RadarCall): QueuePart {
  const at = Number.isFinite(ms(c.at)) ? ms(c.at) : ms(`${c.date}T00:00:00Z`);
  return {
    source: "radar", ref: c.id, direction: c.direction, reason: clip(`${c.stance} ${c.direction} · ${c.kind} · kill ${px(c.kill_price)}`), score: 1, thesis: null,
    at: isoOf(at), actedAt: null, href: `/board?coin=${encodeURIComponent(c.market)}`,
  };
}

const boardHref = (coin: string) => `/board?coin=${encodeURIComponent(coin)}`;

/** A novelty hit as the board states it. A pushed one (a new extreme past the detector's cooldown and run budget) crossed the bar; the rest are witnesses. */
export function noveltyPart(e: NoveltyEntry): QueuePart {
  const s = noveltySignal(e);
  return { source: "novelty", ref: e.id, direction: null, reason: clip(s.headline), score: e.pushed ? 1 : 0, thesis: null, at: isoOf(s.at), actedAt: null, href: boardHref(e.coin) };
}

/** A catalogue rule in zone on the pulse's latest data: a witness. */
export function rulePart(e: CatalogueEntry, at: number): QueuePart {
  const s = ruleSignal(e, at);
  return { source: "rule", ref: e.id, direction: s.direction, reason: clip(s.headline), score: 0, thesis: null, at: isoOf(at), actedAt: null, href: s.href };
}

/** A signal definition in zone on the latest closed daily bar: a witness, with its definition as the thesis. */
export function definitionPart(h: DefinitionHit): QueuePart {
  const s = definitionSignal(h);
  return { source: "definition", ref: `${h.coin}:${h.definition.id}`, direction: s.direction, reason: clip(s.headline), score: 0, thesis: h.definition.id, at: isoOf(s.at), actedAt: null, href: boardHref(h.coin) };
}

/** Parts that share a thesis count once; every other part counts for itself. */
export const ideaCount = (parts: readonly Pick<QueuePart, "thesis">[]): number =>
  new Set(parts.flatMap((p) => p.thesis ?? [])).size + parts.filter((p) => p.thesis === null).length;

export interface MergeInput {
  day: string;
  now: Date;
  /** MOVES_TRIAGE_DAILY. */
  cap: number;
  /** A PUBLIC_MODE guest: no radar (LLM-written), no agent record. */
  guest: boolean;
  triage: SourceInput<TriageItem>;
  /** Agent records of the last 24 h (any order): a 24 h move investigated late yesterday is the same move today. */
  records: AgentRecord[];
  /** Ready opportunities and those decided today. */
  opportunities: SourceInput<Opportunity>;
  radar: SourceInput<RadarCall>;
  /** Novelty journal entries of recent bars (the merge keeps yesterday's and today's bars). */
  novelty: SourceInput<NoveltyEntry>;
  /** Catalogue rules firing on the latest pulse, each with the pulse's asOf (ms). */
  rules: SourceInput<{ entry: CatalogueEntry; at: number }>;
  /** Signal definitions in zone on the latest closed daily bar. */
  definitions: SourceInput<DefinitionHit>;
  /** Today's queue dismissals. */
  dismissals: QueueDismissal[];
}

export type MergedQueue = Omit<QueueResponse, "agentRuns" | "agentCap" | "agentBlockedReason" | "watched" | "freshness">;

type Candidate = { coin: string; part: QueuePart; rank: number };

const status = (src: SourceInput<unknown>, count: number): QueueSourceStatus =>
  "unavailable" in src ? { state: "unavailable", reason: src.unavailable, count: 0 } : { state: "ok", reason: null, count };

/** One part per coin from one source: the lowest `rank`, then the newest `at`. */
function bestPerCoin(cs: Candidate[]): Map<string, QueuePart> {
  const out = new Map<string, Candidate>();
  for (const c of cs) {
    const prev = out.get(c.coin);
    if (!prev || c.rank < prev.rank || (c.rank === prev.rank && ms(c.part.at) > ms(prev.part.at))) out.set(c.coin, c);
  }
  return new Map([...out].map(([k, v]) => [k, v.part]));
}

const validCoin = (coin: string) => AssetSchema.safeParse(coin).success;

/** The agent does not investigate a coin twice in 24 h (moves/agentLoop.ts), so the queue shows a record that long. */
export const RECORD_WINDOW_MS = 24 * 3_600_000;

/**
 * The order slots are given in, from items sorted strongest first: one item per source that crossed its bar (its
 * strongest; an item already reserved that carries the source's part counts for it), those in strength order, then
 * everything else in strength order. With one source it is the input order.
 */
export function slotOrder(sorted: readonly QueueItem[]): QueueItem[] {
  const reserved: QueueItem[] = [];
  for (const s of QUEUE_SOURCES) {
    const has = (i: QueueItem) => i.parts.some((p) => p.source === s && p.score > 0);
    const best = reserved.some(has) ? undefined : sorted.find(has);
    if (best) reserved.push(best);
  }
  const keep = new Set(reserved);
  return [...sorted.filter((i) => keep.has(i)), ...sorted.filter((i) => !keep.has(i))];
}

export function mergeQueue(q: MergeInput): MergedQueue {
  const dayStart = new Date(`${q.day}T00:00:00Z`);
  const radarIn: SourceInput<RadarCall> = q.guest ? { unavailable: "sign in required" } : q.radar;
  const triage = "ok" in q.triage ? q.triage.ok.filter((t) => t.day === q.day && validCoin(t.coin)) : [];
  const moves = bestPerCoin(triage.map((t) => ({ coin: t.coin, part: movesPart(t), rank: 0 })));
  const opps = bestPerCoin(
    ("ok" in q.opportunities ? q.opportunities.ok : []).flatMap((o) => {
      const part = opportunityPart(o, dayStart);
      return part && validCoin(o.coin) ? [{ coin: o.coin, part, rank: o.status === "ready" ? 0 : 1 }] : [];
    }),
  );
  const yesterday = prevDay(q.day);
  const radar = bestPerCoin(
    ("ok" in radarIn ? radarIn.ok : [])
      .filter((c) => c.killed_at === null && c.date >= yesterday && c.date <= q.day && validCoin(c.market))
      .map((c) => ({ coin: c.market, part: radarPart(c), rank: 0 })),
  );
  const rows = <T>(src: SourceInput<T>) => ("ok" in src ? src.ok : []);
  const novelty = bestPerCoin(
    rows(q.novelty).filter((e) => e.barDate >= yesterday && e.barDate <= q.day && validCoin(e.coin)).map((e) => ({ coin: e.coin, part: noveltyPart(e), rank: e.pushed ? 0 : 1 })),
  );
  const rule = bestPerCoin(rows(q.rules).filter((r) => validCoin(r.entry.rule.asset)).map((r) => ({ coin: r.entry.rule.asset, part: rulePart(r.entry, r.at), rank: 0 })));
  const definition = bestPerCoin(rows(q.definitions).filter((h) => validCoin(h.coin)).map((h) => ({ coin: h.coin, part: definitionPart(h), rank: 0 })));
  const bySource: Record<QueueSource, Map<string, QueuePart>> = { moves, opportunity: opps, radar, novelty, rule, definition };

  const triageByCoin = new Map(triage.map((t) => [t.coin, t]));
  const dismissedByCoin = new Map(q.dismissals.filter((d) => d.day === q.day).map((d) => [d.coin, ms(d.dismissedAt)]));
  const recordsById = new Map(q.records.map((r) => [r.id, r]));
  const newestRecord = new Map<string, AgentRecord>();
  for (const r of q.records) {
    if (ms(r.createdAt) < q.now.getTime() - RECORD_WINDOW_MS) continue;
    const prev = newestRecord.get(r.coin);
    if (!prev || ms(r.createdAt) > ms(prev.createdAt) || (r.createdAt === prev.createdAt && r.id < prev.id)) newestRecord.set(r.coin, r);
  }

  // A coin is listed by a part that crossed its source's bar; witnesses alone list nothing.
  const coins = new Set(QUEUE_SOURCES.flatMap((s) => [...bySource[s]].flatMap(([coin, p]) => (p.score > 0 ? [coin] : []))));
  const items: QueueItem[] = [...coins].map((coin) => {
    const parts = QUEUE_SOURCES.flatMap((s) => bySource[s].get(coin) ?? [])
      .sort((x, y) => y.score - x.score || SOURCE_ORDER.get(x.source)! - SOURCE_ORDER.get(y.source)!);
    const ats = parts.filter((p) => p.score > 0).map((p) => ms(p.at));
    const t = triageByCoin.get(coin);
    const dismissals = [dismissedByCoin.get(coin), t?.dismissedAt ? ms(t.dismissedAt) : undefined].filter((x): x is number => x !== undefined);
    const dismissedAt = dismissals.length ? Math.max(...dismissals) : null;
    const state: QueueState = parts.some((p) => p.actedAt !== null)
      ? "acted"
      : dismissedAt !== null && ats.every((a) => a <= dismissedAt)
        ? "dismissed"
        : "new";
    const linked = t?.recordId ? recordsById.get(t.recordId) : undefined;
    return {
      id: queueItemId(q.day, coin), day: q.day, coin, reason: parts[0]!.reason, score: Math.max(...parts.map((p) => p.score)), ideas: ideaCount(parts),
      firstAt: isoOf(Math.min(...ats)), lastAt: isoOf(Math.max(...ats)), state, dismissedAt: dismissedAt === null ? null : isoOf(dismissedAt),
      parts, record: q.guest ? null : (linked ?? newestRecord.get(coin) ?? null), href: coinHref(coin),
    };
  });

  // Slots: one per bar-crossing source, then strongest first (score, ideas, earlier firstAt, coin); display: state, then strength.
  const cap = Math.max(0, Math.floor(q.cap));
  const strength = (x: QueueItem, y: QueueItem) =>
    y.score - x.score || y.ideas - x.ideas || ms(x.firstAt) - ms(y.firstAt) || cmp(x.coin, y.coin);
  const slotted = slotOrder([...items].sort(strength));
  const listed = slotted.slice(0, cap).sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || strength(x, y));

  return QueueResponseSchema.omit({ agentRuns: true, agentCap: true, agentBlockedReason: true, watched: true, freshness: true }).parse({
    asOf: q.now.toISOString(),
    day: q.day,
    cap,
    overCap: slotted.length - listed.length,
    sources: { moves: status(q.triage, moves.size), opportunity: status(q.opportunities, opps.size), radar: status(radarIn, radar.size),
      novelty: status(q.novelty, novelty.size), rule: status(q.rules, rule.size), definition: status(q.definitions, definition.size),
    },
    items: listed,
  });
}
