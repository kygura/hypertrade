import type { Candle } from "../../shared/types.js";
import { excursions, hlLegs, roundTrips, type RoundTrip } from "../intel/journal.js";
import { entryMid } from "./ledger.js";
import type { Setup } from "./schema.js";

// Facts for the daily post-mortems and the Sunday journal (ROUTINE.md §2c, §4).
// Pure: scripts/review.ts does the I/O. Code measures; the session writes the
// post-mortem and journal text from these numbers.

export interface PostmortemFacts {
  id: string;
  setup_id: string | null;
  asset: string;
  direction: Setup["direction"];
  status: Setup["status"];
  conviction: Setup["conviction"];
  r: number | null;
  /** Worst and best excursion while triggered, in R from the entry midpoint; null when it never triggered or no candles. */
  maeR: number | null;
  mfeR: number | null;
  note: string | null;
}

/** Closed setups whose id appears nowhere in the post-mortems written so far. */
export function unreviewed(closed: Setup[], reviewed: string): Setup[] {
  return closed.filter((s) => !reviewed.includes(s.id));
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function postmortemFacts(s: Setup, candles: Pick<Candle, "t" | "h" | "l">[], now: Date): PostmortemFacts {
  const mid = entryMid(s);
  const riskPct = (Math.abs(mid - s.invalidation) / mid) * 100;
  const x =
    s.triggered_at && riskPct > 0
      ? excursions({ side: s.direction, entryPx: mid, openedAt: s.triggered_at, closedAt: s.updated_at }, candles.map((c) => ({ ts: new Date(c.t), h: c.h, l: c.l })), now)
      : null;
  return {
    id: s.id,
    setup_id: s.setup_id,
    asset: s.asset,
    direction: s.direction,
    status: s.status,
    conviction: s.conviction,
    r: s.r_result,
    maeR: x ? r2(x.maePct / riskPct) : null,
    mfeR: x ? r2(x.mfePct / riskPct) : null,
    note: s.status_note,
  };
}

/** HL fills → round trips; `recent` are the trips closed in the last `days`. */
export function journalTrips(rawFills: unknown, now: Date, days = 7): { skipped: number; trips: RoundTrip[]; recent: RoundTrip[] } {
  const { legs, skipped } = hlLegs(rawFills);
  const trips = roundTrips(legs);
  const since = now.getTime() - days * 86_400_000;
  return { skipped, trips, recent: trips.filter((t) => t.closedAt !== null && Date.parse(t.closedAt) >= since) };
}
