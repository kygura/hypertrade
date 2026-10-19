import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { FeatureVector, LiquidityTier } from "../../shared/platform.js";
import { mulberry32 } from "../lab/engine/rng.js";
import { setupsFor as legacy } from "./features.js";
import { compiledSetups, SETUPS, SetupSchemaZ } from "./setups.js";

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

  test("parity: compiled == hardcoded on every bar and setup", () => {
    let same = 0;
    for (const c of cs) {
      const want = legacy(c.fv, c.tier);
      const got = compiledSetups(c.fv, c.tier);
      for (const kind of SETUPS.map((s) => s.kind)) {
        const w = want.find((s) => s.setupKind === kind) ?? null;
        if (JSON.stringify(got.find((s) => s.setupKind === kind) ?? null) === JSON.stringify(w)) same++;
      }
      expect(got).toEqual(want);
    }
    console.log(`setup parity ${same}/${cs.length * SETUPS.length}`);
    expect(same).toBe(cs.length * SETUPS.length);
    if (process.env.PARITY_RECORD) writeFileSync(FIXTURE, JSON.stringify(summary(cs.map((c) => legacy(c.fv, c.tier))), null, 2) + "\n");
  });

  test("parity: compiled output matches the frozen hardcoded fixture, every setup fires and stays quiet", () => {
    const frozen = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const got = summary(cs.map((c) => compiledSetups(c.fv, c.tier)));
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
