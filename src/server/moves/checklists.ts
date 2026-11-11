import type { Attention, LiqProximity, Positioning, SetupCheck, SetupChecklist } from "../../shared/moves.js";
import { DEFINITIONS } from "../signals/definitions.js";
import {
  ENTER_CROWD_MAX, ENTER_MENTIONS_CHG_PCT, ENTER_NEWS_MIN, ENTER_NEWS_RATIO, ENTER_RESIDUAL_Z, FADE_CROWD_MIN, FADE_LIQ_SIGMAS, FADE_MIN_COVERAGE,
  FADE_NEWS72H_MIN, FADE_NEWS_RATIO_MAX,
} from "./constants.js";

// ENTER and FADE condition checklists (docs/SPEC.md § Moves). Pure. Condition checks, not forecasts: each check is
// met, not met, or null (not evaluable: missing input); `met` counts true, `of` counts the evaluable ones. The
// thresholds are starting points (constants.ts). FADE on a crowded long is tested in its daily version by
// `funding_fade`, on a crowded short by `negative_funding_build`; ENTER has no tested version (news is not a Lab metric).

/** Three-valued OR: true if any is true, false if all are false, else null. */
const or = (...xs: Array<boolean | null>): boolean | null => (xs.some((x) => x === true) ? true : xs.every((x) => x === false) ? false : null);
const and = (...xs: Array<boolean | null>): boolean | null => (xs.some((x) => x === false) ? false : xs.every((x) => x === true) ? true : null);
const cmp = (v: number | null | undefined, ok: (v: number) => boolean) => (v == null ? null : ok(v));

const definitionFor = (id: string) => (DEFINITIONS.some((d) => d.id === id) ? id : null);
export const FADE_LONG_DEFINITION = definitionFor("funding_fade");
export const FADE_SHORT_DEFINITION = definitionFor("negative_funding_build");

function list(kind: SetupChecklist["kind"], side: SetupChecklist["side"], checks: SetupCheck[], definitionId: string | null): SetupChecklist {
  return { kind, side, checks, met: checks.filter((c) => c.met === true).length, of: checks.filter((c) => c.met !== null).length, definitionId };
}

const round = (x: number | null, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

export interface ChecklistInput {
  /** The 24h attribution's residual (its sign picks the ENTER side) and z; null without one. */
  residual24h: { residualPct: number; residualZ: number | null } | null;
  positioning: Positioning;
  attention: Attention;
  liq: LiqProximity;
}

/** [ENTER, FADE]. */
export function checklists(row: ChecklistInput): SetupChecklist[] {
  const { positioning: p, attention: a, liq } = row;
  const crowdOf = (side: "long" | "short" | null) => (side == null || p.of === 0 ? null : side === "long" ? p.longMet : p.shortMet);
  const attentionUp = or(
    and(cmp(a.news24h, (v) => v >= ENTER_NEWS_MIN), cmp(a.newsRatio, (v) => v >= ENTER_NEWS_RATIO)),
    cmp(a.mentionsChg24hPct, (v) => v >= ENTER_MENTIONS_CHG_PCT),
  );

  // ENTER: side = the sign of the 24h residual.
  const r = row.residual24h;
  const enterSide = r == null || r.residualPct === 0 ? null : r.residualPct > 0 ? "long" : "short";
  const crowdEnter = crowdOf(enterSide);
  const enter = list("enter", enterSide, [
    {
      key: "attention_rising", label: "attention rising",
      value: a.news24h == null && a.mentionsChg24hPct == null ? null : `news ${a.news24h ?? "—"} · ratio ${round(a.newsRatio, 1) ?? "—"} · mentions ${a.mentionsChg24hPct == null ? "—" : `${round(a.mentionsChg24hPct, 0)}%`}`,
      threshold: `news24h ≥ ${ENTER_NEWS_MIN} and ratio ≥ ${ENTER_NEWS_RATIO}, or mentions Δ24h ≥ +${ENTER_MENTIONS_CHG_PCT}%`,
      met: attentionUp,
    },
    { key: "crowding_low", label: `crowding on the ${enterSide ?? "move's"} side`, value: crowdEnter, threshold: `≤ ${ENTER_CROWD_MAX} of 4`, met: cmp(crowdEnter, (v) => v <= ENTER_CROWD_MAX) },
    { key: "residual_z", label: "residual z (24h)", value: round(r?.residualZ ?? null), threshold: `|z| ≥ ${ENTER_RESIDUAL_Z}`, met: enterSide == null ? null : cmp(r?.residualZ, (v) => Math.abs(v) >= ENTER_RESIDUAL_Z) },
  ], null);

  // FADE: side = the side with crowding met ≥ FADE_CROWD_MIN (null if both or neither).
  const longC = p.longMet >= FADE_CROWD_MIN;
  const shortC = p.shortMet >= FADE_CROWD_MIN;
  const fadeSide = longC === shortC ? null : longC ? "long" : "short";
  const saturated = or(
    and(cmp(a.news72h, (v) => v >= FADE_NEWS72H_MIN), cmp(a.newsRatio, (v) => v < FADE_NEWS_RATIO_MAX)),
    a.sectorStage == null || a.sectorStage === "unknown" ? null : a.sectorStage === "crowded" || a.sectorStage === "fading",
  );
  const sigmas = fadeSide === "long" ? liq.longSigmas : fadeSide === "short" ? liq.shortSigmas : null;
  const liqUsable = liq.state.state !== "unavailable" && liq.coverageRatio != null;
  const liqMet = fadeSide == null || !liqUsable
    ? null
    : liq.coverageRatio! < FADE_MIN_COVERAGE ? false : sigmas != null && sigmas <= FADE_LIQ_SIGMAS;
  const fade = list("fade", fadeSide, [
    { key: "crowded", label: "crowding met", value: Math.max(p.longMet, p.shortMet), threshold: `≥ ${FADE_CROWD_MIN} of 4 on one side`, met: p.of === 0 ? null : fadeSide != null },
    {
      key: "attention_saturated", label: "attention saturated",
      value: a.news72h == null && a.sectorStage == null ? null : `news72h ${a.news72h ?? "—"} · ratio ${round(a.newsRatio, 1) ?? "—"} · stage ${a.sectorStage ?? "—"}`,
      threshold: `news72h ≥ ${FADE_NEWS72H_MIN} and ratio < ${FADE_NEWS_RATIO_MAX}, or sector stage crowded/fading`,
      met: saturated,
    },
    {
      key: "liq_near", label: `nearest ${fadeSide ?? "crowded-side"} liquidation cluster`,
      value: round(sigmas), threshold: `≤ ${FADE_LIQ_SIGMAS} σ24h, coverage ≥ ${FADE_MIN_COVERAGE * 100}%`, met: liqMet,
    },
  ], fadeSide === "long" ? FADE_LONG_DEFINITION : fadeSide === "short" ? FADE_SHORT_DEFINITION : null);
  return [enter, fade];
}
