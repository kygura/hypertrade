import { z } from "zod";
import { AgentRecordSchema } from "./agentRecords.js";
import { AssetSchema } from "./intel.js";

// Queue contract (docs/SPEC.md § Queue): one short list of what deserves the trader's look, merged from the moves
// triage queue, ready platform opportunities and landed radar calls; one item per coin per UTC day, under one daily
// attention budget (MOVES_TRIAGE_DAILY) shared by every source. Facts only, never a verdict. Server
// (src/server/queue/merge.ts, src/server/routes/queue.ts) and UI (src/ui/lib/queue.ts) both import this file.

const Iso = z.string().datetime({ offset: true });
const Num = z.number().finite();
const Count = z.number().int().nonnegative();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid day");

export const QUEUE_SOURCES = ["moves", "opportunity", "radar"] as const;
export const QueueSourceSchema = z.enum(QUEUE_SOURCES);
export type QueueSource = z.infer<typeof QueueSourceSchema>;

/** `new`: not yet handled. `acted`: the operator decided a part today (an opportunity approved or rejected). `dismissed`: hidden for the day. */
export const QUEUE_STATES = ["new", "acted", "dismissed"] as const;
export const QueueStateSchema = z.enum(QUEUE_STATES);
export type QueueState = z.infer<typeof QueueStateSchema>;

/** `${day}:${coin}`: the shape of a triage item id, so a queue dismissal and the coin's triage item share a key. */
export const queueItemId = (day: string, coin: string) => `${day}:${coin}`;

/** The day and coin of a queue item id, or null. The coin may carry a dex prefix (`xyz:TSLA`). */
export function parseQueueItemId(id: string): { day: string; coin: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2}):(.+)$/.exec(id);
  if (!m) return null;
  const coin = AssetSchema.safeParse(m[2]);
  return coin.success ? { day: m[1]!, coin: coin.data } : null;
}

/** One source's reason for the coin to be in the queue. */
export const QueuePartSchema = z.object({
  source: QueueSourceSchema,
  /** The source object's own id: triage item id, opportunity uuid, radar call id. */
  ref: z.string().min(1),
  /** The source's own side; null for a moves triage item (its sign is in `reason`). */
  direction: z.enum(["long", "short"]).nullable(),
  /** Facts only, e.g. `residual +6.2% · z +3.1 · 24h · no news in window`, `crowded_short long · ready · net 42 bps`. */
  reason: z.string().min(1).max(200),
  /** 1 = crossed the source's own bar: the triage score (≥ 1 by construction); a ready opportunity or a landed radar call is 1. */
  score: Num.nonnegative(),
  /** When the source surfaced it (triage surfacedAt, opportunity createdAt, radar call at). */
  at: Iso,
  /** When the operator decided the source object today (opportunity approved or rejected); null otherwise. */
  actedAt: Iso.nullable(),
  /** The source's own drill-in (UI path), or null. */
  href: z.string().nullable(),
});
export type QueuePart = z.infer<typeof QueuePartSchema>;

export const QueueItemSchema = z.object({
  /** queueItemId(day, coin). */
  id: z.string().min(1),
  day: Day,
  coin: AssetSchema,
  /** The first part's reason (parts are ordered by score, then source order). */
  reason: z.string().min(1).max(200),
  /** Max of the parts' scores. */
  score: Num.nonnegative(),
  /** Earliest part `at`: the item's place in the day's budget (first come, first listed); the UI's age reads from it. */
  firstAt: Iso,
  /** Latest part `at`. */
  lastAt: Iso,
  state: QueueStateSchema,
  /** Latest of the queue dismissal and the coin's triage dismissal; null when neither. */
  dismissedAt: Iso.nullable(),
  /** At most one per source, highest score first. */
  parts: z.array(QueuePartSchema).min(1).max(QUEUE_SOURCES.length),
  /** The coin's agent record of the day (the triage item's, else the newest); null for a guest or when none. */
  record: AgentRecordSchema.nullable(),
  /** Where to decide: `/coin/:coin`. */
  href: z.string().min(1),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const QueueSourceStatusSchema = z.object({
  state: z.enum(["ok", "unavailable"]),
  reason: z.string().nullable(),
  /** Coins this source contributed before the cap. */
  count: Count,
});
export type QueueSourceStatus = z.infer<typeof QueueSourceStatusSchema>;

export const QueueResponseSchema = z.object({
  asOf: Iso,
  day: Day,
  /** MOVES_TRIAGE_DAILY: items listed per UTC day at most, across every source. */
  cap: Count,
  /** Items past the cap: counted, not listed. */
  overCap: Count,
  sources: z.object({ moves: QueueSourceStatusSchema, opportunity: QueueSourceStatusSchema, radar: QueueSourceStatusSchema }),
  /** Agent investigations run today, the daily cap (MOVES_AGENT_DAILY) and why one cannot run now (null when it can). */
  agentRuns: Count,
  agentCap: Count,
  agentBlockedReason: z.string().nullable(),
  /** Listed items in display order: new, acted, dismissed; then more sources, higher score, newer. */
  items: z.array(QueueItemSchema),
});
export type QueueResponse = z.infer<typeof QueueResponseSchema>;

export const QueueDismissResponseSchema = z.object({ id: z.string().min(1), dismissedAt: Iso });
export type QueueDismissResponse = z.infer<typeof QueueDismissResponseSchema>;
