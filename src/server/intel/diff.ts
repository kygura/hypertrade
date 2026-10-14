import { SNAPSHOT_METRICS, type Alert, type Brief, type DeltaUnit, type DiffItem, type ExposurePosition, type SnapshotMetric, type SnapshotRow } from "../../shared/intel.js";
import { baselineZ, metricZ, type Point } from "./normalize.js";
import { atr as atrOf } from "../desk/tools.js";

// Diff items, materiality and ranking (SPEC.md § Intel I0.5). Pure.
//   materiality    = |z| × exposure_weight × stop_proximity
//   exposure_weight = asset notional / Σ notional (all three sources);
//                    watchlist-only assets get WATCH_FLOOR
//   stop_proximity = 1 + 2 · max(0, 1 − dist_to_stop / (2 · ATR14_1h)) with a
//                    known stop, else 1
// Every materiality in Intel goes through materiality() below: surprise ×
// exposure × proximity × confluence(k) (SPEC.md § Scout S0.6).
// An item clears at |z| ≥ minZ; the cleared ones rank by materiality and the
// top k go into the brief. Nothing clears → silent. A level or ratio z is a
// state, not a change, so it also has to have changed since the baseline
// (changedSinceBaseline, SPEC I0.4).

export const WATCH_FLOOR = 0.05;
/** A level/ratio z already past minZ at the baseline clears only if it moved at least this much. */
export const LEVEL_Z_MOVE = 1;

/** The independent signal classes an asset can show at once (SPEC.md § Scout S0.6). */
export type SignalSource = "snapshot" | "flow" | "regime" | "news";
export const CONFLUENCE_WINDOW_MS = 6 * 3_600_000;
export const CONFLUENCE_CAP = 1.5;

/** 1 for a lone signal, +0.25 per further independent source, capped at 1.5. k counts the item's own source too. */
export const confluence = (k: number): number => Math.min(CONFLUENCE_CAP, 1 + 0.25 * (Math.max(1, k) - 1));

/** The one materiality formula. `surprise` is |z|, a flag score, or magnitude × path weight. */
export function materiality(parts: { surprise: number; exposure: number; proximity: number }, k = 1): number {
  return parts.surprise * parts.exposure * parts.proximity * confluence(k);
}

/** k for an item of source `own`: itself plus the distinct other sources active on the asset. */
export const confluenceK = (active: ReadonlySet<SignalSource> | undefined, own: SignalSource): number => 1 + [...(active ?? [])].filter((s) => s !== own).length;

/** Active sources per asset. */
export type ActiveSources = Map<string, Set<SignalSource>>;

export function noteSource(m: ActiveSources, asset: string, s: SignalSource): void {
  (m.get(asset) ?? m.set(asset, new Set()).get(asset)!).add(s);
}

// Flips (`<m>_flip`, `oi_up_price_down`) and crossings (`m>v`) are regime moves; the other flow alerts are detectors.
const REGIME_NAME = /[<>]|_flip$|^oi_up_price_down$/;

/** The source class an alert represents; terminal alerts are none. */
export function alertSource(a: Pick<Alert, "kind" | "eventType">): SignalSource | null {
  if (a.kind === "flow") return REGIME_NAME.test(a.eventType ?? "") ? "regime" : "flow";
  return a.kind === "terminal" ? null : "news";
}

/** Sources seen per asset inside the confluence window: alerts since then, plus the last brief's snapshot z moves. Read before alerts are routed. */
export async function activeSources(
  store: { listAlerts(o: { since?: Date; limit: number }): Promise<Alert[]>; latestBrief(): Promise<Brief | null> },
  now: Date,
): Promise<ActiveSources> {
  const since = new Date(now.getTime() - CONFLUENCE_WINDOW_MS);
  const m: ActiveSources = new Map();
  for (const a of await store.listAlerts({ since, limit: 500 })) {
    const s = alertSource(a);
    if (s) noteSource(m, a.asset, s);
  }
  const brief = await store.latestBrief();
  if (brief && Date.parse(brief.createdAt) >= since.getTime()) for (const i of brief.items) noteSource(m, i.asset, "snapshot");
  return m;
}

/** DiffItem plus the baseline z (level/ratio only). Internal: rankDiffs strips it. */
export type RawDiffItem = DiffItem & { zBase?: number };

export type Bar = { h: number; l: number; c: number };

export interface AssetDiffInput {
  asset: string;
  current: SnapshotRow;
  baseline: SnapshotRow;
  /** Snapshot history (≥ 7 days before current.ts when available). */
  history: SnapshotRow[];
  /** Per-metric stand-in series while the snapshot store is young (normalize.metricZ). */
  coldStart?: Partial<Record<SnapshotMetric, Point[]>>;
  /** 1h candles, ascending, for ATR14. */
  candles1h?: Bar[];
  /** Positions in this asset across all sources; empty → watchlist only. */
  positions: Pick<ExposurePosition, "side" | "stopPx" | "notionalUsd">[];
}

const FIELD: Record<SnapshotMetric, keyof SnapshotRow> = {
  price: "price",
  oi_usd: "oiUsd",
  funding: "funding",
  premium: "premium",
  basis: "basis",
  vol24h: "vol24h",
  depth_bid_1: "depthBid1",
  depth_ask_1: "depthAsk1",
  depth_bid_2: "depthBid2",
  depth_ask_2: "depthAsk2",
  spread_bps: "spreadBps",
};

export function metricValue(row: SnapshotRow, metric: SnapshotMetric): number | null {
  const v = row[FIELD[metric]];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** pct for levels that scale (price, OI, volume, depth), bps for rates and the spread. */
export function delta(metric: SnapshotMetric, from: number, to: number): { delta: number; deltaUnit: DeltaUnit } {
  if (metric === "funding" || metric === "premium" || metric === "basis") return { delta: (to - from) * 1e4, deltaUnit: "bps" };
  if (metric === "spread_bps") return { delta: to - from, deltaUnit: "bps" };
  return { delta: from !== 0 ? ((to - from) / Math.abs(from)) * 100 : 0, deltaUnit: "pct" };
}

/**
 * Distance from `mark` to the nearest known stop, in price units, on the
 * losing side of each position: a stop already crossed counts as 0.
 */
export function stopDistance(mark: number, positions: AssetDiffInput["positions"]): number | null {
  let best: number | null = null;
  for (const p of positions) {
    if (p.stopPx == null || !(p.stopPx > 0)) continue;
    const d = Math.max(0, p.side === "long" ? mark - p.stopPx : p.stopPx - mark);
    best = best == null ? d : Math.min(best, d);
  }
  return best;
}

export function stopProximity(dist: number | null, atr: number | null): number {
  if (dist == null || atr == null || !(atr > 0)) return 1;
  return 1 + 2 * Math.max(0, 1 - dist / (2 * atr));
}

export function exposureWeight(positions: AssetDiffInput["positions"], totalNotionalUsd: number): number {
  if (!positions.length) return WATCH_FLOOR;
  if (!(totalNotionalUsd > 0)) return 0;
  return positions.reduce((s, p) => s + Math.abs(p.notionalUsd), 0) / totalNotionalUsd;
}

/** Every asset × metric pair that has a z. `diffed` counts them (cleared or not). */
export function buildDiffItems(inputs: AssetDiffInput[], totalNotionalUsd: number, active: ActiveSources = new Map()): { items: RawDiffItem[]; diffed: number } {
  const items: RawDiffItem[] = [];
  for (const a of inputs) {
    const held = a.positions.length > 0;
    const weight = exposureWeight(a.positions, totalNotionalUsd);
    const mark = a.current.price;
    const dist = stopDistance(mark, a.positions);
    const atr = a.candles1h ? atrOf(a.candles1h) : null;
    const proximity = stopProximity(dist, atr);
    const stop =
      dist == null ? {} : { stopDistPct: mark > 0 ? (dist / mark) * 100 : 0, ...(atr != null && atr > 0 ? { stopDistAtr: dist / atr } : {}) };
    const k = confluenceK(active.get(a.asset), "snapshot");
    const t = Date.parse(a.current.ts);
    const t0 = Date.parse(a.baseline.ts);
    for (const metric of SNAPSHOT_METRICS) {
      const to = metricValue(a.current, metric);
      const from = metricValue(a.baseline, metric);
      if (to == null || from == null) continue;
      const history = a.history.flatMap((r) => {
        const v = metricValue(r, metric);
        return v == null ? [] : [{ t: Date.parse(r.ts), v }];
      });
      const zIn = { from: { t: t0, v: from }, to: { t, v: to }, history, coldStart: a.coldStart?.[metric] };
      const z = metricZ(metric, zIn);
      if (z == null) continue;
      const zBase = baselineZ(metric, zIn);
      items.push({
        asset: a.asset,
        metric,
        held,
        from,
        to,
        ...delta(metric, from, to),
        z,
        materiality: materiality({ surprise: Math.abs(z), exposure: weight, proximity }, k),
        confluence: confluence(k),
        exposureWeight: weight,
        stopProximity: proximity,
        ...stop,
        ts: a.current.ts,
        baselineTs: a.baseline.ts,
        ...(zBase != null ? { zBase } : {}),
      });
    }
  }
  return { items, diffed: items.length };
}

/**
 * Level/ratio gate: the z crossed minZ since the baseline (|zBase| < minZ) or
 * moved ≥ LEVEL_Z_MOVE. No zBase (returns, or no baseline z) → passes.
 */
export function changedSinceBaseline(z: number, zBase: number | undefined, minZ: number): boolean {
  return zBase == null || Math.abs(zBase) < minZ || Math.abs(z - zBase) >= LEVEL_Z_MOVE;
}

/** Items with |z| ≥ minZ that changed since the baseline and clear the digest threshold, by materiality (then |z|) descending, at most topK. */
export function rankDiffs(items: RawDiffItem[], o: { minZ: number; topK: number; digestMateriality?: number }): DiffItem[] {
  return items
    .filter((i) => Math.abs(i.z) >= o.minZ && changedSinceBaseline(i.z, i.zBase, o.minZ) && i.materiality >= (o.digestMateriality ?? 0))
    .sort((a, b) => b.materiality - a.materiality || Math.abs(b.z) - Math.abs(a.z))
    .slice(0, Math.max(0, o.topK))
    .map(({ zBase: _, ...i }) => i);
}
