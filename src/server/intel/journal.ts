import { createHash } from "node:crypto";
import { z } from "zod";
import { ClaimSchema, type Claim } from "../../shared/claims.js";
import { hlInfo } from "../../shared/hl-client.js";
import type { JournalReport, ReportFinding, Session, SourceHealth, TagStats, Trade, TradeNote } from "../../shared/intel.js";
import type { ToolSpec } from "../llm/provider.js";
import type { DeskStore, PaperFill } from "../desk/store.js";
import { claimsJsonSchema, validateClaims } from "./claims.js";
import { completeStructured, type LlmDeps, type LlmTrace } from "./llm.js";
import type { IntelStore } from "./store.js";
import { message } from "./ingest/common.js";
import { meanOrNull, round } from "./util.js";

// Trade journal reviewer (SPEC.md § Intel I0.15). Code reconstructs round
// trips from fills (HL userFills of the watched address, Desk paper fills)
// and computes every number: session, hold, R, MAE/MFE, entry state, per-tag
// stats, the leaks and edges. The LLM only tags a trade's setup from a fixed
// vocabulary (cheap) and narrates findings code already picked (strong),
// citing only trade ids it was given.
//
// Conventions:
// - pnlUsd is realized PnL net of fees (closedPnl − fees); feesUsd is shown apart.
// - A trade's size is the total opened size; entryPx/exitPx are size-weighted.
// - Session = hour of the entry in INTEL_TZ (default UTC):
//   asia [00,08) · eu [08,13) · us [13,21) · off [21,24).
// - R = net pnl / (|entry − stop| × size), only on closed trades with a stop
//   on the losing side of the entry. Desk trades always have one (the
//   proposal's stop); HL trades only when stopFor finds a manual/snapshot stop.
// - MAE/MFE are magnitudes (≥ 0) of the worst/best move from entry over the
//   1h candles the trade spans, in R when a stop is known, else percent.

// ─── Fills ───

export type Venue = "hl" | "desk";

export interface Leg {
  venue: Venue;
  coin: string;
  /** ms epoch */
  time: number;
  /** Id of the fill this leg came from (a flip yields a close and an open leg from one fill). */
  tid: string;
  kind: "open" | "close";
  /** Side of the position being opened or closed. */
  side: "long" | "short";
  sz: number;
  px: number;
  fee: number;
  /** Realized PnL before fees (close legs). */
  pnl: number;
  /** Desk proposal behind the fill, when known. */
  ref: string | null;
}

const COIN = /^([A-Za-z0-9]+:)?[A-Za-z0-9]+$/;
const TID = /^[A-Za-z0-9_-]{1,60}$/;
const numLike = z.union([z.number(), z.string().trim().min(1)]).pipe(z.coerce.number().finite());

const HlFillSchema = z.object({
  coin: z.string().regex(COIN),
  px: numLike.refine((n) => n > 0),
  sz: numLike.refine((n) => n > 0),
  time: numLike,
  dir: z.string(),
  closedPnl: numLike.optional().default(0),
  fee: numLike.optional().default(0),
  startPosition: numLike.optional(),
  tid: z.union([z.number(), z.string()]).transform(String).pipe(z.string().regex(TID)),
});

/**
 * HL `userFills` → legs. Tolerant: rows that do not parse, spot fills ("Buy"/"Sell"),
 * and unknown dirs are skipped and counted.
 */
export function hlLegs(raw: unknown): { legs: Leg[]; skipped: number } {
  const rows = Array.isArray(raw) ? raw : [];
  const legs: Leg[] = [];
  let skipped = 0;
  for (const r of rows) {
    const p = HlFillSchema.safeParse(r);
    if (!p.success) {
      skipped++;
      continue;
    }
    const f = p.data;
    const base = { venue: "hl" as const, coin: f.coin, time: f.time, tid: f.tid, px: f.px, ref: null };
    const m = /^(Open|Close) (Long|Short)$/.exec(f.dir.trim());
    if (m) {
      const kind = m[1] === "Open" ? "open" : "close";
      legs.push({ ...base, kind, side: m[2] === "Long" ? "long" : "short", sz: f.sz, fee: f.fee, pnl: kind === "close" ? f.closedPnl : 0 });
      continue;
    }
    const flip = /^(Long|Short) > (Long|Short)$/.exec(f.dir.trim());
    if (flip && flip[1] !== flip[2]) {
      // startPosition is the position before the fill; the rest of the size opens the other way.
      const from = flip[1] === "Long" ? "long" : "short";
      const closeSz = Math.min(f.sz, Math.abs(f.startPosition ?? NaN));
      if (!Number.isFinite(closeSz)) {
        skipped++;
        continue;
      }
      const openSz = f.sz - closeSz;
      const share = (s: number) => (f.sz > 0 ? (f.fee * s) / f.sz : 0);
      if (closeSz > 0) legs.push({ ...base, kind: "close", side: from, sz: closeSz, fee: share(closeSz), pnl: f.closedPnl });
      if (openSz > 0) legs.push({ ...base, kind: "open", side: from === "long" ? "short" : "long", sz: openSz, fee: share(openSz), pnl: 0 });
      continue;
    }
    skipped++;
  }
  return { legs, skipped };
}

/** Desk paper fills → legs. An "entry" fill opens; any other reason closes (the paper book holds one position per coin). */
export function deskLegs(fills: PaperFill[]): Leg[] {
  return fills.flatMap((f) => {
    const time = Date.parse(f.ts);
    if (!COIN.test(f.coin) || !Number.isFinite(time) || !(f.size > 0) || !(f.px > 0)) return [];
    const opens = f.reason === "entry";
    return [
      {
        venue: "desk" as const,
        coin: f.coin,
        time,
        tid: f.id != null ? String(f.id) : String(time),
        kind: opens ? ("open" as const) : ("close" as const),
        // buy opens a long / closes a short.
        side: (f.side === "buy") === opens ? ("long" as const) : ("short" as const),
        sz: f.size,
        px: f.px,
        fee: Number.isFinite(f.fee) ? f.fee : 0,
        pnl: opens || !Number.isFinite(f.pnl) ? 0 : f.pnl,
        ref: f.proposalId,
      },
    ];
  });
}

// ─── Round trips (pure) ───

/** A reconstructed trade before enrichment. */
export interface RoundTrip {
  id: string;
  venue: Venue;
  asset: string;
  side: "long" | "short";
  openedAt: string;
  closedAt: string | null;
  size: number;
  entryPx: number;
  exitPx: number | null;
  pnlUsd: number;
  feesUsd: number;
  /** Desk proposal id of the opening fill. */
  ref: string | null;
}

interface Open {
  trip: RoundTrip;
  remaining: number;
  entryNotional: number;
  exitNotional: number;
  exitSz: number;
  grossPnl: number;
}

const EPS = 1e-9;
const byTid = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? a.length - b.length || (a < b ? -1 : a > b ? 1 : 0) : a.localeCompare(b));

/**
 * Legs → round trips, per venue and coin, in time order. Opens on the same side
 * scale in; closes reduce until flat (partial closes keep the trade open). A close
 * with nothing open (history starts mid-position) is skipped; an open against an
 * opposite open trade starts a new trade and leaves the old one open (data gap).
 */
export function roundTrips(legs: Leg[]): RoundTrip[] {
  const sorted = [...legs].sort((a, b) => a.time - b.time || byTid(a.tid, b.tid) || (a.kind === b.kind ? 0 : a.kind === "close" ? -1 : 1));
  const open = new Map<string, Open>();
  const out: RoundTrip[] = [];
  const finish = (o: Open) => {
    o.trip.entryPx = o.entryNotional / o.trip.size;
    o.trip.exitPx = o.exitSz > 0 ? o.exitNotional / o.exitSz : null;
    o.trip.pnlUsd = o.grossPnl - o.trip.feesUsd;
  };
  for (const l of sorted) {
    const key = `${l.venue}:${l.coin}`;
    const cur = open.get(key);
    if (l.kind === "open") {
      if (cur && cur.trip.side === l.side) {
        cur.trip.size += l.sz;
        cur.remaining += l.sz;
        cur.entryNotional += l.sz * l.px;
        cur.trip.feesUsd += l.fee;
        finish(cur);
        continue;
      }
      const trip: RoundTrip = {
        id: `${l.venue}:${l.coin}:${l.tid}`,
        venue: l.venue,
        asset: l.coin,
        side: l.side,
        openedAt: new Date(l.time).toISOString(),
        closedAt: null,
        size: l.sz,
        entryPx: l.px,
        exitPx: null,
        pnlUsd: -l.fee,
        feesUsd: l.fee,
        ref: l.ref,
      };
      out.push(trip);
      open.set(key, { trip, remaining: l.sz, entryNotional: l.sz * l.px, exitNotional: 0, exitSz: 0, grossPnl: 0 });
      continue;
    }
    if (!cur || cur.trip.side !== l.side) continue;
    const sz = Math.min(l.sz, cur.remaining);
    cur.remaining -= sz;
    cur.exitNotional += sz * l.px;
    cur.exitSz += sz;
    cur.grossPnl += l.pnl;
    cur.trip.feesUsd += l.fee;
    finish(cur);
    if (cur.remaining <= cur.trip.size * EPS) {
      cur.trip.closedAt = new Date(l.time).toISOString();
      open.delete(key);
    }
  }
  return out;
}

// ─── Per-trade computations (pure) ───

export const SESSION_HOURS = { asia: [0, 8], eu: [8, 13], us: [13, 21] } as const;

/** A valid IANA zone, else UTC. */
export function resolveTz(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function sessionFor(at: Date, tz = "UTC"): Session {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: resolveTz(tz), hour: "numeric", hourCycle: "h23" }).format(at)) % 24;
  for (const [s, [lo, hi]] of Object.entries(SESSION_HOURS)) if (hour >= lo && hour < hi) return s as Session;
  return "off";
}

/** Price distance to the stop per unit, when the stop is on the losing side of the entry. */
function riskPerUnit(side: "long" | "short", entryPx: number, stopPx: number | null): number | null {
  if (stopPx == null || !Number.isFinite(stopPx) || stopPx <= 0) return null;
  const d = side === "long" ? entryPx - stopPx : stopPx - entryPx;
  return d > 0 ? d : null;
}

export function rMultiple(t: Pick<RoundTrip, "side" | "entryPx" | "size" | "pnlUsd" | "closedAt">, stopPx: number | null): number | null {
  const risk = riskPerUnit(t.side, t.entryPx, stopPx);
  if (risk == null || t.closedAt == null || !(t.size > 0)) return null;
  return t.pnlUsd / (risk * t.size);
}

export interface CandleLike {
  ts: Date | string;
  h: number;
  l: number;
}

/** MAE/MFE in percent of entry (≥ 0) over candles touching [openedAt, closedAt|now]; null without candles. */
export function excursions(t: Pick<RoundTrip, "side" | "entryPx" | "openedAt" | "closedAt">, candles: CandleLike[], now: Date): { maePct: number; mfePct: number } | null {
  const from = Math.floor(Date.parse(t.openedAt) / 3_600_000) * 3_600_000;
  const to = t.closedAt ? Date.parse(t.closedAt) : now.getTime();
  const inside = candles.filter((c) => {
    const ts = new Date(c.ts).getTime();
    return ts >= from && ts <= to && Number.isFinite(c.h) && Number.isFinite(c.l);
  });
  if (!inside.length || !(t.entryPx > 0)) return null;
  const hi = Math.max(...inside.map((c) => c.h));
  const lo = Math.min(...inside.map((c) => c.l));
  const up = ((hi - t.entryPx) / t.entryPx) * 100;
  const down = ((t.entryPx - lo) / t.entryPx) * 100;
  const [adverse, favourable] = t.side === "long" ? [down, up] : [up, down];
  return { maePct: Math.max(0, adverse), mfePct: Math.max(0, favourable) };
}

/** Back to percent for a trade whose excursions are stored in R. */
export function excursionPct(t: Pick<Trade, "side" | "entryPx" | "stopPx" | "maeUnit">, v: number | null): number | null {
  if (v == null) return null;
  if (t.maeUnit === "pct") return v;
  const risk = riskPerUnit(t.side, t.entryPx, t.stopPx);
  return risk == null ? null : (v * risk * 100) / t.entryPx;
}

export interface EntryState {
  fundingZ: number | null;
  oiZ: number | null;
  change24hPct: number | null;
}

export interface EnrichInput {
  stopPx: number | null;
  candles: CandleLike[];
  entryState: EntryState;
  note: TradeNote | null;
}

export function enrich(t: RoundTrip, x: EnrichInput, now: Date, tz = "UTC"): Trade {
  const risk = riskPerUnit(t.side, t.entryPx, x.stopPx);
  const ex = excursions(t, x.candles, now);
  const inR = (pct: number) => (risk == null ? pct : (pct * t.entryPx) / 100 / risk);
  return {
    id: t.id,
    venue: t.venue,
    asset: t.asset,
    side: t.side,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    size: t.size,
    entryPx: t.entryPx,
    exitPx: t.exitPx,
    pnlUsd: t.pnlUsd,
    feesUsd: t.feesUsd,
    holdMs: t.closedAt ? Date.parse(t.closedAt) - Date.parse(t.openedAt) : null,
    session: sessionFor(new Date(t.openedAt), tz),
    stopPx: x.stopPx != null && Number.isFinite(x.stopPx) && x.stopPx > 0 ? x.stopPx : null,
    r: rMultiple(t, x.stopPx),
    mae: ex ? inR(ex.maePct) : null,
    mfe: ex ? inR(ex.mfePct) : null,
    maeUnit: risk == null ? "pct" : "r",
    entryState: x.entryState,
    tag: x.note?.tag ?? null,
    note: x.note?.note ?? null,
    noteSummary: x.note?.summary ?? null,
  };
}

// ─── Stats (pure) ───

export const UNTAGGED = "untagged";
const known = <T>(xs: Array<T | null>): T[] => xs.filter((x): x is T => x != null);

/**
 * Per-tag stats over closed trades, ranked by expectancy (mean net USD per trade),
 * best first. avgR and expectancyR are the mean R of the trades with a known stop.
 */
export function tagStats(trades: Trade[]): TagStats[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    if (t.closedAt == null) continue;
    const k = t.tag ?? UNTAGGED;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const stats = [...groups].map(([tag, ts]): TagStats => {
    const avgR = meanOrNull(known(ts.map((t) => t.r)));
    return {
      tag,
      trades: ts.length,
      winRate: ts.filter((t) => t.pnlUsd > 0).length / ts.length,
      avgR,
      avgHoldMs: meanOrNull(known(ts.map((t) => t.holdMs))),
      avgMaePct: meanOrNull(known(ts.map((t) => excursionPct(t, t.mae)))),
      avgMfePct: meanOrNull(known(ts.map((t) => excursionPct(t, t.mfe)))),
      expectancyUsd: meanOrNull(ts.map((t) => t.pnlUsd)) ?? 0,
      expectancyR: avgR,
    };
  });
  return stats.sort((a, b) => b.expectancyUsd - a.expectancyUsd || b.trades - a.trades || a.tag.localeCompare(b.tag));
}

// ─── Loading ───

export interface JournalDeps {
  /** Raw HL `userFills` for the watched address; undefined → hl reported as not configured. */
  hlFills?: () => Promise<unknown>;
  /** Desk paper fills (any order); undefined → desk reported as not configured. */
  deskFills?: () => Promise<PaperFill[]>;
  /** Known stop for a trade (desk: the proposal's stop; hl: a manual or snapshot stop), else null. */
  stopFor?: (t: RoundTrip) => Promise<number | null>;
  /** 1h candles with from <= ts < to. */
  candles?: (asset: string, from: Date, to: Date) => Promise<CandleLike[]>;
  entryState?: (asset: string, at: Date) => Promise<EntryState>;
  store: Pick<IntelStore, "tradeNotes" | "putTradeNote" | "insertReport" | "latestReport">;
  llm: LlmDeps;
  now(): Date;
  /** INTEL_TZ */
  tz?: string;
}

export interface JournalLoad {
  trades: Trade[];
  sources: SourceHealth[];
}

const NO_STATE: EntryState = { fundingZ: null, oiZ: null, change24hPct: null };

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Trades open at any point in the last `days` days, newest first. A failing source is reported, never fatal. */
export async function loadJournal(deps: JournalDeps, days: number): Promise<JournalLoad> {
  const now = deps.now();
  const sources: SourceHealth[] = [];
  const legs: Leg[] = [];
  if (!deps.hlFills) sources.push({ source: "hl", ok: false, error: "DESK_WATCH_ADDRESS not configured" });
  else {
    try {
      const { legs: l, skipped } = hlLegs(await deps.hlFills());
      legs.push(...l);
      sources.push(skipped ? { source: "hl", ok: true, error: `${skipped} fills skipped (spot or unparsed)` } : { source: "hl", ok: true });
    } catch (e) {
      sources.push({ source: "hl", ok: false, error: message(e) });
    }
  }
  if (!deps.deskFills) sources.push({ source: "desk", ok: false, error: "desk not configured" });
  else {
    try {
      legs.push(...deskLegs(await deps.deskFills()));
      sources.push({ source: "desk", ok: true });
    } catch (e) {
      sources.push({ source: "desk", ok: false, error: message(e) });
    }
  }

  const since = now.getTime() - days * 86_400_000;
  const trips = roundTrips(legs).filter((t) => t.closedAt == null || Date.parse(t.closedAt) >= since);

  let notes: TradeNote[] = [];
  try {
    notes = trips.length ? await deps.store.tradeNotes(trips.map((t) => t.id)) : [];
  } catch (e) {
    sources.push({ source: "notes", ok: false, error: message(e) });
  }
  const noteById = new Map(notes.map((n) => [n.tradeId, n]));

  // Enrichment failures null the field and are reported once per kind.
  const failed = new Map<string, string>();
  const attempt = async <R>(kind: string, fallback: R, fn: (() => Promise<R>) | undefined): Promise<R> => {
    if (!fn) return fallback;
    try {
      return await fn();
    } catch (e) {
      if (!failed.has(kind)) failed.set(kind, message(e));
      return fallback;
    }
  };
  const trades = await mapLimit(trips, 4, async (t) => {
    const opened = new Date(t.openedAt);
    const end = t.closedAt ? new Date(t.closedAt) : now;
    const [stopPx, candles, entryState] = await Promise.all([
      attempt("stops", null, deps.stopFor && (() => deps.stopFor!(t))),
      attempt<CandleLike[]>("candles", [], deps.candles && (() => deps.candles!(t.asset, new Date(Math.floor(opened.getTime() / 3_600_000) * 3_600_000), new Date(end.getTime() + 1)))),
      attempt("entryState", NO_STATE, deps.entryState && (() => deps.entryState!(t.asset, opened))),
    ]);
    return enrich(t, { stopPx, candles, entryState, note: noteById.get(t.id) ?? null }, now, deps.tz);
  });
  for (const [source, error] of failed) sources.push({ source, ok: false, error });
  trades.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  return { trades, sources };
}

// ─── Notes and tagging ───

/** Writes the operator's note. The tag stays; the summary is cleared (stale) so the next tag pass redoes it. */
export async function putNote(store: JournalDeps["store"], tradeId: string, note: string): Promise<TradeNote> {
  const [cur] = await store.tradeNotes([tradeId]);
  return store.putTradeNote({ tradeId, note: note.trim() ? note.trim() : null, tag: cur?.tag ?? null, summary: null });
}

export const SETUP_TAGS = ["breakout", "breakdown", "pullback", "trend_follow", "mean_reversion", "range", "news", "funding_fade", "squeeze", "scalp", "other"] as const;
export const TAG_PROMPT_VERSION = "journal-tag-v1";
export const REPORT_PROMPT_VERSION = "journal-report-v1";
export const TAG_BATCH_MAX = 25;

const TagOutputSchema = z.object({ setup: z.enum(SETUP_TAGS), noteSummary: z.unknown().nullable().optional() });
const tagJsonSchema: ToolSpec["input_schema"] = {
  type: "object",
  properties: {
    setup: { type: "string", enum: [...SETUP_TAGS] },
    noteSummary: { anyOf: [claimsJsonSchema.items, { type: "null" }] },
  },
  required: ["setup", "noteSummary"],
  additionalProperties: false,
};

const TAG_SYSTEM = `You label one closed or open trade from a trading journal with a setup type.
Pick "setup" from the allowed list only; use "other" when nothing fits. Base it on the trade facts and the operator's note.
If there is a note, "noteSummary" is one short line summarizing it: {"tag":"hypothesis","text":...} for the operator's reasoning,
or {"tag":"observed","text":...,"source":{"label":"trade note"},"ts":<the note's updatedAt>} for a fact the note states. Without a note, noteSummary is null.
Never predict price direction or give advice.`;

const needsTag = (t: Trade) => t.tag == null || (t.note != null && t.noteSummary == null);
const noteHash = (note: string | null) => (note ? createHash("sha256").update(note).digest("hex").slice(0, 12) : "none");

/** Tags untagged trades (and re-summarizes changed notes), at most TAG_BATCH_MAX per call. Never throws for one trade. */
export async function tagTrades(deps: Pick<JournalDeps, "store" | "llm">, trades: Trade[], signal?: AbortSignal): Promise<{ tagged: number; failed: number; error?: string }> {
  const todo = trades.filter(needsTag).slice(0, TAG_BATCH_MAX);
  let tagged = 0;
  let failed = 0;
  let error: string | undefined;
  const notes = new Map((await deps.store.tradeNotes(todo.map((t) => t.id))).map((n) => [n.tradeId, n]));
  await mapLimit(todo, 4, async (t) => {
    const note = notes.get(t.id) ?? null;
    const facts = {
      id: t.id,
      venue: t.venue,
      asset: t.asset,
      side: t.side,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      holdMs: t.holdMs,
      session: t.session,
      pnlUsd: round(t.pnlUsd),
      r: t.r == null ? null : round(t.r),
      mae: t.mae == null ? null : round(t.mae),
      mfe: t.mfe == null ? null : round(t.mfe),
      maeUnit: t.maeUnit,
      entryState: t.entryState,
      note: note?.note ?? null,
      noteUpdatedAt: note?.updatedAt ?? null,
    };
    const res = await completeStructured({
      tier: "cheap",
      system: TAG_SYSTEM,
      user: `Allowed setups: ${SETUP_TAGS.join(", ")}\n\nTrade:\n${JSON.stringify(facts)}`,
      schema: TagOutputSchema,
      jsonSchema: tagJsonSchema,
      promptVersion: TAG_PROMPT_VERSION,
      cacheKey: `journal:tag:${t.id}:${noteHash(note?.note ?? null)}`,
      signal,
      deps: deps.llm,
    });
    if (!res.ok) {
      failed++;
      error ??= res.error;
      return;
    }
    const summary = note?.note ? (validateClaims([res.value.noteSummary]).claims[0] ?? null) : null;
    try {
      await deps.store.putTradeNote({ tradeId: t.id, note: note?.note ?? null, tag: res.value.setup, summary });
      tagged++;
    } catch (e) {
      failed++;
      error ??= message(e);
    }
  });
  return error ? { tagged, failed, error } : { tagged, failed };
}

// ─── Weekly report ───

export const FINDING_MIN_TRADES = 3;

/** Code picks the findings: top-3 leaks (worst negative expectancy) and top-2 edges (best positive), each with n ≥ 3. */
export function pickFindings(trades: Trade[]): { leaks: ReportFinding[]; edges: ReportFinding[] } {
  const closed = trades.filter((t) => t.closedAt != null);
  const finding = (s: TagStats): ReportFinding => ({
    tag: s.tag,
    tradeIds: closed.filter((t) => (t.tag ?? UNTAGGED) === s.tag).map((t) => t.id),
    trades: s.trades,
    expectancyUsd: s.expectancyUsd,
    expectancyR: s.expectancyR,
    line: null,
  });
  const eligible = tagStats(closed).filter((s) => s.trades >= FINDING_MIN_TRADES);
  const leaks = eligible
    .filter((s) => s.expectancyUsd < 0)
    .sort((a, b) => a.expectancyUsd - b.expectancyUsd)
    .slice(0, 3)
    .map(finding);
  const edges = eligible
    .filter((s) => s.expectancyUsd > 0)
    .slice(0, 2)
    .map(finding);
  return { leaks, edges };
}

const NarrationSchema = z.object({
  lines: z.array(z.object({ tag: z.string(), tradeIds: z.array(z.string()).max(50), claim: z.unknown() })).max(10),
});
const narrationJsonSchema: ToolSpec["input_schema"] = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          tag: { type: "string", description: "The finding's tag" },
          tradeIds: { type: "array", items: { type: "string" }, description: "Trade ids this line cites; only ids given for that finding" },
          claim: claimsJsonSchema.items,
        },
        required: ["tag", "tradeIds", "claim"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

const REPORT_SYSTEM = `You narrate a weekly trading-journal review. Code already computed every number and picked the leaks (worst setups) and edges (best setups).
Write one line per finding, at most 5 lines in all. Each line names its finding's tag and cites trade ids from that finding only, copied exactly.
Restating a given number is {"tag":"observed","text":...,"source":{"label":"journal","url":"/journal"},"ts":<asOf>}. Any explanation of why is {"tag":"hypothesis","text":...}.
Do not invent numbers or trade ids. Do not predict price direction or give trade advice.`;

const TRADE_ID_IN_TEXT = /\b(?:hl|desk):(?:[A-Za-z0-9]+:)?[A-Za-z0-9]+:[A-Za-z0-9_-]+/g;

/**
 * Keeps narration lines whose tag is a finding, whose cited ids are a non-empty
 * subset of that finding's ids, whose text mentions no other trade id, and whose
 * claim passes the validator. Returns the kept claims per tag and the drop count.
 */
export function validateNarration(raw: z.infer<typeof NarrationSchema>["lines"], findings: ReportFinding[]): { byTag: Map<string, Claim[]>; lines: Claim[]; dropped: number } {
  const ids = new Map(findings.map((f) => [f.tag, new Set(f.tradeIds)]));
  const byTag = new Map<string, Claim[]>();
  const lines: Claim[] = [];
  for (const l of raw) {
    const allowed = ids.get(l.tag);
    if (!allowed || !l.tradeIds.length || !l.tradeIds.every((id) => allowed.has(id))) continue;
    const claim = ClaimSchema.safeParse(l.claim);
    if (!claim.success) continue;
    if ((claim.data.text.match(TRADE_ID_IN_TEXT) ?? []).some((id) => !allowed.has(id))) continue;
    lines.push(claim.data);
    byTag.set(l.tag, [...(byTag.get(l.tag) ?? []), claim.data]);
  }
  return { byTag, lines, dropped: raw.length - lines.length };
}

/** Builds, narrates and stores the journal_weekly report. Narration failing leaves the code findings with no lines (trace records why). */
export async function weeklyReport(deps: JournalDeps, periodDays = 7, signal?: AbortSignal): Promise<JournalReport> {
  const now = deps.now();
  const since = now.getTime() - periodDays * 86_400_000;
  const { trades } = await loadJournal(deps, periodDays);
  const closed = trades.filter((t) => t.closedAt != null && Date.parse(t.closedAt) >= since);
  const { leaks, edges } = pickFindings(closed);
  const findings = [...leaks, ...edges];
  let lines: Claim[] = [];
  let trace: (LlmTrace & { error?: string }) | undefined;

  if (findings.length) {
    const asOf = now.toISOString();
    const input = {
      asOf,
      periodDays,
      leaks: leaks.map((f) => ({ ...f, expectancyUsd: round(f.expectancyUsd, 2), expectancyR: f.expectancyR == null ? null : round(f.expectancyR, 2), line: undefined })),
      edges: edges.map((f) => ({ ...f, expectancyUsd: round(f.expectancyUsd, 2), expectancyR: f.expectancyR == null ? null : round(f.expectancyR, 2), line: undefined })),
    };
    const res = await completeStructured({
      tier: "strong",
      system: REPORT_SYSTEM,
      user: JSON.stringify(input),
      schema: NarrationSchema,
      jsonSchema: narrationJsonSchema,
      promptVersion: REPORT_PROMPT_VERSION,
      cacheKey: `journal:report:${createHash("sha256").update(JSON.stringify({ ...input, asOf: asOf.slice(0, 13) })).digest("hex").slice(0, 24)}`,
      signal,
      deps: deps.llm,
    });
    if (res.ok) {
      const v = validateNarration(res.value.lines, findings);
      lines = v.lines;
      for (const f of findings) f.line = v.byTag.get(f.tag)?.[0] ?? null;
      trace = { ...res.trace, dropped: v.dropped };
    } else {
      trace = { ...res.trace, error: res.error };
    }
  }

  const report = await deps.store.insertReport({ kind: "journal_weekly", periodDays, leaks, edges, lines, ...(trace ? { trace } : {}) });
  return report as JournalReport;
}

// ─── Live sources (wiring helpers) ───

/** HL `userFills` for an address (latest 2000 fills). */
export const hlFillLoader = (address: string, info: typeof hlInfo = hlInfo) => () => info<unknown>({ type: "userFills", user: address });

/** Desk paper fills, oldest first. */
export const deskFillLoader = (store: Pick<DeskStore, "listFills">, limit = 2000) => async () => (await store.listFills(limit)).reverse();

/** Desk trades' stop from the proposal that opened them; HL trades fall through to `hl` (manual/snapshot stop), else null. */
export function journalStopFor(desk: Pick<DeskStore, "getProposal"> | null, hl?: (t: RoundTrip) => Promise<number | null>) {
  return async (t: RoundTrip): Promise<number | null> => {
    if (t.venue === "desk") {
      if (!desk || !t.ref) return null;
      const p = await desk.getProposal(t.ref);
      const stop = p?.kind === "open" ? (p.proposal as { stop?: unknown }).stop : undefined;
      return typeof stop === "number" && Number.isFinite(stop) ? stop : null;
    }
    return hl ? hl(t) : null;
  };
}

/**
 * Entry state from intel snapshots: funding and OI level z vs the 7 days before
 * entry (null under 24 samples), 24 h price change from the snapshots nearest to
 * entry and entry − 24 h (each within 2 h), else from 1h candles.
 */
export function snapshotEntryState(store: Pick<IntelStore, "snapshotRange">, candles?: (asset: string, from: Date, to: Date) => Promise<Array<CandleLike & { c: number }>>) {
  return async (asset: string, at: Date): Promise<EntryState> => {
    const t = at.getTime();
    const rows = await store.snapshotRange(asset, new Date(t - 7 * 86_400_000), at);
    const z = (xs: number[]) => {
      if (xs.length < 24) return null;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
      return sd > 0 ? (xs[xs.length - 1]! - m) / sd : null;
    };
    const near = (target: number) => {
      let best: { price: number; d: number } | null = null;
      for (const r of rows) {
        const d = Math.abs(Date.parse(r.ts) - target);
        if (d <= 7_200_000 && (!best || d < best.d)) best = { price: r.price, d };
      }
      return best?.price ?? null;
    };
    let now = near(t);
    let then = near(t - 86_400_000);
    if ((now == null || then == null) && candles) {
      const cs = await candles(asset, new Date(t - 26 * 3_600_000), at);
      // A 1h candle's close is the price at ts + 1h.
      const priceAt = (target: number) => cs.filter((c) => new Date(c.ts).getTime() + 3_600_000 <= target).at(-1)?.c ?? null;
      now ??= priceAt(t);
      then ??= priceAt(t - 86_400_000);
    }
    return {
      fundingZ: z(known(rows.map((r) => r.funding))),
      oiZ: z(known(rows.map((r) => r.oiUsd))),
      change24hPct: now != null && then != null && then > 0 ? ((now - then) / then) * 100 : null,
    };
  };
}
