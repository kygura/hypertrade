import { fmtPx } from "../../shared/format.js";
import type { AssetCtx } from "../../shared/types.js";
import { marketBreadth } from "./analytics.js";
import type { AccountState, AlertLevel } from "./types.js";

// Pure trigger evaluation for the watch tick (watch.ts) and the terminal
// companion: no db, no service, no LLM.

export const HOUR = 3_600_000;

export interface Trigger {
  key: string;
  level: AlertLevel;
  title: string;
  detail: string;
  /** Whether this condition is worth waking the agents for. */
  wake: boolean;
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
