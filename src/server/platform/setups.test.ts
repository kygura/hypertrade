import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FeatureVector, LiquidityTier } from "../../shared/platform.js";
import { mulberry32 } from "../lab/engine/rng.js";
import { explain, nearMiss, setupsFor, SETUPS, SetupSchemaZ } from "./setups.js";

// Parity (PS-B1, as perpsignal T9): the compiled schemas reproduce the
// pre-schema hardcoded setupsFor on every synthetic bar. Values sit on and
// around each tier's thresholds so every condition flips both ways.
// The fixture is that hardcoded output, frozen: a digest plus per-setup counts.

const FIXTURE = new URL("./fixtures/setups-parity.json", import.meta.url);
const N = 20_000;
const V = {
  fundingZ24h: [null, -3, -1.25, -1.125, -1, -0.9, 0, 1.9, 2, 2.1, 2.25, 2.5, 3],
  funding: [null, -1e-4, 0, 1e-4],
  oiChg1hZ: [null, -2, -1.5, -1.25, -1, -0.9, 0, 0.9, 1, 1.25, 1.5, 2],
  ret15mZ: [null, -3, -2.5, -2.25, -2, -1.9, -1, -0.6, -0.5, -0.4, -0, 0, 0.5, 0.99, 1, 1.9, 2, 2.25, 2.5, 3],
  rvExpansion: [null, 1.7, 1.8, 2, 2.25, 3],
  priceAccelZ: [null, -1, 0, 1],
  volRatio1hZ: [null, 1.4, 1.5, 1.75, 2, 3],
  mark: [100, 100, 100, 0.5, 0, null],
  sigma1h: [0.01, 0.01, 0.01, 0.6, 0, null],
} as const;

function cases(): Array<{ fv: FeatureVector; tier: LiquidityTier }> {
  const rng = mulberry32(9);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
  return Array.from({ length: N }, () => {
    const { funding, mark, sigma1h, ...features } = Object.fromEntries(Object.entries(V).map(([k, xs]) => [k, pick(xs)])) as Record<keyof typeof V, number | null>;
    return { fv: { features, inputs: { funding, mark, sigma1h } }, tier: pick([1, 2, 3] as const) };
  });
}

function summary(outs: unknown[][]) {
  const counts: Record<string, number> = {};
  for (const o of outs) for (const s of o as Array<{ setupKind: string; direction: string }>) counts[`${s.setupKind}:${s.direction}`] = (counts[`${s.setupKind}:${s.direction}`] ?? 0) + 1;
  return { n: outs.length, counts, sha256: createHash("sha256").update(JSON.stringify(outs)).digest("hex") };
}

describe("setup schemas", () => {
  const cs = cases();

  test("parity: compiled output matches the frozen hardcoded fixture, every setup fires and stays quiet", () => {
    const frozen = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const got = summary(cs.map((c) => setupsFor(c.fv, c.tier)));
    expect(got).toEqual(frozen);
    for (const k of ["crowded_long:short", "negative_funding_squeeze:long", "deleveraging_washout:long", "vol_expansion_breakout:long", "vol_expansion_breakout:short"]) {
      expect(got.counts[k]).toBeGreaterThan(20);
      expect(got.counts[k]).toBeLessThan(N / 2);
    }
  });

  test("schema rejects unknown features and a side without tags", () => {
    const ok = SETUPS[0]!;
    expect(SetupSchemaZ.safeParse({ ...ok, when: [{ f: "nope", op: ">", to: 1 }] }).success).toBe(false);
    expect(SetupSchemaZ.safeParse({ ...ok, direction: "long" }).success).toBe(false);
    expect(SetupSchemaZ.safeParse(ok).success).toBe(true);
  });
});

describe("explain and nearMiss", () => {
  const cs = cases();
  const T = { fundingZ: 2, oiZ: 1, retZ: 2, rvExpansion: 1.8, volZ: 1.5, flatZ: 1 };
  const mk = (features: Record<string, number | null>, funding: number | null = 1e-4): FeatureVector => ({ features, inputs: { funding, mark: 100, sigma1h: 0.01 } });
  // crowded_long at tier 1: fundingZ >= 2, funding > 0, oiZ >= 1, |ret| < 1.
  const crowded = { fundingZ24h: 2.5, oiChg1hZ: 1.5, ret15mZ: 0 };

  test("explain agrees with compile on the parity inputs, per setup", () => {
    for (const c of cs.slice(0, 5000)) {
      const fired = new Set(setupsFor(c.fv, c.tier).map((s) => s.setupKind));
      for (const s of SETUPS) {
        const allPass = explain(s, c.fv, c.tier).every((r) => r.pass);
        const dirOk = typeof s.direction === "string" || c.fv.features[s.direction.signOf] != null;
        const levelsOk = Number(c.fv.inputs.mark) > 0 && Number(c.fv.inputs.sigma1h) > 0;
        if (levelsOk && dirOk && fired.has(s.kind)) expect(allPass).toBe(true);
        if (!allPass) expect(fired.has(s.kind)).toBe(false);
      }
    }
  });

  test("one failing numeric condition within 10% is a near-miss; the limit and distance come from the schema", () => {
    const nm = nearMiss("X", mk({ ...crowded, oiChg1hZ: 0.95 }), 1)!;
    expect(nm).toMatchObject({ coin: "X", setupKind: "crowded_long", limit: T.oiZ, value: 0.95 });
    expect(nm.relDistance).toBeCloseTo(0.05);
  });

  test("10% boundary: inclusive at 0.9 of the limit, out at 0.89", () => {
    expect(nearMiss("X", mk({ ...crowded, oiChg1hZ: 0.9 }), 1)).not.toBeNull();
    expect(nearMiss("X", mk({ ...crowded, oiChg1hZ: 0.89 }), 1)).toBeNull();
  });

  test("two failing conditions, or a passing setup, is null", () => {
    expect(nearMiss("X", mk({ ...crowded, oiChg1hZ: 0.95, fundingZ24h: 1.9 }), 1)).toBeNull();
    expect(nearMiss("X", mk(crowded), 1)).toBeNull();
  });

  test("a bad bar (no mark/sigma) or an unknown feature is never a near-miss", () => {
    expect(nearMiss("X", { features: { ...crowded, oiChg1hZ: 0.95 }, inputs: { funding: 1e-4, mark: null, sigma1h: null } }, 1)).toBeNull();
    expect(nearMiss("X", mk({ ...crowded, oiChg1hZ: null }), 1)).toBeNull();
  });

  test("a price-level condition never counts", () => {
    const lvl = SetupSchemaZ.parse({ ...SETUPS[0]!, kind: "lvl", when: [{ f: "ret15mZ", op: ">=", to: 1, level: true }] });
    expect(nearMiss("X", mk({ ret15mZ: 0.95 }), 1, undefined, [lvl])).toBeNull();
    expect(nearMiss("X", mk({ ret15mZ: 0.95 }), 1, undefined, [{ ...lvl, when: [{ f: "ret15mZ", op: ">=", to: 1 }] }])).not.toBeNull();
  });

  test("the closest setup wins", () => {
    const far = SetupSchemaZ.parse({ ...SETUPS[0]!, kind: "far", when: [{ f: "ret15mZ", op: ">=", to: 1 }] });
    const near = SetupSchemaZ.parse({ ...SETUPS[0]!, kind: "near", when: [{ f: "ret15mZ", op: ">=", to: 1 }] });
    const fv = mk({ ret15mZ: 0.95 });
    expect(nearMiss("X", fv, 1, undefined, [far, { ...near, when: [{ f: "ret15mZ", op: ">=", to: 0.98 }] }])?.setupKind).toBe("near");
  });
});
