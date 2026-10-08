// Seeded PRNG (mulberry32). One generator drives a search so the same seed
// and data give the same rules; Math.random never appears in the engine.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi]. */
export function randInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Standard normal via Box-Muller. */
export function gauss(rng: Rng): number {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** A child generator seeded from the parent, so sub-tasks do not share a stream. */
export function fork(rng: Rng): Rng {
  return mulberry32(Math.floor(rng() * 4294967296));
}
