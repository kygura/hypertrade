import { bucketBounds, bucketIndex, type Coverage, type LiqBucket, type Position } from "../../shared/platform.js";

export interface Cluster { priceLo: number; priceHi: number; distancePct: number; notionalUsd: number }
export interface Aggregate { buckets: LiqBucket[]; nearestClusters: { long: Cluster | null; short: Cluster | null } }

const MIN_CLUSTER_USD = 250_000;

/**
 * Sums liquidation notional on the fixed log grid. Longs sit below mark, shorts above; positions with no
 * liquidationPx, a liquidationPx on the wrong side of mark (stale), or outside mark × (1 ± rangePct) are dropped.
 */
export function aggregate(
  positions: Pick<Position, "szi" | "positionValue" | "liquidationPx">[],
  o: { mark: number; bucketBps: number; rangePct: number },
): Aggregate {
  const { mark, bucketBps, rangePct } = o;
  if (!(mark > 0) || !(bucketBps > 0) || !(rangePct > 0) || !Number.isFinite(mark + bucketBps + rangePct)) throw new Error("mark, bucketBps and rangePct must be finite and positive");
  const lo = mark * (1 - rangePct), hi = mark * (1 + rangePct);
  const cells = new Map<number, { longUsd: number; shortUsd: number }>();
  for (const p of positions) {
    const px = p.liquidationPx;
    if (px == null || !Number.isFinite(px) || !(px > 0) || !(p.positionValue >= 0) || !Number.isFinite(p.positionValue) || px < lo || px > hi) continue;
    const long = p.szi > 0;
    if (long ? px >= mark : px <= mark) continue;
    const idx = bucketIndex(px, bucketBps);
    const c = cells.get(idx) ?? { longUsd: 0, shortUsd: 0 };
    if (long) c.longUsd += p.positionValue; else c.shortUsd += p.positionValue;
    cells.set(idx, c);
  }
  const buckets = [...cells].sort((a, b) => a[0] - b[0]).map(([idx, c]) => ({ idx, ...bucketBounds(idx, bucketBps), ...c }));
  const side = (key: "longUsd" | "shortUsd"): Cluster | null => {
    const total = buckets.reduce((a, b) => a + b[key], 0);
    const min = Math.max(total * 0.01, MIN_CLUSTER_USD);
    const near = key === "longUsd" ? [...buckets].reverse() : buckets; // closest to mark first
    const b = near.find((x) => x[key] >= min);
    if (!b) return null;
    const edge = key === "longUsd" ? b.priceHi : b.priceLo; // edge facing the mark
    return { priceLo: b.priceLo, priceHi: b.priceHi, distancePct: (Math.abs(mark - edge) / mark) * 100, notionalUsd: b[key] };
  };
  return { buckets, nearestClusters: { long: side("longUsd"), short: side("shortUsd") } };
}

/** Nearest-rank percentile of a sorted array. */
const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

/** oiNotional null (unknown) or <= 0 gives ratio null, never 0. pollAges in seconds. Negative or non-finite ages are ignored. HL OI counts one side of each trade while tracked notional sums longs + shorts, so ratio = tracked / (2 × OI). */
export function coverage(trackedNotional: number, oiNotional: number | null, addresses: number, pollAges: number[]): Coverage {
  const ages = pollAges.filter((a) => Number.isFinite(a) && a >= 0).sort((a, b) => a - b);
  return {
    trackedNotional,
    oiNotional: oiNotional ?? 0,
    ratio: oiNotional != null && oiNotional > 0 ? trackedNotional / (2 * oiNotional) : null,
    addresses,
    pollAgeP50Sec: ages.length ? pct(ages, 0.5) : null,
    pollAgeP90Sec: ages.length ? pct(ages, 0.9) : null,
  };
}
