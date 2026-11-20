import { fmtPx, fmtUsd } from "../../shared/format.js";
import { fetchCandles, hlInfo, parseMetaAndCtxs } from "../../shared/hl-client.js";
import type { LiqMapSnapshot, StopMapSnapshot } from "../../shared/platform.js";
import type { Candle } from "../../shared/types.js";
import { liquiditySweep } from "../routine/board.js";
import type { ClearedLiquidity, LiqLevel, SweepRead } from "../routine/liquidity.js";
import { sweepClearedLimit } from "../routine/tripwires.js";
import { coverage } from "./liqmap.js";
import type { LoopDef } from "./runtime.js";
import { envNum, type Info } from "./scanner.js";
import type { PlatformStore } from "./store.js";

// Liquidity sweep alert (docs/fallback-routine.md § Tripwires, liquidity_sweep): at each 4h close (+60 s) the top
// PLATFORM_LIQMAP_COINS by OI notional are read through the board's own composition (routine/board.ts
// liquiditySweep: candles → liquidityLevels → sweepOf → clearedLiquidity against liqmap_snapshots and stopmap_snapshots). A reclaimed sweep
// whose cleared notional reaches the tripwire's limit is pushed at info level, facts only. Deduped on
// coin|level|bar, one per coin per 4h. In-memory state: a restart inside the evaluation window can repeat one push.

const H4 = 4 * 3_600_000;
const DAY = 24 * 3_600_000;
/** Wait after the close for HL to publish the closed bar. */
const CLOSE_DELAY_MS = 60_000;
/** A close older than this when first seen (boot, a long stall) is skipped, not evaluated late. */
const EVAL_WINDOW_MS = 15 * 60_000;
const LOOKBACK = { "4h": 35 * DAY, "1d": 130 * DAY } as const;

export interface SweepEval {
  coin: string;
  sweep: SweepRead;
  cleared: ClearedLiquidity | null;
  oiUsd: number;
  /** OI in contracts over the swept bar, %, from scan snapshots; null when they do not cover it. */
  oiChgPct: number | null;
}

const LABEL: Record<LiqLevel["source"], (side: LiqLevel["side"]) => string> = {
  range20: (s) => `20-bar range ${s}`,
  pdh: () => "PDH",
  pdl: () => "PDL",
  pwh: () => "PWH",
  pwl: () => "PWL",
  range12w: (s) => `12-week ${s}`,
  equal: (s) => `equal ${s}s`,
  round: () => "round number",
};
export const levelLabel = (l: LiqLevel) => LABEL[l.source](l.side) + (l.touches > 1 ? ` (${l.touches} touches)` : "");

/** The push for one evaluation, or null: only a reclaimed sweep whose cleared notional reaches the tripwire limit. Facts, no verdict. */
export function sweepAlert(e: SweepEval): { key: string; title: string; body: string } | null {
  const { sweep, cleared } = e;
  if (!sweep.reclaimed || !cleared || cleared.clearedUsd < sweepClearedLimit(e.oiUsd)) return null;
  const side = sweep.side === "low" ? "long" : "short";
  const usd = (x: number) => fmtUsd(x, { compact: true });
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    `${sweep.tf} bar swept the ${levelLabel(sweep.level)} at ${fmtPx(sweep.level.px)} by ${sweep.depthAtr} ATR (wick to ${fmtPx(sweep.wick)}, ${pct(sweep.wickShare)} of the bar) and closed back inside.`,
    `Cleared ${usd(cleared.clearedUsd)} of tracked ${side} liquidations, ${pct(cleared.shareOfSide)} of tracked ${side}s within ±20%; coverage ${cleared.coverageRatio == null ? "n/a" : pct(cleared.coverageRatio)} of OI.`,
    `Resting ${side} stops in that zone before the bar: ${cleared.stopsUsd == null ? "n/a" : usd(cleared.stopsUsd)} (same tracked wallets).`,
    `OI over the bar ${e.oiChgPct == null ? "n/a" : `${e.oiChgPct > 0 ? "+" : ""}${e.oiChgPct.toFixed(1)}%`}.`,
  ];
  return { key: `${e.coin}|${sweep.level.key}|${sweep.t}`, title: `Sweep: ${e.coin} ${sweep.tf} ${levelLabel(sweep.level)} ${fmtPx(sweep.level.px)}`, body: lines.join("\n") };
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** OI in contracts (oiUsd / mark) from the last scan sample at or before the bar's open to the last one at or before its close. */
export function oiChangeOverBar(samples: Array<{ ts: string; inputs: Record<string, unknown> }>, bar: { t: number; T: number }): number | null {
  const contracts = (at: number, tol: number) => {
    let best: { t: number; v: number } | null = null;
    for (const s of samples) {
      const t = Date.parse(s.ts);
      const oi = num(s.inputs.oiUsd);
      const mark = num(s.inputs.mark);
      if (t <= at && t >= at - tol && oi !== null && mark && (!best || t > best.t)) best = { t, v: oi / mark };
    }
    return best?.v ?? null;
  };
  const a = contracts(bar.t, 30 * 60_000);
  const b = contracts(bar.T + 1, 30 * 60_000);
  return a && b ? Math.round((b / a - 1) * 1000) / 10 : null;
}

/** One coin at `now`: the sweeps of the last closed 4h bar (and 1d bar at a day close) with what they cleared. */
export function evaluateCoin(i: {
  coin: string;
  c4h: Candle[];
  c1d: Candle[];
  now: number;
  liqmap: { snapshots: LiqMapSnapshot[]; coverageRatio: number | null; stops?: StopMapSnapshot[] };
  oiUsd: number;
  samples: Array<{ ts: string; inputs: Record<string, unknown> }>;
}): SweepEval[] {
  const tfs = Math.floor(i.now / H4) * H4 % DAY === 0 ? (["1d", "4h"] as const) : (["4h"] as const);
  return tfs.flatMap((tf) => {
    const { sweep, cleared } = liquiditySweep({ c4h: i.c4h, c1d: i.c1d, tf, now: i.now, liqmap: i.liqmap });
    if (!sweep) return [];
    const bar = (tf === "4h" ? i.c4h : i.c1d).find((c) => c.t === sweep.t)!;
    return [{ coin: i.coin, sweep, cleared, oiUsd: i.oiUsd, oiChgPct: oiChangeOverBar(i.samples, bar) }];
  });
}

export function createSweepLoop(deps: {
  store: Pick<PlatformStore, "listPositions" | "liqmapHistory" | "stopmapHistory" | "scanSnapshotsSince">;
  notify: (title: string, body: string, path: string) => Promise<unknown>;
  info?: Info;
  candles?: (coin: string, interval: "4h" | "1d", start: number, end: number) => Promise<Candle[]>;
  now?: () => number;
  coins?: number;
}) {
  const { store } = deps;
  const info = deps.info ?? hlInfo;
  const candles = deps.candles ?? ((coin, interval, start, end) => fetchCandles(coin, interval, start, end));
  const now = deps.now ?? Date.now;
  const topN = deps.coins ?? envNum("PLATFORM_LIQMAP_COINS", 30);
  let evaluated = -Infinity;
  const sent = new Set<string>();
  const lastPush = new Map<string, number>();

  async function tick(): Promise<SweepEval[]> {
    const t = now();
    const close = Math.floor(t / H4) * H4;
    if (close <= evaluated || t < close + CLOSE_DELAY_MS) return [];
    evaluated = close;
    if (t > close + EVAL_WINDOW_MS) return [];
    const { ctxs } = parseMetaAndCtxs(await info<unknown>({ type: "metaAndAssetCtxs" }));
    const top = ctxs
      .filter((c) => !c.isDelisted && c.markPx > 0 && Number.isFinite(c.markPx * c.openInterest))
      .sort((a, b) => b.openInterest * b.markPx - a.openInterest * a.markPx)
      .slice(0, topN);
    const out: SweepEval[] = [];
    for (const ctx of top) {
      const coin = ctx.name;
      const oiUsd = ctx.openInterest * ctx.markPx;
      try {
        const since = new Date(close - 2 * DAY).toISOString();
        const [c4h, c1d, snapshots, stops, positions, samples] = await Promise.all([
          candles(coin, "4h", t - LOOKBACK["4h"], t),
          candles(coin, "1d", t - LOOKBACK["1d"], t),
          store.liqmapHistory(coin, since),
          store.stopmapHistory(coin, since),
          store.listPositions(coin),
          store.scanSnapshotsSince(new Date(close - DAY - H4).toISOString(), [coin]),
        ]);
        const tracked = positions.reduce((a, p) => a + p.positionValue, 0);
        const coverageRatio = coverage(tracked, oiUsd, new Set(positions.map((p) => p.address)).size, []).ratio;
        for (const e of evaluateCoin({ coin, c4h, c1d, now: t, liqmap: { snapshots, coverageRatio, stops }, oiUsd, samples })) {
          out.push(e);
          const a = sweepAlert(e);
          if (!a || sent.has(a.key) || (lastPush.get(coin) ?? -Infinity) > t - H4) continue;
          sent.add(a.key);
          lastPush.set(coin, t);
          await deps.notify(a.title, a.body, `/coin/${encodeURIComponent(coin)}`);
        }
      } catch (err) {
        console.error(`[sweep] ${coin}:`, err instanceof Error ? err.message : err);
      }
    }
    if (sent.size > 2_000) sent.clear();
    return out;
  }

  return { tick, def: { name: "sweep", intervalSec: 60, run: async () => void (await tick()) } satisfies LoopDef };
}
