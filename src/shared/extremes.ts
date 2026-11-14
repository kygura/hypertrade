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

const EXTREME_STANCES = ["take", "watch", "pass"] as const;

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
});
export type ExtremeRecord = z.infer<typeof ExtremeRecordSchema>;
