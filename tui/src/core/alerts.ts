// Alert engine: keeps in-memory mark and OI history from successive polls,
// runs desk/triggers evaluateTriggers, and reports only alerts not seen
// within the cooldown. Pure apart from its own state; the store drives it.
import { changeOver, evaluateTriggers, HOUR } from "../../../src/server/desk/triggers.js";
import type { AccountState } from "../../../src/server/desk/types.js";
import type { AssetCtx } from "../../../src/shared/types.js";
import type { AccountSnapshot, Alert, MarketRow } from "./types.js";

export interface AlertEngineOptions {
  /** Same alert key is not reported again within this window. */
  cooldownMs?: number;
  /** How much mark / OI history to keep. Must cover the 4h change windows. */
  historyMs?: number;
  /** AccountState.venue label. */
  venue?: string;
}

const ACTIVE_MS = 4 * HOUR;

type Series = Array<[number, number]>;

function asCtx(m: MarketRow): AssetCtx {
  return {
    name: m.coin,
    szDecimals: m.szDecimals,
    markPx: m.markPx,
    oraclePx: m.markPx,
    midPx: m.midPx ?? m.markPx,
    dayNtlVlm: m.dayVolumeUsd,
    prevDayPx: m.prevDayPx,
    openInterest: m.markPx > 0 ? m.oiUsd / m.markPx : 0,
    funding: m.fundingHourly,
    premium: m.premium ?? 0,
    dayChange: m.dayChangePct / 100,
    isDelisted: m.isDelisted,
    maxLeverage: m.maxLeverage,
  };
}

function asAccountState(a: AccountSnapshot | null, venue: string): AccountState {
  if (!a) return { venue, equityUsd: 0, dayPnlUsd: 0, positions: [], available: false };
  return {
    venue,
    equityUsd: a.equityUsd,
    dayPnlUsd: 0,
    available: true,
    positions: a.positions.map((p) => ({
      coin: p.coin,
      side: p.side,
      size: p.size,
      entryPx: p.entryPx,
      markPx: p.markPx,
      stopPx: p.stopPx,
      tpPx: p.tpPx,
      unrealizedPnl: p.unrealizedPnlUsd,
      notionalUsd: p.notionalUsd,
    })),
  };
}

export class AlertEngine {
  private readonly cooldownMs: number;
  private readonly historyMs: number;
  private readonly venue: string;
  private marks = new Map<string, Series>();
  private oi = new Map<string, Series>();
  /** Last emission time per key, for the cooldown. */
  private emitted = new Map<string, number>();
  /** Latest alert per key and the last ingest at which its condition still held. */
  private firing = new Map<string, { alert: Alert; lastSeen: number }>();
  private lastNow = 0;

  constructor(opts: AlertEngineOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? 30 * 60_000;
    this.historyMs = opts.historyMs ?? 5 * HOUR;
    this.venue = opts.venue ?? "hyperliquid";
  }

  private push(map: Map<string, Series>, coin: string, now: number, v: number) {
    const s = (map.get(coin) ?? []).filter(([t]) => t >= now - this.historyMs);
    s.push([now, v]);
    map.set(coin, s);
  }

  /** OI (USD) history for a coin, ascending, in the shape coin.ts takes. */
  oiSeries(coin: string): Array<{ t: number; v: number }> {
    return (this.oi.get(coin) ?? []).map(([t, v]) => ({ t, v }));
  }

  /** Evaluates the triggers and returns only the alerts that are new (not reported within the cooldown). */
  ingest(now: number, markets: MarketRow[], account: AccountSnapshot | null, watch: string[]): Alert[] {
    this.lastNow = now;
    const byCoin = new Map(markets.map((m) => [m.coin, m]));
    const coins = [...new Set([...watch, ...(account?.positions.map((p) => p.coin) ?? [])])].filter((c) => byCoin.has(c));
    for (const c of coins) {
      const m = byCoin.get(c)!;
      this.push(this.marks, c, now, m.markPx);
      this.push(this.oi, c, now, m.oiUsd);
    }
    for (const c of [...this.marks.keys()]) {
      if (!coins.includes(c)) {
        this.marks.delete(c);
        this.oi.delete(c);
      }
    }

    const oiChange4h: Record<string, number | null> = {};
    for (const c of coins) oiChange4h[c] = changeOver(this.oi.get(c) ?? [], now, 4 * HOUR);

    const triggers = evaluateTriggers({
      now,
      coins,
      ctxs: markets.map(asCtx),
      marks: Object.fromEntries(this.marks),
      oiChange4h,
      account: asAccountState(account, this.venue),
    });

    const fresh: Alert[] = [];
    for (const t of triggers) {
      const last = this.emitted.get(t.key);
      if (last != null && now - last < this.cooldownMs) {
        const prior = this.firing.get(t.key);
        if (prior) prior.lastSeen = now;
        continue;
      }
      const alert: Alert = { key: t.key, level: t.level, title: t.title, detail: t.detail, at: now };
      this.emitted.set(t.key, now);
      this.firing.set(t.key, { alert, lastSeen: now });
      fresh.push(alert);
    }
    for (const [k, f] of this.firing) if (f.lastSeen < now - ACTIVE_MS) this.firing.delete(k);
    for (const [k, t] of this.emitted) if (t < now - Math.max(this.cooldownMs, ACTIVE_MS)) this.emitted.delete(k);
    return fresh;
  }

  /** Latest alert per key whose condition held within the last 4h, newest first. */
  active(): Alert[] {
    return [...this.firing.values()]
      .filter((f) => f.lastSeen >= this.lastNow - ACTIVE_MS)
      .map((f) => f.alert)
      .sort((a, b) => b.at - a.at);
  }
}
