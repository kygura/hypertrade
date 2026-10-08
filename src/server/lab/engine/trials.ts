import { mulberry32 } from "./rng.js";

// Effective number of independent trials (LAB.md §7) for the deflated Sharpe.
//
// A search scores thousands of rule variants, but most are threshold
// neighbours or family members of one another: their return tracks are
// nearly the same, so counting each as an independent trial overstates the
// multiple-testing penalty. Following López de Prado, the variants are
// clustered by the correlation of their return tracks and N_eff is the number
// of clusters: greedy, in the order the search scored them, a variant joins
// the largest existing cluster whose representative it correlates with at
// ≥ CLUSTER_CORR, else it starts a new one.
//
// The correlation of two strategy tracks r = s·x (s the 0/1 in-zone flag of
// the previous day, x the day's return) is, for x with mean ≈ 0, the overlap
// of their in-zone days |A ∩ B| / √(|A|·|B|) (Ochiai), which is a popcount on
// bitsets: clustering every variant of a default search costs a few ms on
// top of packing each signal once when it is first scored. On synthetic
// searches this count matched exact return-correlation clustering within
// ±8%. A participation ratio (Σλ)²/Σλ² was rejected: variant clusters are
// heavy-tailed (one family often holds a third of all variants), and the
// ratio, a Simpson index of cluster shares, collapsed to 6–7 for searches
// with 100+ distinct clusters, which would barely deflate anything.

/** Two variants whose return tracks correlate at least this much are one trial. */
export const CLUSTER_CORR = 0.5;
/** Above this many variants a seeded sample is clustered and the count scaled up (cost bound). */
export const MAX_CLUSTERED = 20_000;

/** In-zone days of a signal as a bitset, with their count. */
export interface ZoneBits {
  words: Uint32Array;
  count: number;
}

/** Packs sig[from, to) into a bitset. */
export function zoneBits(sig: Uint8Array, from: number, to: number): ZoneBits {
  const len = Math.max(0, to - from);
  const words = new Uint32Array(Math.ceil(len / 32));
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (sig[from + i]) {
      words[i >> 5]! |= 1 << (i & 31);
      count++;
    }
  }
  return { words, count };
}

const POP16 = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) POP16[i] = (i & 1) + POP16[i >> 1]!;

function overlap(a: Uint32Array, b: Uint32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]! & b[i]!;
    s += POP16[v & 0xffff]! + POP16[v >>> 16]!;
  }
  return s;
}

/** Ochiai overlap |A ∩ B| / √(|A|·|B|): the return correlation of the two tracks when daily returns have mean ≈ 0. */
export function zoneCorrelation(a: ZoneBits, b: ZoneBits): number {
  if (!a.count || !b.count) return 0;
  return overlap(a.words, b.words) / Math.sqrt(a.count * b.count);
}

/** Number of greedy correlation clusters among the zones (empty zones are skipped: they never trade). */
export function countClusters(zones: readonly ZoneBits[], corr = CLUSTER_CORR): number {
  const reps: Array<{ z: ZoneBits; size: number }> = [];
  const c2 = corr * corr;
  for (const z of zones) {
    if (!z.count) continue;
    let hit = -1;
    for (let j = 0; j < reps.length; j++) {
      const r = reps[j]!.z;
      // Ochiai ≤ √(min/max): zones of very different sizes cannot reach corr.
      const lo = Math.min(r.count, z.count);
      const hi = Math.max(r.count, z.count);
      if (lo < c2 * hi) continue;
      if (overlap(r.words, z.words) >= corr * Math.sqrt(r.count * z.count)) {
        hit = j;
        break;
      }
    }
    if (hit < 0) {
      reps.push({ z, size: 1 });
      continue;
    }
    // Keep representatives largest first, so most variants match early.
    reps[hit]!.size++;
    for (let j = hit; j > 0 && reps[j - 1]!.size < reps[j]!.size; j--) [reps[j - 1], reps[j]] = [reps[j]!, reps[j - 1]!];
  }
  return reps.length;
}

/**
 * N_eff for the deflated Sharpe: correlation clusters among the variants'
 * search-region zones, in [1, zones.length]. Above `max` variants a seeded
 * sample of `max` is clustered and the count scaled by N / max (this
 * over-counts clusters the sample saw several times, so the deflation only
 * gets stricter).
 */
export function effectiveTrials(zones: readonly ZoneBits[], o: { seed: number; max?: number; corr?: number }): number {
  const N = zones.length;
  if (N <= 1) return 1;
  const max = o.max ?? MAX_CLUSTERED;
  if (N <= max) return Math.max(1, countClusters(zones, o.corr));
  const rng = mulberry32(o.seed);
  const idx = Array.from({ length: N }, (_, i) => i);
  for (let i = 0; i < max; i++) {
    const j = i + Math.floor(rng() * (N - i));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const sample = idx.slice(0, max).sort((a, b) => a - b).map((i) => zones[i]!);
  return Math.min(N, Math.max(1, Math.round((countClusters(sample, o.corr) * N) / max)));
}
