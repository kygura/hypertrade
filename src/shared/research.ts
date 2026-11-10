import { z } from "zod";
import { ASSET_PATTERN, RuleSchema } from "../server/lab/types.js";
import { RadarCallSchema } from "./radar.js";

// Research terminal contract (docs/RESEARCH.md B2): live signals from four sources in one shape, each with the
// Lab rule it maps to and the cached event study for that rule. Server and UI both import this file. The Lab
// Rule and the radar call are the Lab's and the radar's own schemas, not copies.

export const RESEARCH_SOURCES = ["novelty", "rule", "opportunity", "radar"] as const;
export type ResearchSource = (typeof RESEARCH_SOURCES)[number];

const Iso = z.string().datetime({ offset: true });
const Num = z.number().finite();
const Count = z.number().int().nonnegative();

/** A projection of the lab_event_study result: no new statistics. */
export const StudySummarySchema = z.object({
  verdict: z.enum(["clear", "rejected", "insufficient"]),
  events: Count,
  weeks: Count,
  /** Mean of weekly mean R, signed for the tested side; null with no events. */
  expectancy: Num.nullable(),
  /** One-sided 95% upper bound of the weekly mean R; null under two weeks. */
  upper95: Num.nullable(),
  holdoutExpectancy: Num.nullable(),
  /** `idea #n of N`: the trial this study was recorded as, of the global trial count then. */
  idea: z.object({ n: z.number().int().positive(), of: z.number().int().positive() }).nullable(),
  /** When the study ran. */
  asOf: Iso,
});
export type StudySummary = z.infer<typeof StudySummarySchema>;

export const ResearchSignalSchema = z.object({
  /** `${source}:${coin}:${key}`, stable across board loads. */
  id: z.string().min(1),
  source: z.enum(RESEARCH_SOURCES),
  coin: z.string().min(1),
  /** The source's own side, when it has one. Novelty has none: its rule's side is in `tested`. */
  direction: z.enum(["long", "short"]).nullable(),
  /** Facts only, e.g. "funding z90 +2.4, 7d ret -12%". */
  headline: z.string(),
  /** ms epoch. */
  at: z.number().int(),
  /** The condition as a Lab rule, when one maps; null = no Lab twin (intraday setups, radar calls). */
  rule: RuleSchema.nullable(),
  /**
   * The side the rule is studied as: a hypothesis, not a call. Expectancy in `evidence` is signed for this side (a
   * negative expectancy means the tested side lost, not that the other side won). null without a rule.
   */
  tested: z.enum(["long", "short"]).nullable(),
  /**
   * What a study of this rule covers: `coin` = this market only (catalogue rules are per asset); `universe` = the Lab's
   * default top-20 (novelty rules read ht:* metrics only, and one coin rarely has the 30 event-weeks a verdict needs).
   * POST /research/study sends `coin` only for `coin` scope. Null-rule signals: `coin`.
   */
  scope: z.enum(["coin", "universe"]),
  /** Novelty rules start "tested as fade: …". */
  ruleText: z.string().nullable(),
  /** Drill-in for the source's own object (UI path). */
  href: z.string().nullable(),
  /** Cached study of `rule` in `scope` for today (UTC), when present. */
  evidence: StudySummarySchema.nullable(),
});
export type ResearchSignal = z.infer<typeof ResearchSignalSchema>;

/** Fixed reasons a source or the radar is unavailable; the underlying error is logged server-side only. */
export const UNAVAILABLE_REASONS = [
  "needs a database (DATABASE_URL unset)",
  "platform offline (no worker loop and no database)",
  "radar files not deployed",
  "radar files unreadable",
  "no radar data yet",
  "timed out",
  "source failed (see server log)",
  "sign in required",
] as const;
export const UnavailableReasonSchema = z.enum(UNAVAILABLE_REASONS);
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

export const SourceStatusSchema = z.object({
  state: z.enum(["ok", "unavailable"]),
  reason: UnavailableReasonSchema.optional(),
  /** Signals shown. */
  count: Count,
  /** Items the source returned that did not map to a valid signal (dropped and logged). */
  dropped: Count,
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

/** GET /api/research/board. Signals newest first. */
export const BoardResponseSchema = z.object({
  asOf: Iso,
  signals: z.array(ResearchSignalSchema),
  sources: z.object({ novelty: SourceStatusSchema, rule: SourceStatusSchema, opportunity: SourceStatusSchema, radar: SourceStatusSchema }),
  /** Market Pulse summary: catalogue assets covered and rules firing now. null when the rule source is unavailable. */
  pulse: z.object({ assets: Count, firing: Count }).nullable(),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

/** Defaults of a board study (the lab_event_study examples): stop 1.5 ATR, target 3 ATR. */
export const STUDY_DEFAULTS = { stopAtr: 1.5, targetAtr: 3 } as const;

/**
 * The study a board row opens, as the POST /research/study body: its rule, on its coin only for `coin` scope,
 * with the board's default exits. The board looks up cached evidence under this exact body, so the UI sends it.
 */
export const boardStudy = (s: Pick<ResearchSignal, "rule" | "coin" | "scope">) =>
  s.rule ? { rule: s.rule, ...(s.scope === "coin" ? { coin: s.coin } : {}), ...STUDY_DEFAULTS } : null;

/**
 * POST /api/research/study. `coin` scopes the study to that market; without it, the Lab's default universe (top 20).
 * stopAtr/targetAtr are rounded to 0.1 before the run and the cache key.
 */
export const StudyRequestSchema = z
  .object({
    rule: RuleSchema,
    coin: z.string().regex(ASSET_PATTERN, "expected a ticker of 1–20 letters or digits, e.g. BTC").optional(),
    stopAtr: z.number().positive().max(20).default(STUDY_DEFAULTS.stopAtr),
    targetAtr: z.number().positive().max(50).default(STUDY_DEFAULTS.targetAtr),
  })
  .strict();
export type StudyRequest = z.output<typeof StudyRequestSchema>;

/** The lab_event_study result as the tool returns it; the fields the summary reads are checked, the rest passes through. */
const ScreenSchema = z.object({ events: Count, weeks: Count, expectancy: Num.nullable(), upper95: Num.nullable() });
export const EventStudyResultSchema = z
  .object({
    verdict: StudySummarySchema.shape.verdict,
    screen: ScreenSchema,
    train: ScreenSchema,
    holdout: ScreenSchema,
    eventListTotal: Count,
    idea: z.object({ n: z.number().int().positive(), of: z.number().int().positive() }),
  })
  .passthrough();

export const StudyResponseSchema = z.object({
  /** Cache key: rule hash, coin or universe, exits (to 0.1 ATR) and the UTC day the run started. Same id = same study, not re-run (and not re-counted as a trial). */
  studyId: z.string(),
  cached: z.boolean(),
  summary: StudySummarySchema,
  /** The full lab_event_study result (funnel, per-coin table, event list...). */
  study: EventStudyResultSchema,
  /** The rule's catalogue id when the rule is in the catalogue now (looked up per request, never cached); else null. */
  catalogueId: z.string().nullable(),
});
export type StudyResponse = z.infer<typeof StudyResponseSchema>;

/** One scorecard line of src/server/radar/calls.ts as data. */
export const RadarScoreRowSchema = z.object({
  stance: z.enum(["ride", "fade"]),
  horizonDays: z.number().int().positive(),
  n: z.number().int().positive(),
  /** Mean move vs BTC, %, signed by direction. */
  meanPct: Num,
  /** Calls that went the called way. */
  hits: Count,
});
export type RadarScoreRow = z.infer<typeof RadarScoreRowSchema>;

export const RADAR_MAX_CALLS_SHOWN = 50;
export const RADAR_NOTE_MAX_CHARS = 20_000;

/** GET /api/radar (not guest-readable: theses and notes are LLM-written). */
export const RadarResponseSchema = z.object({
  state: z.enum(["ok", "unavailable"]),
  reason: UnavailableReasonSchema.optional(),
  /** `markdown` is cut at RADAR_NOTE_MAX_CHARS; `truncated` says whether it was. */
  latestNote: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), markdown: z.string().max(RADAR_NOTE_MAX_CHARS), truncated: z.boolean() }).nullable(),
  /** The last RADAR_MAX_CALLS_SHOWN calls of data/radar/calls.json in file order, graded against state.json. */
  calls: z.array(RadarCallSchema).max(RADAR_MAX_CALLS_SHOWN),
  /** Over every call in the file, not only those shown. */
  scorecard: z.array(RadarScoreRowSchema),
});
export type RadarResponse = z.infer<typeof RadarResponseSchema>;
