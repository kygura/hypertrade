import { fmtPx } from "../../shared/format.js";
import { runDesk, type ProviderFactory } from "./agents.js";
import { HOUR, evaluateTriggers, type Trigger } from "./triggers.js";
import type { DeskService } from "./service.js";

export { changeOver, evaluateTriggers, type Trigger, type TriggerInput } from "./triggers.js";

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
//      review is due, within the daily cycle cap and the cooldown
//
// The LLM only runs in step 5; everything before it is arithmetic.

const MIN = 60_000;
export const WATCH_KEY = "watch";
export const COOLDOWN_KEY = "trigger_cooldowns";
const TRIGGER_COOLDOWN_MS = 3 * HOUR;
const MARK_HISTORY_MS = 26 * HOUR;

export interface WatchState {
  lastTick?: string;
  lastCycleAt?: string;
  /** Recent marks per coin, [epoch ms, price], oldest first. */
  marks?: Record<string, Array<[number, number]>>;
  dayLossAlerted?: string;
}

export interface TickResult {
  at: string;
  expired: number;
  settled: Array<{ coin: string; kind: string; pnl: number }>;
  triggers: Trigger[];
  suppressed: string[];
  cycle: { runId: string; stop: string; reason: string } | { skipped: string } | null;
}

export interface TickOptions {
  /** Run an agent cycle when warranted (false: alerts only). */
  runCycle?: boolean;
  cycleTimeoutMs?: number;
  makeProvider?: ProviderFactory;
  /** Force a review cycle regardless of triggers and schedule (still capped per day). */
  forceReview?: boolean;
}

export async function tick(service: DeskService, opts: TickOptions = {}): Promise<TickResult> {
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

  const account = await service.broker.account(marks, now);
  const dayLossPct = account.equityUsd > 0 ? (-account.dayPnlUsd / account.equityUsd) * 100 : 0;
  const today = now.toISOString().slice(0, 10);
  if (dayLossPct >= service.config.limits.dailyLossLimitPct && state.dayLossAlerted !== today) {
    state.dayLossAlerted = today;
    await service.alert("critical", "Daily loss limit hit", `Day PnL $${account.dayPnlUsd.toFixed(2)} (${dayLossPct.toFixed(2)}%). New entries are blocked until 00:00 UTC.`);
  }

  // Mark history for move triggers.
  const coins = [...new Set([...service.config.watchlist, ...account.positions.map((p) => p.coin)])].filter((c) => marks.has(c));
  const hist = state.marks ?? {};
  for (const c of coins) {
    const h = (hist[c] ?? []).filter(([ts]) => ts >= t - MARK_HISTORY_MS);
    h.push([t, marks.get(c)!]);
    hist[c] = h;
  }
  for (const c of Object.keys(hist)) if (!coins.includes(c)) delete hist[c];
  state.marks = hist;

  const oiChange4h: Record<string, number | null> = {};
  await Promise.all(
    coins.map(async (c) => {
      const pts = await service.data.series(`hl.oi.${c}`, new Date(t - 5 * HOUR)).catch(() => []);
      const first = pts.find((p) => p.t >= t - 4.5 * HOUR);
      const last = pts[pts.length - 1];
      oiChange4h[c] = first && last && first.v > 0 && last.t - first.t >= 3 * HOUR ? ((last.v - first.v) / first.v) * 100 : null;
    }),
  );

  const all = evaluateTriggers({ now: t, coins, ctxs, marks: hist, oiChange4h, account });
  const cooldowns = (await service.store.getState<Record<string, string>>(COOLDOWN_KEY)) ?? {};
  for (const tr of all) {
    const last = cooldowns[tr.key];
    if (last && t - new Date(last).getTime() < TRIGGER_COOLDOWN_MS) {
      result.suppressed.push(tr.key);
      continue;
    }
    cooldowns[tr.key] = now.toISOString();
    result.triggers.push(tr);
    await service.alert(tr.level, tr.title, tr.detail);
  }
  for (const [k, v] of Object.entries(cooldowns)) if (t - new Date(v).getTime() > 24 * HOUR) delete cooldowns[k];
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
    if (done >= cfg.maxCyclesPerDay) {
      result.cycle = { skipped: `daily cycle cap reached (${cfg.maxCyclesPerDay})` };
    } else {
      state.lastCycleAt = now.toISOString();
      await service.store.setState(WATCH_KEY, state);
      try {
        const r = await runDesk(
          { service, kind: "cycle", input: reason, act: true, makeProvider: opts.makeProvider, timeoutMs: opts.cycleTimeoutMs, trigger: { triggers: result.triggers } },
          () => {},
        );
        result.cycle = { runId: r.runId, stop: r.stop, reason };
      } catch (err) {
        result.cycle = { skipped: err instanceof Error ? err.message : String(err) };
      }
      return result;
    }
  } else if (reason) {
    result.cycle = { skipped: "cycles disabled for this tick" };
  }
  await service.store.setState(WATCH_KEY, state);
  return result;
}
