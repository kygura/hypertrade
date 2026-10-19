import { z } from "zod";
import type { Side } from "../../shared/intel.js";
import type { FeatureVector, LiquidityTier } from "../../shared/platform.js";
import { fin } from "../intel/util.js";

// Platform setups as data (TASKS PS-B1, FEATURES.md § 1): each setup is a
// SetupSchema over the scanner's feature vector, compiled once into the
// predicate the scanner calls. Port of perpsignal T9 (schema.ts / compile.ts),
// cut to what the intraday setups need. Not the Lab Rule: that has only
// `<` / `>=` over daily feature columns, a fixed direction and fixed
// thresholds, so it cannot say |x| < t, x ≤ t, "same sign", a direction
// taken from a feature's sign, or a per-liquidity-tier threshold.

export type Thresholds = {
  /** |fundingZ24h| a crowded setup needs. */
  fundingZ: number;
  /** oiChg1hZ build (or drop) needed. */
  oiZ: number;
  /** |ret15mZ| for a move. */
  retZ: number;
  rvExpansion: number;
  volZ: number;
  /** |ret15mZ| below this counts as price flat. */
  flatZ: number;
};
/** Thinner books move on less, so lower tiers need a stronger signal. */
export const DEFAULT_THRESHOLDS: Record<LiquidityTier, Thresholds> = {
  1: { fundingZ: 2, oiZ: 1, retZ: 2, rvExpansion: 1.8, volZ: 1.5, flatZ: 1 },
  2: { fundingZ: 2.25, oiZ: 1.25, retZ: 2.25, rvExpansion: 2, volZ: 1.75, flatZ: 1 },
  3: { fundingZ: 2.5, oiZ: 1.5, retZ: 2.5, rvExpansion: 2.25, volZ: 2, flatZ: 1 },
};

export type Setup = { setupKind: string; direction: Side; stopPx: number; targetPx: number; invalidationPx: number; tags: string[] };

/** Scanner features (computeFeatures keys) plus `funding`, the raw hourly rate from the inputs. */
export const REFS = ["ret15mZ", "priceAccelZ", "oiChg1hZ", "fundingZ24h", "fundingPctile24h", "volRatio1hZ", "rvExpansion", "liqPressure", "spreadBps", "depthUsd", "funding"] as const;
const THRESHOLD_KEYS = ["fundingZ", "oiZ", "retZ", "rvExpansion", "volZ", "flatZ"] as const satisfies readonly (keyof Thresholds)[];
const Ref = z.enum(REFS);
const Tags = z.array(z.string().min(1));

/** A limit is a number or the tier's threshold × k (thinner books need a stronger signal). */
const LimitZ = z.union([z.number().finite(), z.strictObject({ t: z.enum(THRESHOLD_KEYS), k: z.number().finite().optional() })]);
/** An unknown (null) feature fails every condition. `abs` compares |f|. `level: true` marks a price-level condition (close vs MA), which never counts as a near-miss. */
const CondZ = z.union([
  z.strictObject({ f: Ref, op: z.enum(["<", "<=", ">", ">="]), to: LimitZ, abs: z.literal(true).optional(), level: z.literal(true).optional() }),
  z.strictObject({ sameSign: z.tuple([Ref, Ref]) }),
]);

export const SetupSchemaZ = z
  .strictObject({
    kind: z.string().regex(/^[a-z0-9_]+$/),
    /** Fixed side, or the sign of a feature (> 0 long, else short). */
    direction: z.union([z.enum(["long", "short"]), z.strictObject({ signOf: Ref })]),
    when: z.array(CondZ).min(1),
    /** Tags per side the setup can take. */
    tags: z.strictObject({ long: Tags.optional(), short: Tags.optional() }),
    /** Stop and target in σ units, σ = mark × sigma1h. invalidationPx = stopPx. */
    stop: z.number().positive(),
    target: z.number().positive(),
  })
  .superRefine((s, ctx) => {
    const sides: Side[] = typeof s.direction === "string" ? [s.direction] : ["long", "short"];
    for (const side of sides) if (!s.tags[side]) ctx.addIssue({ code: "custom", path: ["tags", side], message: `${s.kind} can go ${side} but has no ${side} tags` });
  });
export type SetupSchema = z.infer<typeof SetupSchemaZ>;
type Cond = z.infer<typeof CondZ>;

/**
 * The four intraday setups (order = output order):
 *  crowded_long              short  flows crowded_long: funding z hot and > 0, OI building, price flat
 *  negative_funding_squeeze  long   flows negative_funding_oi_build: funding < 0 and cold, OI building, price not falling
 *  deleveraging_washout      long   flows deleveraging: OI dropping hard on a dump with vol expanding (long flush -> bounce)
 *  vol_expansion_breakout    by sign of the move; no flows detector: vol expanding, move and acceleration agree, volume confirms
 */
export const SETUPS: SetupSchema[] = z.array(SetupSchemaZ).parse([
  {
    kind: "crowded_long",
    direction: "short",
    when: [
      { f: "fundingZ24h", op: ">=", to: { t: "fundingZ" } },
      { f: "funding", op: ">", to: 0 },
      { f: "oiChg1hZ", op: ">=", to: { t: "oiZ" } },
      { f: "ret15mZ", op: "<", to: { t: "flatZ" }, abs: true },
    ],
    tags: { short: ["crowded_long", "funding_hot", "oi_building"] },
    stop: 1.5,
    target: 2,
  },
  {
    kind: "negative_funding_squeeze",
    direction: "long",
    when: [
      { f: "fundingZ24h", op: "<=", to: { t: "fundingZ", k: -0.5 } },
      { f: "funding", op: "<", to: 0 },
      { f: "oiChg1hZ", op: ">=", to: { t: "oiZ" } },
      { f: "ret15mZ", op: ">=", to: -0.5 },
    ],
    tags: { long: ["negative_funding", "oi_building", "squeeze_fuel"] },
    stop: 1.5,
    target: 3,
  },
  {
    kind: "deleveraging_washout",
    direction: "long",
    when: [
      { f: "oiChg1hZ", op: "<=", to: { t: "oiZ", k: -1 } },
      { f: "ret15mZ", op: "<=", to: { t: "retZ", k: -1 } },
      { f: "rvExpansion", op: ">=", to: { t: "rvExpansion" } },
    ],
    tags: { long: ["deleveraging", "long_flush", "vol_expansion"] },
    stop: 1,
    target: 1.5,
  },
  {
    kind: "vol_expansion_breakout",
    direction: { signOf: "ret15mZ" },
    when: [
      { f: "rvExpansion", op: ">=", to: { t: "rvExpansion" } },
      { f: "ret15mZ", op: ">=", to: { t: "retZ" }, abs: true },
      { sameSign: ["priceAccelZ", "ret15mZ"] },
      { f: "volRatio1hZ", op: ">=", to: { t: "volZ" } },
    ],
    tags: { long: ["vol_expansion", "volume_confirm", "breakout_up"], short: ["vol_expansion", "volume_confirm", "breakout_down"] },
    stop: 1,
    target: 2,
  },
]);

type Env = { fv: FeatureVector; T: Thresholds };
const val = (f: string, e: Env): number | null => (f === "funding" ? fin(e.fv.inputs.funding as number | null) : (e.fv.features[f] ?? null));

export type CondResult = { pass: boolean; value: number | null; limit: number | null; relDistance: number | null; numeric: boolean; priceLevel: boolean };

/** The one place a condition is evaluated: the predicate reads `pass`, the near-miss reads the rest. */
function evalCond(c: Cond, e: Env): CondResult {
  if ("sameSign" in c) {
    const [a, b] = c.sameSign.map((f) => val(f, e));
    return { pass: a != null && b != null && Math.sign(a) === Math.sign(b), value: null, limit: null, relDistance: null, numeric: false, priceLevel: false };
  }
  const raw = val(c.f, e);
  const to = typeof c.to === "number" ? c.to : e.T[c.to.t] * (c.to.k ?? 1);
  const priceLevel = c.level === true;
  if (raw == null) return { pass: false, value: null, limit: to, relDistance: null, numeric: true, priceLevel };
  const x = c.abs ? Math.abs(raw) : raw;
  const pass = c.op === "<" ? x < to : c.op === "<=" ? x <= to : c.op === ">" ? x > to : x >= to;
  // A zero limit has no relative scale: only an exact hit is "near".
  const relDistance = to === 0 ? (x === 0 ? 0 : Infinity) : Math.abs(x - to) / Math.abs(to);
  return { pass, value: x, limit: to, relDistance, numeric: true, priceLevel };
}
const test = (c: Cond, e: Env): boolean => evalCond(c, e).pass;

/** Mark and σ the levels are built from; null = the bar is unusable and nothing fires (the health gate). */
const levels = (fv: FeatureVector) => {
  const mark = fin(fv.inputs.mark as number | null);
  const sigma = fin(fv.inputs.sigma1h as number | null);
  return mark == null || !(mark > 0) || sigma == null || !(sigma > 0) ? null : { mark, sigma };
};

/** Per-condition detail of one setup, in `when` order, over the same conditions compile() runs. */
export function explain(s: SetupSchema, fv: FeatureVector, tier: LiquidityTier, thresholds = DEFAULT_THRESHOLDS): CondResult[] {
  const e: Env = { fv, T: thresholds[tier] };
  return s.when.map((c) => evalCond(c, e));
}

export type NearMiss = { coin: string; setupKind: string; cond: number; value: number; limit: number; relDistance: number };
const NEAR = 0.1;

/** FEATURES.md near-miss: healthy bar, exactly one condition of a setup failed, numeric, not a price level, within 10% of its limit; the closest wins. */
export function nearMiss(coin: string, fv: FeatureVector, tier: LiquidityTier, thresholds = DEFAULT_THRESHOLDS, schemas: SetupSchema[] = SETUPS): NearMiss | null {
  if (!levels(fv)) return null;
  let best: NearMiss | null = null;
  for (const s of schemas) {
    const rs = explain(s, fv, tier, thresholds);
    const i = rs.findIndex((r) => !r.pass);
    const r = rs[i];
    if (!r || rs.some((x, j) => j > i && !x.pass)) continue;
    if (!r.numeric || r.priceLevel || r.value == null || r.limit == null || r.relDistance == null || !(r.relDistance <= NEAR)) continue;
    if (!best || r.relDistance < best.relDistance) best = { coin, setupKind: s.kind, cond: i, value: r.value, limit: r.limit, relDistance: r.relDistance };
  }
  return best;
}

/** One predicate for all setups: feature vector and tier in, the setups that fire (with levels) out. */
export function compile(schemas: SetupSchema[]): (fv: FeatureVector, tier: LiquidityTier, thresholds?: Record<LiquidityTier, Thresholds>) => Setup[] {
  return (fv, tier, thresholds = DEFAULT_THRESHOLDS) => {
    const lv = levels(fv);
    if (!lv) return [];
    const { mark, sigma } = lv;
    const e: Env = { fv, T: thresholds[tier] };
    return schemas.flatMap((s) => {
      if (!s.when.every((c) => test(c, e))) return [];
      let direction: Side;
      if (typeof s.direction === "string") direction = s.direction;
      else {
        const v = val(s.direction.signOf, e);
        if (v == null) return [];
        direction = v > 0 ? "long" : "short";
      }
      const d = direction === "long" ? 1 : -1;
      const stopPx = mark - d * s.stop * sigma * mark;
      const targetPx = mark + d * s.target * sigma * mark;
      return stopPx > 0 && targetPx > 0 ? [{ setupKind: s.kind, direction, stopPx, targetPx, invalidationPx: stopPx, tags: [...s.tags[direction]!] }] : [];
    });
  };
}

/** The scanner's setup predicate. */
export const setupsFor = compile(SETUPS);
