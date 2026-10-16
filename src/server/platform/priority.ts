import type { AddressRow } from "../../shared/platform.js";

// Crawler priority (SPEC.md § Platform P0.6). Pure. Order of the result:
//   1. never polled (largest last-known notional first, then most recently seen)
//   2. overdue: holds positions and was last polled >= maxAgeMin ago; these outrank every
//      fresher account whatever its priority (the floor), ordered by priority among themselves
//   3. the rest of the active accounts by priority = notional x proximity x staleness
//   4. idle accounts (no positions, no trade since the last poll) once their idle interval has passed, stalest first
// Idle accounts not yet due are left out. An idle account that traded after its last poll counts as active.

export type Candidate = Pick<AddressRow, "address" | "lastSeenAt" | "polledAt" | "notionalUsd" | "positionCount" | "minLiqDistance">;

export const DEFAULT_IDLE_INTERVAL_MIN = 60;
/** proximity = 1 / clamp(minLiqDistance, MIN_DIST, 1): a 1% distance scores 100, a 30% one 3.3. No liquidation price scores 1. */
const MIN_DIST = 0.01;

const num = (n: number | null | undefined, fallback: number) => (n != null && Number.isFinite(n) ? n : fallback);

export function priority(c: Candidate, now: number): number {
  const age = c.polledAt ? Math.max(1, (now - Date.parse(c.polledAt)) / 1000) : 1;
  const dist = c.minLiqDistance == null || !Number.isFinite(c.minLiqDistance) ? 1 : Math.min(1, Math.max(MIN_DIST, c.minLiqDistance));
  return Math.max(0, num(c.notionalUsd, 0)) * (1 / dist) * age;
}

export function rankCandidates<T extends Candidate>(candidates: T[], now: number, o: { maxAgeMin: number; idleIntervalMin?: number }): T[] {
  const idleMs = (o.idleIntervalMin ?? DEFAULT_IDLE_INTERVAL_MIN) * 60_000;
  const maxMs = o.maxAgeMin * 60_000;
  const tier = (c: T): number | null => {
    if (!c.polledAt) return 0;
    const age = now - Date.parse(c.polledAt);
    const active = c.positionCount > 0 || Date.parse(c.lastSeenAt) > Date.parse(c.polledAt);
    if (!active) return age >= idleMs ? 3 : null;
    return age >= maxMs ? 1 : 2;
  };
  const keyed = candidates.flatMap((c) => {
    const t = tier(c);
    return t == null ? [] : [{ c, t, p: priority(c, now) }];
  });
  const seen = (c: T) => Date.parse(c.lastSeenAt) || 0;
  const age = (c: T) => now - (Date.parse(c.polledAt!) || 0);
  return keyed
    .sort((a, b) =>
      a.t - b.t ||
      (a.t === 0 ? num(b.c.notionalUsd, 0) - num(a.c.notionalUsd, 0) || seen(b.c) - seen(a.c) : a.t === 3 ? age(b.c) - age(a.c) : b.p - a.p) ||
      (a.c.address < b.c.address ? -1 : 1),
    )
    .map((k) => k.c);
}
