import { fmtPx } from "../../shared/format.js";
import type { LlmCaps } from "../intel/llm.js";
import { deskLlmRefusal, runDesk, type ProviderFactory } from "./agents.js";
import { HOUR, evaluateTriggers, type Trigger } from "./triggers.js";
import type { UpkeepNote } from "./paper.js";
import type { DeskService } from "./service.js";

// The watch tick: cheap, deterministic, and frequent (every 15 minutes from
// the collect workflow, or every minute from scripts/desk-worker.ts).
//
//   1. expire stale approvals
//   2. settle paper stops/targets against the bars since the last tick
//   3. check the day-loss limit
//   4. evaluate triggers (fast moves, funding extremes, OI surges, positions
//      near their stop, breadth shocks); each fires an alert, with a per-key
//      cooldown so a condition that persists does not spam
//   5. wake the agent team (a "cycle") when a trigger fired or a scheduled
//      review is due, within the daily cycle cap, the cooldown and the daily
//      LLM cap
//
// The LLM only runs in step 5; everything before it is arithmetic.
//
// Several schedulers call this (pg_cron and collect.yml through POST
// /desk/tick, the always-on loop, scripts/desk-worker.ts), so steps 1-4 run
// under a store lease: a tick that finds it held does nothing. Each alert's
// cooldown or flag is stored before the alert is sent (claim, then send), so a
// throw later in the tick cannot make it repeat on the next one. The cycle
// runs after the lease is released; lastCycleAt, stored under it, keeps a
// second tick from starting another.

const MIN = 60_000;
export const WATCH_KEY = "watch";
const COOLDOWN_KEY = "trigger_cooldowns";
const TRIGGER_COOLDOWN_MS = 3 * HOUR;
const MARK_HISTORY_MS = 26 * HOUR;
const TICK_LEASE = "tick";
/** Steps 1-4 take seconds; a holder that died frees the lease after this. */
const TICK_LEASE_MS = 3 * MIN;

export interface WatchState {
  lastTick?: string;
  lastCycleAt?: string;
  /** Recent marks per coin, [epoch ms, price], oldest first. */
  marks?: Record<string, Array<[number, number]>>;
  dayLossAlerted?: string;
  /** Venue upkeep conditions already alerted: key → when (epoch ms). A key gone from a tick is dropped, so it alerts again if it returns. */
  upkeep?: Record<string, number>;
}

/** A critical upkeep condition (an unprotected position) repeats this often while it lasts; others alert once. */
const UPKEEP_REPEAT_MS = HOUR;

export interface TickResult {
  at: string;
  expired: number;
  settled: Array<{ coin: string; kind: string; pnl: number }>;
  triggers: Trigger[];
  suppressed: string[];
  cycle: { runId: string; stop: string; reason: string } | { skipped: string } | null;
  /** Set when this tick did nothing: another tick holds the lease. */
  skipped?: string;
}

export interface TickOptions {
  /** Run an agent cycle when warranted (false: alerts only). */
  runCycle?: boolean;
  cycleTimeoutMs?: number;
  makeProvider?: ProviderFactory;
  /** Force a review cycle regardless of triggers and schedule (still capped per day). */
  forceReview?: boolean;
  /** Daily LLM caps for the cycle. Default: the service's. */
  llm?: LlmCaps;
}

export async function tick(service: DeskService, opts: TickOptions = {}): Promise<TickResult> {
  const holder = crypto.randomUUID();
  if (!(await service.store.acquireLease(TICK_LEASE, holder, TICK_LEASE_MS))) {
    return { at: service.now().toISOString(), expired: 0, settled: [], triggers: [], suppressed: [], cycle: null, skipped: "another tick is running" };
  }
  let watched: Awaited<ReturnType<typeof watch>>;
  try {
    watched = await watch(service, opts);
  } finally {
    await service.store.releaseLease(TICK_LEASE, holder).catch((err) => console.error("[desk] tick lease release:", err));
  }
  const { result, reason } = watched;
  if (reason == null) return result;
  try {
    const r = await runDesk(
      { service, kind: "cycle", input: reason, act: true, makeProvider: opts.makeProvider, timeoutMs: opts.cycleTimeoutMs, llm: opts.llm, trigger: { triggers: result.triggers } },
      () => {},
    );
    result.cycle = { runId: r.runId, stop: r.stop, reason };
  } catch (err) {
    result.cycle = { skipped: err instanceof Error ? err.message : String(err) };
  }
  return result;
}

/** Steps 1-4 and the decision of step 5, under the tick lease. `reason` is set when a cycle was claimed (lastCycleAt stored) and is to run. */
async function watch(service: DeskService, opts: TickOptions): Promise<{ result: TickResult; reason: string | null }> {
  const now = service.now();
  const t = now.getTime();
  const state = (await service.store.getState<WatchState>(WATCH_KEY)) ?? {};
  const result: TickResult = { at: now.toISOString(), expired: 0, settled: [], triggers: [], suppressed: [], cycle: null };

  result.expired = await service.expirePending();

  const { ctxs, marks } = await service.marks();

  // Paper stops/targets against each held coin's 5m range since the last tick.
  // Live venues hold stops on the exchange; only the paper book settles here.
  const held = service.broker.settle ? await service.store.paperPositions() : [];
  if (held.length && service.broker.settle) {
    const since = Math.max(state.lastTick ? new Date(state.lastTick).getTime() : t - 15 * MIN, t - 24 * HOUR) - 5 * MIN;
    const ranges = new Map<string, { low: number; high: number }>();
    await Promise.all(
      held.map(async (p) => {
        const bars = await service.data.candles(p.coin, "5m", since, t).catch(() => []);
        const mark = marks.get(p.coin);
        const lows = [...bars.map((b) => b.l), ...(mark ? [mark] : [])];
        const highs = [...bars.map((b) => b.h), ...(mark ? [mark] : [])];
        if (lows.length) ranges.set(p.coin, { low: Math.min(...lows), high: Math.max(...highs) });
      }),
    );
    for (const s of await service.broker.settle(ranges, now)) {
      const fill = s.result.fills[0];
      result.settled.push({ coin: s.coin, kind: s.kind, pnl: fill?.pnl ?? 0 });
      await service.alert(s.kind === "stop" ? "warn" : "info", `${s.coin} ${s.kind === "stop" ? "stopped out" : "hit target"}`, `${fill?.size} @ ${fmtPx(fill?.px ?? 0)} · PnL $${(fill?.pnl ?? 0).toFixed(2)}`);
    }
  }

  // Venue upkeep (Propr: stale or finished ladder rungs are cancelled, every unfilled entry rung while the kill switch
  // is on, unprotected positions flagged). Never fatal to
  // the tick. Each condition alerts once (a critical one again every hour while it lasts), not every minute.
  if (service.broker.housekeep) {
    const kill = await service.killSwitch();
    const notes = await service.broker.housekeep(now, { killSwitch: kill.on }).catch((err): UpkeepNote[] => [{ level: "warn", key: "upkeep-failed", text: `housekeeping failed: ${err instanceof Error ? err.message : String(err)}` }]);
    const seen = state.upkeep ?? {};
    const next: Record<string, number> = {};
    const due: UpkeepNote[] = [];
    for (const n of notes) {
      const last = seen[n.key];
      if (last == null || (n.level === "critical" && t - last >= UPKEEP_REPEAT_MS)) {
        due.push(n);
        next[n.key] = t;
      } else next[n.key] = last;
    }
    state.upkeep = next;
    // Claimed before sending: a throw after the push must not alert the same condition again next tick.
    if (due.length) await service.store.setState(WATCH_KEY, state);
    for (const level of ["critical", "warn", "info"] as const) {
      const lines = due.filter((n) => n.level === level).map((n) => n.text);
      if (lines.length) await service.alert(level, `${service.broker.venue} ${level === "info" ? "housekeeping" : "account check"}`, lines.join("\n"));
    }
  }

  const account = await service.broker.account(marks, now);
  const dayLossPct = account.equityUsd > 0 ? (-account.dayPnlUsd / account.equityUsd) * 100 : 0;
  const today = now.toISOString().slice(0, 10);
  if (dayLossPct >= service.config.limits.dailyLossLimitPct && state.dayLossAlerted !== today) {
    state.dayLossAlerted = today;
    await service.store.setState(WATCH_KEY, state);
    await service.alert("critical", "Daily loss limit hit", `Day PnL $${account.dayPnlUsd.toFixed(2)} (${dayLossPct.toFixed(2)}%). New entries are blocked until 00:00 UTC.`);
  }

  // Mark history for move triggers. The watchlist is resolved every tick, so UI edits apply without a restart.
  const coins = [...new Set([...(await service.watchlist()), ...account.positions.map((p) => p.coin)])].filter((c) => marks.has(c));
  const hist = state.marks ?? {};
  // A coin with no stored marks (newly watched or held, or the first tick ever) has no baseline yet: it is
  // recorded this tick and only evaluated from the next, so adding coins never fires funding/OI levels at once.
  const seen = coins.filter((c) => hist[c]?.length);
  for (const c of coins) {
    const h = (hist[c] ?? []).filter(([ts]) => ts >= t - MARK_HISTORY_MS);
    h.push([t, marks.get(c)!]);
    hist[c] = h;
  }
  for (const c of Object.keys(hist)) if (!coins.includes(c)) delete hist[c];
  state.marks = hist;

  const oiChange4h: Record<string, number | null> = {};
  await Promise.all(
    seen.map(async (c) => {
      const pts = await service.data.series(`hl.oi.${c}`, new Date(t - 5 * HOUR)).catch(() => []);
      const first = pts.find((p) => p.t >= t - 4.5 * HOUR);
      const last = pts[pts.length - 1];
      oiChange4h[c] = first && last && first.v > 0 && last.t - first.t >= 3 * HOUR ? ((last.v - first.v) / first.v) * 100 : null;
    }),
  );

  const all = evaluateTriggers({ now: t, coins: seen, ctxs, marks: hist, oiChange4h, account });
  const cooldowns = (await service.store.getState<Record<string, string>>(COOLDOWN_KEY)) ?? {};
  for (const [k, v] of Object.entries(cooldowns)) if (t - new Date(v).getTime() > 24 * HOUR) delete cooldowns[k];
  for (const tr of all) {
    const last = cooldowns[tr.key];
    if (last && t - new Date(last).getTime() < TRIGGER_COOLDOWN_MS) {
      result.suppressed.push(tr.key);
      continue;
    }
    // The cooldown is stored before the alert goes out (claim, then send): if anything later throws, it does not fire again next tick.
    cooldowns[tr.key] = now.toISOString();
    await service.store.setState(COOLDOWN_KEY, cooldowns);
    result.triggers.push(tr);
    await service.alert(tr.level, tr.title, tr.detail);
  }
  await service.store.setState(COOLDOWN_KEY, cooldowns);

  // Should the agents run?
  const cfg = service.config;
  const { hours: reviewEveryHours } = await service.reviewEveryHours();
  const lastCycle = state.lastCycleAt ? new Date(state.lastCycleAt).getTime() : 0;
  const wake = result.triggers.filter((x) => x.wake);
  const reviewDue = reviewEveryHours > 0 && t - lastCycle >= reviewEveryHours * HOUR;
  let reason: string | null = null;
  if (opts.forceReview) reason = "operator-requested review";
  else if (wake.length && t - lastCycle >= cfg.cycleCooldownMin * MIN) reason = wake.map((x) => `${x.title} (${x.detail})`).join("; ");
  else if (reviewDue) reason = `scheduled review (every ${reviewEveryHours}h)`;

  state.lastTick = now.toISOString();
  if (reason && opts.runCycle !== false) {
    const dayStart = new Date(`${today}T00:00:00Z`);
    const done = await service.store.countRunsSince("cycle", dayStart);
    // The LLM cap is read before the cycle is claimed, so a refused cycle does not use up the cooldown or the review slot.
    const refused = done >= cfg.maxCyclesPerDay ? `daily cycle cap reached (${cfg.maxCyclesPerDay})` : await deskLlmRefusal(opts.llm ?? service.llm);
    if (refused) {
      result.cycle = { skipped: refused };
    } else {
      state.lastCycleAt = now.toISOString();
      await service.store.setState(WATCH_KEY, state);
      return { result, reason };
    }
  } else if (reason) {
    result.cycle = { skipped: "cycles disabled for this tick" };
  }
  await service.store.setState(WATCH_KEY, state);
  return { result, reason: null };
}
