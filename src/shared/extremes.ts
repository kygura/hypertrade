import { z } from "zod";
import { SideSchema } from "./intel.js";

// Extremes contracts (docs/EXTREMES.md): rare, tape-first events a detector finds in a coin's own 15-min history
// (price dislocation, open-interest flush, crowded positioning), the wake message a research session receives, and
// the verdict that session sends back. The verdict is LLM output, so it is parsed here.

export const EXTREME_KINDS = ["price_dislocation", "oi_flush", "crowded_asymmetry"] as const;
const ExtremeKindSchema = z.enum(EXTREME_KINDS);
export type ExtremeKind = z.infer<typeof ExtremeKindSchema>;

const EXTREME_WINDOWS = ["1h", "4h", "24h", "72h"] as const;
const ExtremeWindowSchema = z.enum(EXTREME_WINDOWS);
export type ExtremeWindow = z.infer<typeof ExtremeWindowSchema>;

/** One detector hit. Facts only: `side` is the side the imbalance favours on a fade, not a recommendation. */
export const ExtremeEventSchema = z.strictObject({
  /** Dedupe and cooldown key: `${kind}|${coin}|${side}`. */
  key: z.string().min(1),
  kind: ExtremeKindSchema,
  coin: z.string().min(1),
  side: SideSchema,
  /** ISO time of the bar the detector fired on. */
  ts: z.string(),
  /** The window the strongest reading was taken over. */
  window: ExtremeWindowSchema,
  /** Mark at `ts`. */
  mark: z.number().positive(),
  /** Strength in the detector's own sigma units (>= its threshold); orders events, never gates anything else. */
  severity: z.number().finite(),
  /** The numbers the detector read, by name (returns as fractions, funding as hourly rate unless the name says apr). */
  facts: z.record(z.string(), z.number().finite().nullable()),
  /** One line built by code from `facts`. */
  line: z.string().min(1),
});
export type ExtremeEvent = z.infer<typeof ExtremeEventSchema>;

export const EXTREME_STANCES = ["take", "watch", "pass"] as const;

/** What the research session answers for one event. `take` needs a direction and a kill level; code prices the rest. */
export const ExtremeVerdictSchema = z
  .strictObject({
    key: z.string().min(1),
    stance: z.enum(EXTREME_STANCES),
    direction: SideSchema.optional(),
    /** Mark at which the idea is wrong. */
    killPx: z.number().positive().optional(),
    /** Why the event exists, one or two sentences, with the dated cause when there is one. */
    cause: z.string().min(1).max(600),
    sources: z.array(z.string().url()).max(5).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.stance !== "take") return;
    if (!v.direction) ctx.addIssue({ code: "custom", path: ["direction"], message: "take needs a direction" });
    if (v.killPx == null) ctx.addIssue({ code: "custom", path: ["killPx"], message: "take needs a kill level" });
  });
export type ExtremeVerdict = z.infer<typeof ExtremeVerdictSchema>;

/** A stored event with what happened to it. */
export const ExtremeRecordSchema = z.strictObject({
  event: ExtremeEventSchema,
  /** How the event left the process: a research session was woken, the facts were pushed directly, or nothing went out. */
  delivery: z.enum(["woken", "pushed", "none"]),
  verdict: ExtremeVerdictSchema.nullable(),
  verdictAt: z.string().nullable(),
  /** Live mark stamped when the verdict was stored (every stance; null when no fresh mark was available, and on rows before 028). */
  verdictMark: z.number().positive().nullable(),
  /** The platform opportunity a `take` became (approvable on the coin page); null otherwise or when its creation failed. */
  opportunityId: z.string().uuid().nullable(),
});
export type ExtremeRecord = z.infer<typeof ExtremeRecordSchema>;

/**
 * A `take` becomes a platform Opportunity scored by the event's severity (sigmas of the detector, not the scanner's
 * materiality score), so it carries its own scoreVersion. Anything that compares or aggregates scores keys off this.
 */
export const EXTREMES_SCORE_VERSION = "extremes-1";
/** A platform opportunity created from an extremes `take` (its own ready TTL, no scanner rescan or Ready push). */
export const isExtremesOpportunity = (o: { scoreVersion: string; setupKind: string }) =>
  o.scoreVersion === EXTREMES_SCORE_VERSION && (EXTREME_KINDS as readonly string[]).includes(o.setupKind);

// ─── Thresholds and calibration (src/server/extremes/detect.ts, calibrate.ts; docs/EXTREMES.md § Calibration pipeline) ───

const Cut = z.number().finite().nonnegative();
const Frac = z.number().finite().min(0).max(1);
/** The detectors' cuts. A stored calibration row is a trust boundary: its thresholds are parsed with this on the way out. */
export const ExtremeThresholdsSchema = z.strictObject({
  price: z.strictObject({
    /** |own z| at least, per window: short windows have fatter tails, so one cut would fire almost only on 4 h. */
    z: z.strictObject({ "4h": Cut, "24h": Cut, "72h": Cut }),
    /** |BTC-residual z| at least, same sign as the move (non-BTC coins), per window. */
    zResid: z.strictObject({ "4h": Cut, "24h": Cut, "72h": Cut }),
    /** |return| at least, per window (fraction): a quiet coin's big z is not an extreme price. */
    minMove: z.strictObject({ "4h": Cut, "24h": Cut, "72h": Cut }),
  }),
  oiFlush: z.strictObject({
    /** OI contracts change z at most −this, per window (as price: shorter windows have fatter tails). */
    z: z.strictObject({ "1h": Cut, "4h": Cut, "24h": Cut }),
    /** OI contracts drop at least, per window (fraction). */
    minDrop: z.strictObject({ "1h": Frac, "4h": Frac, "24h": Frac }),
    /** |price z| over the same window at least. */
    zPrice: Cut,
  }),
  crowded: z.strictObject({
    /** Funding level robust z at least (sign of the crowd). */
    zFunding: Cut,
    /** Funding percentile at least (longs crowded) or at most 1 − this (shorts crowded). */
    pctile: Frac,
    /** |funding apr %| at least. */
    minAprPct: Cut,
    /** OI contracts percentile over the lookback at least. */
    oiPctile: Frac,
    /** 24 h price z in the crowd's direction at most (flat or against it). */
    maxFollowZ: z.number().finite(),
  }),
});
export type ExtremeThresholds = z.infer<typeof ExtremeThresholdsSchema>;

const Rate = z.number().finite().nonnegative().nullable();
const Stat = z.strictObject({ n: z.number().int().nonnegative(), hitRate: z.number().finite().nullable(), median: z.number().finite().nullable() });
/** Forward fade-side returns of a kind's events, for information only: never part of the calibration objective. */
const ForwardSchema = z.array(z.strictObject({ horizon: z.string(), abs: Stat }));
export const CALIBRATION_UNCHANGED = ["in_band", "not_evaluable", "clamped"] as const;
export const ExtremeCalibrationKindSchema = z.strictObject({
  kind: ExtremeKindSchema,
  evaluable: z.boolean(),
  reason: z.string().nullable(),
  /** The one parameter family the multiplier scales (detect.ts thresholds path names). */
  knob: z.string(),
  eventsBefore: z.number().int().nonnegative(),
  /** Events a week with each coin's contribution capped (calibrate.ts perCoinCap); null when not evaluable. */
  rateBefore: Rate,
  /** Events of the busiest coin before (the cap's reason to exist). */
  topCoinBefore: z.strictObject({ coin: z.string(), events: z.number().int().nonnegative() }).nullable(),
  /** Cumulative multiplier of the code defaults' knob, before and after this run. */
  multiplierBefore: z.number().finite().nonnegative(),
  multiplier: z.number().finite().nonnegative(),
  eventsAfter: z.number().int().nonnegative(),
  rateAfter: Rate,
  changed: z.boolean(),
  /** Why the kind kept its thresholds; null when changed. */
  unchanged: z.enum(CALIBRATION_UNCHANGED).nullable(),
  /** A changed multiplier stopped at the per-run step or the cumulative clamp. */
  limited: z.enum(["step", "clamp"]).nullable(),
  forwardBefore: ForwardSchema,
  forwardAfter: ForwardSchema,
});
export type ExtremeCalibrationKind = z.infer<typeof ExtremeCalibrationKindSchema>;
export const ExtremeCalibrationResultSchema = z.strictObject({
  /** First and last replayed step (ISO); null when nothing was replayed. */
  from: z.string().nullable(),
  to: z.string().nullable(),
  weeks: z.number().finite().nonnegative(),
  /** Days of dense history ending at the last step (calibrate.ts denseDays). */
  denseDays: z.number().int().nonnegative(),
  coins: z.array(z.string()),
  target: z.strictObject({ perWeek: z.number().positive(), min: z.number().nonnegative(), max: z.number().positive() }),
  /** True for a `--reset` row: the code defaults, applied as is. */
  reset: z.boolean(),
  kinds: z.array(ExtremeCalibrationKindSchema),
  thresholds: ExtremeThresholdsSchema,
});
export type ExtremeCalibrationResult = z.infer<typeof ExtremeCalibrationResultSchema>;

/** A row to store (029 extreme_calibrations). */
export const NewExtremeCalibrationSchema = z.strictObject({
  ranAt: z.string().datetime(),
  from: z.string().datetime().nullable(),
  to: z.string().datetime().nullable(),
  coins: z.array(z.string().min(1)),
  result: ExtremeCalibrationResultSchema,
  thresholds: ExtremeThresholdsSchema,
  applied: z.boolean(),
});
export type NewExtremeCalibration = z.infer<typeof NewExtremeCalibrationSchema>;
/** A stored row as read back: result and thresholds unparsed (readers parse them; a bad row falls back to the defaults). */
export type StoredExtremeCalibration = Omit<NewExtremeCalibration, "result" | "thresholds"> & { id: number; result: unknown; thresholds: unknown };

// ─── Grading (src/server/extremes/grade.ts; GET /api/extremes) ───

export const EXTREME_GRADE_HORIZONS = ["4h", "24h", "72h"] as const;
const Ret = z.number().finite().nullable();
export const ExtremeGradeSchema = z.strictObject({
  /** verdict.direction for a take, the event's fade side otherwise. */
  direction: SideSchema,
  /** verdictMark when stamped, else the event mark. */
  entryPx: z.number().positive(),
  entryBasis: z.enum(["verdict", "event"]),
  /** Signed return in `direction` from entryPx; null before the horizon or with no stored mark near it. `stopped` caps a take at killPx once crossed (equal to raw otherwise). */
  horizons: z.array(z.strictObject({ horizon: z.enum(EXTREME_GRADE_HORIZONS), raw: Ret, stopped: Ret })),
  /** Takes only: the mark crossed killPx between the verdict and now (or the last horizon); null for watch/pass. */
  killHit: z.boolean().nullable(),
});
export type ExtremeGrade = z.infer<typeof ExtremeGradeSchema>;
