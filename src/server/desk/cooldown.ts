import { CooldownStateSchema, type ActiveLocks, type CooldownState, type StopOutRef } from "../../shared/deskPlan.js";

// Stop-out cooldowns, pure. A stop-out locks new entries on that coin for DESK_COOLDOWN_HOURS (default 4); the
// DESK_MAX_STOP_OUTS_PER_DAY-th stop-out (default 2) of one UTC day locks every new entry until the next 00:00 UTC,
// the same day boundary as the desk's day PnL and daily loss limit. The state lives in desk_state under COOLDOWN_KEY;
// the governor reads activeLocks() through GovernorContext.locks, so every entry path (plans, agent proposals, the
// copilot, platform approve, Telegram approve) is refused while a lock holds. There is no override.

export const COOLDOWN_KEY = "cooldown";
const HOUR = 3_600_000;

export interface CooldownConfig {
  cooldownHours: number;
  maxStopOutsPerDay: number;
}

export const NO_LOCKS: ActiveLocks = { coins: [], all: null, stopOutsToday: 0 };

const utcDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
/** 00:00 UTC after `d`. */
export function nextUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/** A stored value that does not parse (an older shape, a hand edit) reads as no stop-outs. */
export function parseCooldownState(v: unknown): CooldownState {
  const r = CooldownStateSchema.safeParse(v);
  return r.success ? r.data : { stopOuts: [] };
}

/**
 * Adds a stop-out. The same coin at the same instant is recorded once (a re-run tick). Entries that can no longer
 * lock anything (older than the cooldown and not from the stop-out's own UTC day) are dropped.
 */
export function recordStopOut(state: CooldownState, s: { coin: string; at: Date; ref: StopOutRef }, cfg: CooldownConfig): CooldownState {
  const at = s.at.toISOString();
  if (state.stopOuts.some((x) => x.coin === s.coin && x.at === at)) return state;
  const keepFrom = Math.min(s.at.getTime() - cfg.cooldownHours * HOUR, Date.parse(`${utcDay(s.at)}T00:00:00Z`));
  const kept = state.stopOuts.filter((x) => Date.parse(x.at) >= keepFrom);
  return { stopOuts: [...kept, { coin: s.coin, at, ref: s.ref }].sort((a, b) => a.at.localeCompare(b.at)) };
}

/** Locks in force at `now`: per coin (its latest stop-out within the cooldown) and all entries (too many stop-outs today). */
export function activeLocks(state: CooldownState, now: Date, cfg: CooldownConfig): ActiveLocks {
  const t = now.getTime();
  const latest = new Map<string, CooldownState["stopOuts"][number]>();
  for (const s of state.stopOuts) {
    if (Date.parse(s.at) > t) continue;
    const key = s.coin.toUpperCase();
    const cur = latest.get(key);
    if (!cur || s.at > cur.at) latest.set(key, s);
  }
  const coins = [...latest.values()]
    .map((s) => ({ coin: s.coin, until: new Date(Date.parse(s.at) + cfg.cooldownHours * HOUR).toISOString(), stopOutAt: s.at, ref: s.ref }))
    .filter((l) => Date.parse(l.until) > t)
    .sort((a, b) => a.until.localeCompare(b.until));
  const today = state.stopOuts.filter((s) => utcDay(s.at) === utcDay(now) && Date.parse(s.at) <= t);
  const all =
    today.length >= cfg.maxStopOutsPerDay
      ? { until: nextUtcMidnight(now).toISOString(), reason: `${today.length} stop-outs today (${today.map((s) => s.coin).join(", ")}): no new entries until 00:00 UTC` }
      : null;
  return { coins, all, stopOutsToday: today.length };
}

/** The governor's refusal lines for an entry on `coin` (empty when nothing locks it). */
export function lockReasons(locks: ActiveLocks, coin: string): string[] {
  const out: string[] = [];
  if (locks.all) out.push(`cooldown: ${locks.all.reason}`);
  const c = locks.coins.find((l) => l.coin.toUpperCase() === coin.toUpperCase());
  if (c) out.push(`cooldown: ${c.coin} stopped out at ${c.stopOutAt.slice(11, 16)} UTC; new ${c.coin} entries locked until ${c.until.slice(0, 16).replace("T", " ")} UTC`);
  return out;
}
