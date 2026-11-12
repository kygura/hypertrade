import type { AgentRecord, TriageItem } from "../../shared/agentRecords.js";
import { simplePct, type MoveRow } from "../../shared/moves.js";

// Triage queue (docs/SPEC.md § Moves, plan §3.6). Pure: same rows and same stored items give the same queue.
// Agents widen what is watched; this ranks what reaches the human, under a daily attention budget.
// - Candidates: |residualZ(24h)| ≥ 2.5 with a 24h move ≥ 1%, or a checklist with every one of ≥ 3 checks met.
// - Score max(|z|/2.5, met/of); ties: no news in the window first, then the larger |residual|, then the coin.
// - One item per coin per UTC day; a coin re-enters only when |z| rose by ≥ 1 over its surfaced value.
// - At most `budget` items per UTC day. Dismissed items still count; candidates past the budget are only counted.

export const TRIAGE_Z = 2.5;
export const TRIAGE_MIN_MOVE_PCT = 1;
export const TRIAGE_MIN_CHECKS = 3;
export const TRIAGE_REENTRY_DZ = 1;
/** MOVES_TRIAGE_DAILY default. */
export const DEFAULT_TRIAGE_DAILY = 8;
/** MOVES_AGENT_DAILY default. */
export const DEFAULT_AGENT_DAILY = 6;

const intEnv = (v: string | undefined, def: number) => (v?.trim() && Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : def);
export const triageBudget = (env: Record<string, string | undefined> = process.env) => intEnv(env.MOVES_TRIAGE_DAILY, DEFAULT_TRIAGE_DAILY);
export const agentDailyCap = (env: Record<string, string | undefined> = process.env) => intEnv(env.MOVES_AGENT_DAILY, DEFAULT_AGENT_DAILY);

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const utcDayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const triageId = (day: string, coin: string) => `${day}:${coin}`;

export interface TriageCandidate {
  coin: string;
  score: number;
  /** |residual z| over 24h; null when the coin has no attribution or no σ. */
  residualZ: number | null;
  residualPct: number | null;
  /** The window had zero news hours (false when the news layer is unknown). */
  noNews: boolean;
  /** The news layer is unknown (no feed ingested, no store): neither "no news" nor "news". */
  newsUnknown: boolean;
  /** Qualified on the residual (|z| ≥ 2.5 with a ≥ 1% move), not only on a checklist. */
  byResidual: boolean;
  reason: string;
}

const signed = (x: number, d = 1) => `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(d)}`;
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** The coin's candidate, or null when nothing crosses the bar. Reads only the 24h attribution. */
export function candidateOf(row: MoveRow): TriageCandidate | null {
  const a = row.attribution?.window === "24h" ? row.attribution : null;
  const z = a?.residualZ == null ? null : Math.abs(a.residualZ);
  const byResidual = a !== null && z !== null && z >= TRIAGE_Z && Math.abs(a.totalPct) >= TRIAGE_MIN_MOVE_PCT;
  const full = row.setups.filter((s) => s.of >= TRIAGE_MIN_CHECKS && s.met === s.of).sort((x, y) => cmp(x.kind, y.kind));
  if (!byResidual && !full.length) return null;
  const parts: string[] = [];
  if (byResidual) {
    const news = a.newsHours === null ? "news unknown" : a.newsHours === 0 ? "no news in window" : `news in ${a.newsHours}h`;
    parts.push(`residual ${signed(simplePct(a.residualPct))}% · z ${signed(a.residualZ!)} · 24h · ${news}`);
  }
  for (const s of full) {
    const crowd = s.kind === "fade" && s.side ? ` · crowd ${s.side} ${s.side === "long" ? row.positioning.longMet : row.positioning.shortMet}/${row.positioning.of}` : s.side ? ` · ${s.side}` : "";
    parts.push(`${s.kind.toUpperCase()} ${s.met}/${s.of}${crowd}`);
  }
  return {
    coin: row.coin,
    score: Math.max(byResidual ? z! / TRIAGE_Z : 0, ...full.map((s) => s.met / s.of)),
    residualZ: z,
    residualPct: a?.residualPct ?? null,
    noNews: a?.newsHours === 0,
    newsUnknown: a != null && a.newsHours === null,
    byResidual,
    reason: parts.join(" · ").slice(0, 200),
  };
}

/** Rank order: score desc, no news first, |residual| desc, coin. */
export function rankCandidates(cs: TriageCandidate[]): TriageCandidate[] {
  return [...cs].sort((x, y) => y.score - x.score || Number(y.noNews) - Number(x.noNews) || Math.abs(y.residualPct ?? 0) - Math.abs(x.residualPct ?? 0) || cmp(x.coin, y.coin));
}

export interface TriagePlan {
  /** Items to write: new ones within the budget and re-entered ones (same id, fresh numbers, undismissed). */
  upserts: TriageItem[];
  /** New candidates that crossed the bar after the day's budget was spent. */
  overBudget: number;
  candidates: TriageCandidate[];
}

/** One scan against the day's stored items. `existing` must be the items of `day`. */
export function planTriage(q: { rows: MoveRow[]; existing: TriageItem[]; day: string; now: Date; budget: number }): TriagePlan {
  const candidates = rankCandidates(q.rows.flatMap((r) => candidateOf(r) ?? []));
  const byCoin = new Map(q.existing.filter((t) => t.day === q.day).map((t) => [t.coin, t]));
  let room = Math.max(0, q.budget - byCoin.size);
  let overBudget = 0;
  const at = q.now.toISOString();
  const upserts: TriageItem[] = [];
  for (const c of candidates) {
    const prev = byCoin.get(c.coin);
    if (prev) {
      // A surfaced item stays surfaced; it re-enters (fresh numbers, shown again) only on a real rise in |z|.
      if (c.residualZ !== null && prev.residualZ !== null && c.residualZ >= prev.residualZ + TRIAGE_REENTRY_DZ)
        upserts.push({ ...prev, reason: c.reason, score: c.score, residualZ: c.residualZ, surfacedAt: at, dismissedAt: null });
      continue;
    }
    if (room <= 0) {
      overBudget++;
      continue;
    }
    room--;
    upserts.push({ id: triageId(q.day, c.coin), day: q.day, coin: c.coin, reason: c.reason, score: c.score, residualZ: c.residualZ, surfacedAt: at, dismissedAt: null, recordId: null });
  }
  return { upserts, overBudget, candidates };
}

/**
 * Coins the agent investigates on its own (plan §5 E): a surfaced, undismissed item without a record whose 24h
 * residual crossed |z| ≥ 2.5 with no news hour in the window, no record for the coin yet today, best score first,
 * at most `room` (what is left of the daily agent cap). "No news hour" needs a known news layer: with the news
 * unknown (no feed ingested) the item still surfaces, reading `news unknown`, but is investigated only on request.
 */
export function autoInvestigate(q: { items: TriageItem[]; candidates: TriageCandidate[]; recordsToday: Pick<AgentRecord, "coin">[]; room: number }): string[] {
  if (q.room <= 0) return [];
  const cand = new Map(q.candidates.map((c) => [c.coin, c]));
  const done = new Set(q.recordsToday.map((r) => r.coin));
  return q.items
    .filter((t) => t.recordId === null && t.dismissedAt === null && !done.has(t.coin) && cand.get(t.coin)?.byResidual && cand.get(t.coin)?.noNews)
    .sort((x, y) => y.score - x.score || cmp(x.coin, y.coin))
    .slice(0, q.room)
    .map((t) => t.coin);
}
