import { z } from "zod";

// Radar contracts (ROUTINE.md): the daily cross-dex market memory the scan diffs against, and the calls the
// routine session writes. Calls are LLM output, so they are parsed here and stamped with prices by code.

/** Daily snapshots kept in data/radar/state.json: enough for a 7-day lookback with a few missed days. */
export const RADAR_STATE_DAYS = 10;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One run's snapshot. marks[key] = [mark, 24h notional volume USD, open interest USD]. */
const RadarDaySchema = z.object({
  date: isoDate,
  at: z.string(),
  marks: z.record(z.string(), z.tuple([z.number(), z.number(), z.number()])),
  /** Backfilled from daily candles (close, UTC-day notional, OI unknown = 0) for liquid markets only: it serves
   * the 7-day and volume reads, never new-listing, rank or OI diffs. */
  seeded: z.boolean().optional(),
  /** Dexes this snapshot covers ("main", "xyz", ...). A dex that failed is carried forward, so it stays listed. */
  dexes: z.array(z.string()).optional(),
});
export type RadarDay = z.infer<typeof RadarDaySchema>;

export const RadarStateSchema = z.object({ days: z.array(RadarDaySchema).default([]) });
export type RadarState = z.infer<typeof RadarStateSchema>;

const RADAR_MAX_CALLS = 3;

const isRealDate = (d: string) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const realDate = isoDate.refine(isRealDate, { message: "not a calendar date" });

/**
 * What the session writes to /tmp/run/calls.json. Only ride and fade calls are landed; a watch stays in the
 * notes. Prices are never typed by the model except the kill level, which code checks against the scan.
 */
const RadarCallInputSchema = z
  .object({
    /** Market key exactly as the digest prints it: "HYPE", "xyz:SKHX". */
    market: z.string().min(1),
    /** Ride = with the move, fade = against it; the direction says which way that is. */
    stance: z.enum(["ride", "fade"]),
    direction: z.enum(["long", "short"]),
    kind: z.enum(["catalyst", "rotation", "listing", "structure"]),
    thesis: z.string().min(10).max(400),
    /** The dated source: publication date for news, or the event date for a scheduled event. */
    cause_url: z.string().url().refine((u) => /^https?:\/\//.test(u), { message: "http(s) url only" }),
    cause_date: realDate,
    /** The mark that ends the call: below it for a long, above it for a short. */
    kill_price: z.number().positive(),
    kill_if: z.string().min(5).max(200),
  });
export type RadarCallInput = z.infer<typeof RadarCallInputSchema>;

export const RadarCallsInputSchema = z.object({ calls: z.array(RadarCallInputSchema).max(RADAR_MAX_CALLS) });

export const RADAR_HORIZONS = [3, 7] as const;

export const RadarCallSchema = z.object({
  id: z.string(),
  date: isoDate,
  at: z.string(),
  market: z.string(),
  stance: z.enum(["ride", "fade"]),
  direction: z.enum(["long", "short"]),
  kind: z.enum(["catalyst", "rotation", "listing", "structure"]),
  thesis: z.string(),
  cause_url: z.string(),
  cause_date: isoDate,
  kill_price: z.number(),
  kill_if: z.string(),
  mark: z.number(),
  btc: z.number(),
  /** Move relative to BTC after N days, in %, signed by direction so a correct short is positive. Filled by `grade`. */
  rel: z.record(z.string(), z.number()).default({}),
  /** Date a scan first saw the mark through kill_price; reported once. */
  killed_at: isoDate.nullable().default(null),
});
export type RadarCall = z.infer<typeof RadarCallSchema>;

export const RadarCallsFileSchema = z.object({ calls: z.array(RadarCallSchema).default([]) });
export type RadarCallsFile = z.infer<typeof RadarCallsFileSchema>;
