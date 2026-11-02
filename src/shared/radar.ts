import { z } from "zod";

// Radar contracts (ROUTINE.md): the daily cross-dex market memory the scan diffs against, and the calls the
// routine session writes. Calls are LLM output, so they are parsed here and stamped with prices by code.

/** Daily snapshots kept in data/radar/state.json: enough for a 7-day lookback with a few missed days. */
export const RADAR_STATE_DAYS = 10;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One run's snapshot. marks[key] = [mark, 24h notional volume USD, open interest USD]. */
export const RadarDaySchema = z.object({
  date: isoDate,
  at: z.string(),
  marks: z.record(z.string(), z.tuple([z.number(), z.number(), z.number()])),
  /** Backfilled from daily candles (close, UTC-day notional, OI unknown = 0) for liquid markets only: it serves
   * the 7-day and volume reads, never new-listing, rank or OI diffs. */
  seeded: z.boolean().optional(),
});
export type RadarDay = z.infer<typeof RadarDaySchema>;

export const RadarStateSchema = z.object({ days: z.array(RadarDaySchema).default([]) });
export type RadarState = z.infer<typeof RadarStateSchema>;

export const RADAR_MAX_CALLS = 3;

/** What the session writes to /tmp/run/calls.json. Prices are never typed by the model: `land` stamps them. */
export const RadarCallInputSchema = z
  .object({
    /** Market key exactly as the digest prints it: "HYPE", "xyz:SKHX". */
    market: z.string().min(1),
    stance: z.enum(["ride", "fade", "watch"]),
    kind: z.enum(["catalyst", "rotation", "listing", "structure"]),
    thesis: z.string().min(10).max(500),
    /** The dated source for the cause; null means none was found, which caps the call at "watch". */
    cause_url: z.string().url().nullable(),
    cause_date: isoDate.nullable(),
    kill_if: z.string().min(5).max(240),
  })
  .refine((c) => (c.cause_url == null) === (c.cause_date == null), { message: "cause_url and cause_date go together" })
  .refine((c) => c.cause_url != null || c.stance === "watch", { message: "a ride or fade needs a dated cause" });
export type RadarCallInput = z.infer<typeof RadarCallInputSchema>;

export const RadarCallsInputSchema = z.object({ calls: z.array(RadarCallInputSchema).max(RADAR_MAX_CALLS) });

export const RADAR_HORIZONS = [3, 7] as const;

export const RadarCallSchema = z.object({
  id: z.string(),
  date: isoDate,
  at: z.string(),
  market: z.string(),
  stance: z.enum(["ride", "fade", "watch"]),
  kind: z.enum(["catalyst", "rotation", "listing", "structure"]),
  thesis: z.string(),
  cause_url: z.string().nullable(),
  cause_date: isoDate.nullable(),
  kill_if: z.string(),
  mark: z.number(),
  btc: z.number(),
  /** Move relative to BTC after N days, in %, sign-adjusted so a correct fade is positive. Filled by `grade`. */
  rel: z.record(z.string(), z.number()).default({}),
});
export type RadarCall = z.infer<typeof RadarCallSchema>;

export const RadarCallsFileSchema = z.object({ calls: z.array(RadarCallSchema).default([]) });
export type RadarCallsFile = z.infer<typeof RadarCallsFileSchema>;
