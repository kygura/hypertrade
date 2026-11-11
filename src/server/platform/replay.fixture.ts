// Test fixture for the replay parity test (replay.test.ts): a deterministic 15-min market of six coins over three
// days with three scripted events on top of seeded noise. Values are what HL's metaAndAssetCtxs would carry per tick
// (mark, openInterest in coins, hourly funding, 24 h notional); oiUsd = openInterest × mark, as the scanner computes it.

export const STEP = 15 * 60_000;
export const T0 = Date.UTC(2026, 9, 5, 0);
export const STEPS = 3 * 96;

export type Tick = { coin: string; ts: number; mark: number; openInterest: number; funding: number; dayNtlVlm: number };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Scripted events: BRK breaks out up three times (volume confirms), WASH flushes on falling OI, CROWD gets hot funding on building OI with price flat. */
export function fixtureTicks(): Tick[] {
  const out: Tick[] = [];
  const coins: Array<[string, number]> = [["BRK", 9e8], ["WASH", 8e8], ["CROWD", 7e8], ["F1", 1e8], ["F2", 9e7], ["F3", 8e7]];
  for (const [ci, [coin, vol]] of coins.entries()) {
    const r = rng(ci + 7);
    let mark = 100;
    let oi = 1e6;
    let vlm = vol;
    for (let i = 0; i < STEPS; i++) {
      let ret = 0.002 * r();
      let doi = 0.001 * r();
      let funding = 1e-5 + 1e-6 * r();
      let dv = 0.002 * r();
      // Three breakouts: the one at 212 falls inside the first idea's cooldown, the one at 250 is past it.
      for (const at of [200, 212, 250]) if (coin === "BRK" && i >= at && i <= at + 2) (ret = 0.01 + 0.005 * (i - at)), (dv = 0.05);
      if (coin === "WASH" && (i >= 150 && i <= 152)) (ret = -0.015 - 0.005 * (i - 150)), (doi = -0.04);
      if (coin === "CROWD" && i >= 230 && i <= 236) (funding = 6e-5), (doi = 0.01), (ret = 0.0002 * r());
      mark *= Math.exp(ret);
      oi *= Math.exp(doi);
      vlm *= Math.exp(dv);
      out.push({ coin, ts: T0 + i * STEP, mark, openInterest: oi, funding, dayNtlVlm: vlm });
    }
  }
  return out;
}
