import type { AssetCtx } from "../../shared/types.js";
import { runDesk, type ProviderFactory } from "./agents.js";
import { marketBreadth } from "./analytics.js";
import { fmtPx, type DeskService } from "./service.js";
import type { AccountState, AlertLevel } from "./types.js";

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
const HOUR = 60 * MIN;
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

export interface Trigger {
  key: string;
  level: AlertLevel;
  title: string;
  detail: string;
  /** Whether this condition is worth waking the agents for. */
  wake: boolean;
}

export interface TickResult {
  at: string;
  expired: number;
  settled: Array<{ coin: string; kind: string; pnl: number }>;
  triggers: Trigger[];
  suppressed: string[];
  cycle: { runId: string; stop: string; reason: string } | { skipped: string } | null;
}

/** Price change over `ms` from a mark history; null when history is shorter than ~80% of it. */
export function changeOver(hist: Array<[number, number]>, now: number, ms: number): number | null {
  if (hist.length < 2) return null;
  const target = now - ms;
  if (hist[0]![0] > target + ms * 0.2) return null;
  let base: number | null = null;
  for (const [t, px] of hist) {
    if (t <= target) base = px;
    else break;
  }
  base ??= hist[0]![1];
  const last = hist[hist.length - 1]![1];
  return base > 0 ? ((last - base) / base) * 100 : null;
}

export interface TriggerInput {
  now: number;
  coins: string[];
  ctxs: AssetCtx[];
  marks: Record<string, Array<[number, number]>>;
  /** OI change over the last ~4h, percent, per coin (from the collector's snapshots). */
  oiChange4h: Record<string, number | null>;
  account: AccountState;
}

/** Pure trigger evaluation; thresholds are deliberately coarse. */
export function evaluateTriggers(i: TriggerInput): Trigger[] {
  const out: Trigger[] = [];
  const byName = new Map(i.ctxs.map((c) => [c.name, c]));
  for (const coin of i.coins) {
    const hist = i.marks[coin] ?? [];
    const h1 = changeOver(hist, i.now, HOUR);
    const h4 = changeOver(hist, i.now, 4 * HOUR);
    const big = coin === "BTC" ? [2.5, 5] : [4, 8];
    if (h1 != null && Math.abs(h1) >= big[0]!) {
      out.push({ key: `move1h:${coin}:${Math.sign(h1)}`, level: "warn", title: `${coin} ${h1 > 0 ? "+" : ""}${h1.toFixed(1)}% in 1h`, detail: `${coin} moved ${h1.toFixed(2)}% in the last hour.`, wake: true });
    } else if (h4 != null && Math.abs(h4) >= big[1]!) {
      out.push({ key: `move4h:${coin}:${Math.sign(h4)}`, level: "warn", title: `${coin} ${h4 > 0 ? "+" : ""}${h4.toFixed(1)}% in 4h`, detail: `${coin} moved ${h4.toFixed(2)}% in the last 4 hours.`, wake: true });
    }
    const ctx = byName.get(coin);
    if (ctx) {
      const apr = ctx.funding * 24 * 365 * 100;
      if (apr >= 50 || apr <= -30) {
        out.push({
          key: `funding:${coin}:${Math.sign(apr)}`,
          level: "info",
          title: `${coin} funding ${apr.toFixed(0)}% APR`,
          detail: `${coin} hourly funding annualizes to ${apr.toFixed(1)}%: ${apr > 0 ? "longs are crowded" : "shorts are crowded"}.`,
          wake: true,
        });
      }
    }
    const oi = i.oiChange4h[coin];
    if (oi != null && Math.abs(oi) >= 10) {
      out.push({ key: `oi:${coin}:${Math.sign(oi)}`, level: "info", title: `${coin} OI ${oi > 0 ? "+" : ""}${oi.toFixed(0)}% in 4h`, detail: `${coin} open interest changed ${oi.toFixed(1)}% over ~4h.`, wake: true });
    }
  }
  for (const p of i.account.positions) {
    if (p.stopPx == null) {
      out.push({ key: `nostop:${p.coin}`, level: "critical", title: `${p.coin} has no stop`, detail: `${p.side} ${p.size} ${p.coin} is open without a protective stop.`, wake: true });
      continue;
    }
    const full = Math.abs(p.entryPx - p.stopPx);
    const left = p.side === "long" ? p.markPx - p.stopPx : p.stopPx - p.markPx;
    if (full > 0 && left > 0 && left / full <= 0.25) {
      out.push({
        key: `nearstop:${p.coin}`,
        level: "warn",
        title: `${p.coin} near its stop`,
        detail: `${p.side} ${p.coin} mark ${fmtPx(p.markPx)}, stop ${fmtPx(p.stopPx)}: ${Math.round((left / full) * 100)}% of the stop distance left.`,
        wake: true,
      });
    }
  }
  const b = marketBreadth(i.ctxs, 50);
  if (b.sample >= 20 && Math.abs(b.medianDayChangePct) >= 6 && (b.advancingPct <= 15 || b.advancingPct >= 85)) {
    out.push({
      key: `breadth:${Math.sign(b.medianDayChangePct)}`,
      level: "warn",
      title: `Breadth shock: ${b.advancingPct}% advancing`,
      detail: `Median top-50 perp ${b.medianDayChangePct}% over 24h, ${b.advancingPct}% advancing.`,
      wake: true,
    });
  }
  return out;
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
  const held = await service.store.paperPositions();
  if (held.length) {
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
  const lastCycle = state.lastCycleAt ? new Date(state.lastCycleAt).getTime() : 0;
  const wake = result.triggers.filter((x) => x.wake);
  const reviewDue = cfg.reviewEveryHours > 0 && t - lastCycle >= cfg.reviewEveryHours * HOUR;
  let reason: string | null = null;
  if (opts.forceReview) reason = "operator-requested review";
  else if (wake.length && t - lastCycle >= cfg.cycleCooldownMin * MIN) reason = wake.map((x) => `${x.title} (${x.detail})`).join("; ");
  else if (reviewDue) reason = `scheduled review (every ${cfg.reviewEveryHours}h)`;

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
