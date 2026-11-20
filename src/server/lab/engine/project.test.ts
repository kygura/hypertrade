import { describe, expect, test } from "bun:test";
import { MIN_ANALOG_DAYS, project } from "./project.js";
import { gauss, mulberry32 } from "./rng.js";

/** 30-day stretches alternating between an "up" state (+0.5%/day) and a "down" state (−0.5%/day), small noise. */
function twoState(days: number, seed = 1) {
  const rng = mulberry32(seed);
  const pr = [0];
  const state: (string | null)[] = [];
  for (let i = 0; i < days; i++) state.push(Math.floor(i / 30) % 2 ? "down" : "up");
  // pr[i] follows the state at the close of day i − 1.
  for (let i = 1; i < days; i++) pr.push((state[i - 1] === "up" ? 0.005 : -0.005) + 0.002 * gauss(rng));
  return { pr, state };
}

describe("projection (docs/AUTORESEARCH.md)", () => {
  test("seeded, starts at 1, quantiles ordered, likelihoods sum to 1", () => {
    const { pr, state } = twoState(900);
    const a = project(pr, state, { horizonDays: 20, paths: 400, seed: 3 });
    expect(project(pr, state, { horizonDays: 20, paths: 400, seed: 3 })).toEqual(a);
    expect(project(pr, state, { horizonDays: 20, paths: 400, seed: 4 })).not.toEqual(a);
    expect(a.fan).toHaveLength(21);
    expect(a.fan[0]).toEqual({ day: 0, p10: 1, p25: 1, p50: 1, p75: 1, p90: 1 });
    for (const f of a.fan) expect(f.p10 <= f.p25 && f.p25 <= f.p50 && f.p50 <= f.p75 && f.p75 <= f.p90).toBe(true);
    expect(a.timelines.reduce((s, t) => s + t.likelihood, 0)).toBeCloseTo(1, 12);
    for (const t of a.timelines) {
      if (!t.likelihood) continue;
      expect(t.path).toHaveLength(21);
      expect(t.path.at(-1)! - 1).toBeCloseTo(t.medianReturn!, 12);
    }
  });

  test("paths start from past days in today's state: an up day projects up, a down day down", () => {
    const up = twoState(915); // last day index 914 → stretch 30 → "up"
    const down = twoState(885);
    expect(up.state.at(-1)).toBe("up");
    expect(down.state.at(-1)).toBe("down");
    const a = project(up.pr, up.state, { horizonDays: 10, paths: 500, blockDays: 5 });
    const b = project(down.pr, down.state, { horizonDays: 10, paths: 500, blockDays: 5 });
    expect(a.conditioned && b.conditioned).toBe(true);
    expect(a.pUp).toBeGreaterThan(0.75);
    expect(b.pUp).toBeLessThan(0.25);
    expect(a.medianReturn).toBeGreaterThan(b.medianReturn);
  });

  test("too few past days in today's state: drawn from all history and flagged", () => {
    const { pr, state } = twoState(600);
    state[state.length - 1] = "rare";
    const p = project(pr, state, { horizonDays: 10, paths: 200 });
    expect(p).toMatchObject({ state: "rare", conditioned: false });
    expect(p.analogDays).toBeLessThan(MIN_ANALOG_DAYS);
    expect(() => project(pr.slice(0, 50), state.slice(0, 50), { horizonDays: 10 })).toThrow("at least 120 days");
  });
});
