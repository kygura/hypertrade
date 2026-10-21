import type { Candle } from "../../shared/types.js";
import { isOpenSetup as isOpen } from "../../shared/setups.js";
import type { Ledger, LedgerStats, Setup } from "./schema.js";

// Setup status is decided here, against prices, never by the model
// (docs/fallback-routine.md, pipeline step 4). Pure. A fill is assumed at the
// entry-zone midpoint, so every R in the ledger is measured from there.

export const CLOSED_RETENTION_MS = 90 * 86_400_000;

export const entryMid = (s: Pick<Setup, "entry">) => (s.entry.low + s.entry.high) / 2;

/** R multiple of exiting at `price`: profit over the risk to invalidation, both from the entry midpoint. */
export function rMultiple(s: Pick<Setup, "entry" | "invalidation" | "direction">, price: number): number {
  const mid = entryMid(s);
  const risk = Math.abs(mid - s.invalidation);
  if (!(risk > 0)) return 0;
  const gain = s.direction === "long" ? price - mid : mid - price;
  return Math.round((gain / risk) * 100) / 100;
}

/**
 * Walks one open setup through the candle path in time order. Only candles
 * that close after `updated_at` (the last time it was checked) and open
 * before `expires_at` count. Rules:
 *  - watching: a candle that reaches invalidation closes the setup. If that
 *    same candle also traded the entry zone from the right side (it opened
 *    beyond invalidation), it counts as filled and stopped (−1R); otherwise
 *    it never filled.
 *  - watching → triggered when a candle trades into the zone. Targets are
 *    not checked on the trigger candle: the order of its high and low is
 *    unknown.
 *  - triggered: invalidation beats target on the same candle (conservative).
 *  - past expires_at → expired; a triggered setup is marked to the last close.
 */
export function advanceSetup(s: Setup, candles: Candle[], now: Date): Setup {
  if (!isOpen(s)) return s;
  const nowIso = now.toISOString();
  let cur: Setup = s;
  const since = Date.parse(s.updated_at);
  const expires = Date.parse(s.expires_at);
  const long = s.direction === "long";
  const hitsInvalidation = (c: Candle) => (long ? c.l <= s.invalidation : c.h >= s.invalidation);
  const touchesZone = (c: Candle) => c.l <= s.entry.high && c.h >= s.entry.low;
  const hitsTarget = (c: Candle) => (long ? c.h >= s.targets[0]! : c.l <= s.targets[0]!);
  const openedBeyondInvalidation = (c: Candle) => (long ? c.o <= s.invalidation : c.o >= s.invalidation);
  const close = (status: Setup["status"], note: string, r: number | null, at: number): Setup => ({
    ...cur,
    status,
    status_note: note,
    r_result: r,
    updated_at: new Date(Math.min(at, now.getTime())).toISOString(),
  });

  let lastClose: number | null = null;
  for (const c of [...candles].sort((a, b) => a.t - b.t)) {
    if (c.T <= since || c.t >= expires) continue;
    lastClose = c.c;
    const day = new Date(c.t).toISOString().slice(0, 16).replace("T", " ");
    if (cur.status === "watching") {
      if (hitsInvalidation(c)) {
        if (touchesZone(c) && !openedBeyondInvalidation(c)) return { ...close("invalidated", `filled and stopped in the same candle (${day} UTC)`, -1, c.T), triggered_at: new Date(c.t).toISOString() };
        return close("invalidated", `never filled: invalidation ${s.invalidation} traded first (${day} UTC)`, null, c.T);
      }
      if (touchesZone(c)) cur = { ...cur, status: "triggered", status_note: `entry zone traded (${day} UTC)`, triggered_at: new Date(c.t).toISOString() };
      continue;
    }
    // triggered
    if (hitsInvalidation(c)) return close("invalidated", `stopped at ${s.invalidation} (${day} UTC)`, -1, c.T);
    if (hitsTarget(c)) return close("target_hit", `first target ${s.targets[0]} traded (${day} UTC)`, rMultiple(s, s.targets[0]!), c.T);
  }

  if (now.getTime() >= expires) {
    if (cur.status === "triggered") {
      const r = lastClose === null ? null : rMultiple(s, lastClose);
      return { ...cur, status: "expired", status_note: `expired after trigger${lastClose === null ? "" : `, marked at ${lastClose}`}`, r_result: r, updated_at: nowIso };
    }
    return { ...cur, status: "expired", status_note: "expired without a fill", r_result: null, updated_at: nowIso };
  }
  return { ...cur, updated_at: nowIso };
}

/** A human-or-model cancel: thesis broke before price did. A triggered setup is marked to `mark`. */
export function cancelSetup(s: Setup, reason: string, mark: number | null, now: Date): Setup {
  return {
    ...s,
    status: "cancelled",
    status_note: reason,
    r_result: s.status === "triggered" && mark !== null ? rMultiple(s, mark) : null,
    updated_at: now.toISOString(),
  };
}

/** triggered = the entry zone traded (even when no R could be marked); avg R over those with a realised R. */
export function ledgerStats(closed: Setup[]): LedgerStats {
  const triggered = closed.filter((s) => s.triggered_at !== null || s.r_result !== null);
  const hits = triggered.filter((s) => s.status === "target_hit").length;
  const withR = triggered.filter((s) => s.r_result !== null);
  return {
    closed_90d: closed.length,
    triggered_90d: triggered.length,
    hit_rate: triggered.length ? Math.round((hits / triggered.length) * 100) / 100 : null,
    avg_r: withR.length ? Math.round((withR.reduce((a, s) => a + s.r_result!, 0) / withR.length) * 100) / 100 : null,
  };
}

/** Moves closed setups out of `open`, drops closed ones older than 90 days, recomputes stats. */
export function settleLedger(open: Setup[], closed: Setup[], now: Date): Ledger {
  const cutoff = now.getTime() - CLOSED_RETENTION_MS;
  const stillOpen = open.filter(isOpen);
  const allClosed = [...open.filter((s) => !isOpen(s)), ...closed].filter((s) => Date.parse(s.updated_at) >= cutoff).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { updated_at: now.toISOString(), open: stillOpen, closed: allClosed, stats: ledgerStats(allClosed) };
}

export const emptyLedger = (now: Date): Ledger => ({ updated_at: now.toISOString(), open: [], closed: [], stats: { closed_90d: 0, triggered_90d: 0, hit_rate: null, avg_r: null } });
