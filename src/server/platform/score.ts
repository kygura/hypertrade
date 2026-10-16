import type { FeatureVector } from "../../shared/platform.js";
import { materiality, type SignalSource } from "../intel/diff.js";
import { round } from "../intel/util.js";
import type { Setup } from "./features.js";

// Opportunity score (SPEC.md § Platform P0.10, P0.12). Pure and deterministic:
// the same stored feature vector reproduces the same number (the replay guarantee).
//   score = materiality(surprise, exposure, proximity, k)  (intel/diff.ts)
//   surprise  largest |z| among the z features
//   exposure  1: the scan is universe-wide, there is no per-asset position weight
//   proximity 1: no stop distance to a held position
//   k         independent signal classes showing at once (confluence): snapshot
//             (price/OI z), flow (funding or volume z), regime (quadrant is not "range")
// The setup does not change the number today (kind, direction and levels are
// ticket data); it is a parameter so versions can weigh setups without a signature change.
// Bump SCORE_VERSION whenever any of this changes; the ledger stores it beside the score.

export const SCORE_VERSION = "score-v1";
/** |z| at which a feature counts as an active signal for confluence. */
const ACTIVE_Z = 1;
const Z_KEYS = ["ret15mZ", "priceAccelZ", "oiChg1hZ", "fundingZ7d", "volRatio1hZ"] as const;
const SNAPSHOT_KEYS = ["ret15mZ", "priceAccelZ", "oiChg1hZ"];
const FLOW_KEYS = ["fundingZ7d", "volRatio1hZ"];

export function scoreOpportunity(fv: FeatureVector, _setup?: Pick<Setup, "setupKind" | "direction">): number {
  const abs = (keys: readonly string[]) => Math.max(0, ...keys.map((k) => fv.features[k]).filter((z): z is number => z != null && Number.isFinite(z)).map(Math.abs));
  const active = new Set<SignalSource>();
  if (abs(SNAPSHOT_KEYS) >= ACTIVE_Z) active.add("snapshot");
  if (abs(FLOW_KEYS) >= ACTIVE_Z) active.add("flow");
  if (fv.inputs.regime != null && fv.inputs.regime !== "range") active.add("regime");
  const score = materiality({ surprise: abs(Z_KEYS), exposure: 1, proximity: 1 }, active.size);
  return Number.isFinite(score) ? round(score, 6) : 0;
}
