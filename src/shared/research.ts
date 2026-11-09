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
  /** Mean of weekly mean R; null with no events. */
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
  direction: z.enum(["long", "short"]).nullable(),
  /** Facts only, e.g. "funding z90 +2.4, 7d ret -12%". */
  headline: z.string(),
  /** ms epoch. */
  at: z.number().int(),
  /** The condition as a Lab rule, when one maps; null = no Lab twin (intraday setups, radar calls). */
  rule: RuleSchema.nullable(),
  ruleText: z.string().nullable(),
  /** Drill-in for the source's own object (UI path). */
  href: z.string().nullable(),
  /** Cached study of `rule` on `coin` for today (UTC), when present. */
  evidence: StudySummarySchema.nullable(),
});
export type ResearchSignal = z.infer<typeof ResearchSignalSchema>;

export const SourceStatusSchema = z.object({
  state: z.enum(["ok", "unavailable"]),
  reason: z.string().optional(),
  count: Count,
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

/** POST /api/research/study. `coin` scopes the study to that market; without it, the Lab's default universe (top 20). */
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
  /** Cache key: rule hash, scope and UTC day. Same id = same study, not re-run (and not re-counted as a trial). */
  studyId: z.string(),
  cached: z.boolean(),
  summary: StudySummarySchema,
  /** The full lab_event_study result (funnel, per-coin table, event list...). */
  study: EventStudyResultSchema,
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

/** GET /api/radar. */
export const RadarResponseSchema = z.object({
  state: z.enum(["ok", "unavailable"]),
  reason: z.string().optional(),
  latestNote: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), markdown: z.string() }).nullable(),
  /** As in data/radar/calls.json, graded against state.json. */
  calls: z.array(RadarCallSchema),
  scorecard: z.array(RadarScoreRowSchema),
});
export type RadarResponse = z.infer<typeof RadarResponseSchema>;
