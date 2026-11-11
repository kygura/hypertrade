import type { AgentRecord, TriageItem } from "../../shared/agentRecords.js";
import { AssetSchema } from "../../shared/intel.js";
import type { Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import { QUEUE_SOURCES, queueItemId, QueueResponseSchema, type QueueItem, type QueuePart, type QueueResponse, type QueueSource, type QueueSourceStatus, type QueueState } from "../../shared/queue.js";
import type { QueueDismissal } from "../platform/store.js";

// The queue merge (docs/SPEC.md § Queue). Pure: the same sources give the same queue.
// - One item per coin per UTC day, at most one part per source (opportunity: a ready one over a decided one, then
//   newest; radar: newest call; moves: the day's triage item). Scores: 1 = crossed the source's own bar.
// - One attention budget (`cap`, MOVES_TRIAGE_DAILY) across sources, strongest first: all the day's items by score,
//   then agreeing sources, then earlier firstAt, then coin; the first `cap` are listed, the rest only counted
//   (`overCap`). A stronger arrival displaces the weakest listed item. Dismissed and acted items still count and compete.
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
    source: "moves", ref: t.id, direction: null, reason: clip(t.reason), score: Math.max(0, t.score),
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
    at: isoOf(ms(o.createdAt)), actedAt: decided ? isoOf(ms(o.statusChangedAt)) : null, href: `/feed?id=${encodeURIComponent(o.id)}`,
  };
}

/** A landed radar call as facts: stance, direction, kind and kill level (never the thesis). */
export function radarPart(c: RadarCall): QueuePart {
  const at = Number.isFinite(ms(c.at)) ? ms(c.at) : ms(`${c.date}T00:00:00Z`);
  return {
    source: "radar", ref: c.id, direction: c.direction, reason: clip(`${c.stance} ${c.direction} · ${c.kind} · kill ${px(c.kill_price)}`), score: 1,
    at: isoOf(at), actedAt: null, href: `/board?coin=${encodeURIComponent(c.market)}`,
  };
}

export interface MergeInput {
  day: string;
  now: Date;
  /** MOVES_TRIAGE_DAILY. */
  cap: number;
  /** A PUBLIC_MODE guest: no radar (LLM-written), no agent record. */
  guest: boolean;
  triage: SourceInput<TriageItem>;
  /** Today's agent records (any order). */
  records: AgentRecord[];
  /** Ready opportunities and those decided today. */
  opportunities: SourceInput<Opportunity>;
  radar: SourceInput<RadarCall>;
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
  const bySource: Record<QueueSource, Map<string, QueuePart>> = { moves, opportunity: opps, radar };

  const triageByCoin = new Map(triage.map((t) => [t.coin, t]));
  const dismissedByCoin = new Map(q.dismissals.filter((d) => d.day === q.day).map((d) => [d.coin, ms(d.dismissedAt)]));
  const recordsById = new Map(q.records.map((r) => [r.id, r]));
  const newestRecord = new Map<string, AgentRecord>();
  for (const r of q.records) {
    if (ms(r.createdAt) < dayStart.getTime()) continue;
    const prev = newestRecord.get(r.coin);
    if (!prev || ms(r.createdAt) > ms(prev.createdAt) || (r.createdAt === prev.createdAt && r.id < prev.id)) newestRecord.set(r.coin, r);
  }

  const coins = new Set(QUEUE_SOURCES.flatMap((s) => [...bySource[s].keys()]));
  const items: QueueItem[] = [...coins].map((coin) => {
    const parts = QUEUE_SOURCES.flatMap((s) => bySource[s].get(coin) ?? [])
      .sort((x, y) => y.score - x.score || SOURCE_ORDER.get(x.source)! - SOURCE_ORDER.get(y.source)!);
    const ats = parts.map((p) => ms(p.at));
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
      id: queueItemId(q.day, coin), day: q.day, coin, reason: parts[0]!.reason, score: Math.max(...parts.map((p) => p.score)),
      firstAt: isoOf(Math.min(...ats)), lastAt: isoOf(Math.max(...ats)), state, dismissedAt: dismissedAt === null ? null : isoOf(dismissedAt),
      parts, record: q.guest ? null : (linked ?? newestRecord.get(coin) ?? null), href: coinHref(coin),
    };
  });

  // Slots: strongest first (score, agreeing sources, earlier firstAt, coin); display: state, then the same order.
  const cap = Math.max(0, Math.floor(q.cap));
  const strength = (x: QueueItem, y: QueueItem) =>
    y.score - x.score || y.parts.length - x.parts.length || ms(x.firstAt) - ms(y.firstAt) || cmp(x.coin, y.coin);
  const slotted = [...items].sort(strength);
  const listed = slotted.slice(0, cap).sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || strength(x, y));

  return QueueResponseSchema.omit({ agentRuns: true, agentCap: true, agentBlockedReason: true, watched: true, freshness: true }).parse({
    asOf: q.now.toISOString(),
    day: q.day,
    cap,
    overCap: slotted.length - listed.length,
    sources: { moves: status(q.triage, moves.size), opportunity: status(q.opportunities, opps.size), radar: status(radarIn, radar.size) },
    items: listed,
  });
}
