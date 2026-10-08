import type { LabDataset } from "../types.js";
import { DAY_MS } from "../types.js";
import { transformSeries } from "./features.js";
import { gauss, mulberry32 } from "./rng.js";

// Synthetic datasets for the engine tests.

const T0 = Date.UTC(2018, 0, 1);

export interface SyntheticOptions {
  seed: number;
  days?: number;
  /** Next-day drift while z(a, 30) < -1 AND b ≥ 0; 0 = pure noise. */
  drift?: number;
  noise?: number;
}

/**
 * Metrics: syn:a (random walk), syn:b (iid normal), syn:c (random walk), syn:d (iid normal).
 * Price: daily returns N(0, noise), plus `drift` on days after the planted zone fires.
 */
export function synthetic(o: SyntheticOptions): LabDataset {
  const n = o.days ?? 2500;
  const rng = mulberry32(o.seed);
  const t: number[] = [];
  const a: number[] = [];
  const b: number[] = [];
  const c: number[] = [];
  const d: number[] = [];
  let wa = 0;
  let wc = 0;
  for (let i = 0; i < n; i++) {
    t.push(T0 + i * DAY_MS);
    wa += gauss(rng);
    wc += gauss(rng);
    a.push(wa);
    b.push(gauss(rng));
    c.push(wc);
    d.push(gauss(rng));
  }
  const za = transformSeries(a, "z", 30);
  const price = [100];
  for (let i = 1; i < n; i++) {
    const zone = za[i - 1]! < -1 && b[i - 1]! >= 0;
    const r = (zone ? (o.drift ?? 0) : 0) + (o.noise ?? 0.02) * gauss(rng);
    price.push(price[i - 1]! * (1 + r));
  }
  return { asset: "SYN", t, price, metrics: { "syn:a": a, "syn:b": b, "syn:c": c, "syn:d": d } };
}

/** Jaccard of two in-zone day sets. */
export function zoneJaccard(a: ArrayLike<boolean | number>, b: ArrayLike<boolean | number>): number {
  let both = 0;
  let any = 0;
  for (let i = 0; i < a.length; i++) {
    both += +(!!a[i] && !!b[i]);
    any += +(!!a[i] || !!b[i]);
  }
  return any ? both / any : 1;
}

/** Two zones of a must overlap at least this much (Jaccard) to count as the same zone. */
export const SAME_ZONE_JACCARD = 0.7;

/**
 * Is this the planted zone, z(a, 30) < −1 AND b ≥ 0? The a condition is
 * z(30) < −1 ± 0.4, or a's 30-day percentile rank read as the same zone:
 * pctile(30) < x whose in-zone days on `data` overlap z(30) < −1 with
 * Jaccard ≥ SAME_ZONE_JACCARD. b (iid normal, so its z is b rescaled) is raw
 * or z ≥ 0 ± 0.35.
 */
export function isPlanted(r: { rule: { conditions: Array<{ feature: string; op: string; threshold: number }> } }, data: LabDataset): boolean {
  const a = r.rule.conditions.find((c) => c.feature === "syn:a|z|30" || c.feature === "syn:a|pctile|30");
  const b = r.rule.conditions.find((c) => /^syn:b\|(raw|z)\|/.test(c.feature));
  if (!a || a.op !== "<" || !b || b.op !== ">=" || Math.abs(b.threshold) > 0.35) return false;
  if (a.feature === "syn:a|z|30") return Math.abs(a.threshold + 1) <= 0.4;
  return pctileOverlap(data, a.threshold) >= SAME_ZONE_JACCARD;
}

/** Jaccard of a's in-zone days under pctile(30) < x and under the planted z(30) < −1. */
export function pctileOverlap(data: LabDataset, x: number): number {
  const z = transformSeries(data.metrics["syn:a"]!, "z", 30);
  const p = transformSeries(data.metrics["syn:a"]!, "pctile", 30);
  return zoneJaccard(
    Array.from(z, (v) => v < -1),
    Array.from(p, (v) => v < x),
  );
}
