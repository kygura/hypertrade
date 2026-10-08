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
