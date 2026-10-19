import { Hono } from "hono";
import { z } from "zod";
import { cycleAnalogs, forecastNextRun } from "../../shared/cycleForecast.js";
import { computeCycle, HALVINGS, NEXT_HALVING_ESTIMATE, resampleWeekly, toCycleBar, type CyclesResponse, type DailyBar } from "../../shared/cycles.js";
import * as db from "../db.js";
import { ensureHistory } from "../market/candleSync.js";
import { bitstamp } from "../market/sources.js";

export type { CyclesResponse };

// GET /cycles?tf=1d|1w
//
// The BTC cycle view (ported from hl-cycles): full daily history run through
// the HTF phase model, plus the next-bull-run estimate and the cycle-from-top
// analogs. BTC only: the halving anchors are BTC's. History comes from the
// stored 1d candles (HL, then Binance, then Bitstamp below them); without a
// DB, or before the backfill reaches 2011, Bitstamp's public OHLC fills in.

const DAY = 86_400_000;
/** Bitstamp's BTC/USD daily history starts 2011-08-18. */
const HISTORY_FROM = Date.UTC(2011, 7, 18);
/** Stored history reaching back past this is deep enough for every cycle. */
const DEEP_ENOUGH = Date.UTC(2012, 0, 1);
const ENSURE_CAP_MS = 15_000;
const LIVE_PAGES = 8; // 1000 daily bars each
const CACHE_MS = 15 * 60_000;

const querySchema = z.object({ tf: z.enum(["1d", "1w"]).optional() });

export type CyclesDeps = {
  now: () => number;
  hasDb: () => boolean;
  /** Best-effort backfill of stored BTC 1d candles; never throws. */
  ensure: () => Promise<void>;
  stored: () => Promise<DailyBar[]>;
  /** Live daily bars older than `before`, ascending (one Bitstamp page). */
  livePage: (before: number) => Promise<DailyBar[]>;
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | void> => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

export const defaultCyclesDeps: CyclesDeps = {
  now: () => Date.now(),
  hasDb: () => Boolean(db.databaseUrl()),
  async ensure() {
    const deadline = Date.now() + ENSURE_CAP_MS - 2_000;
    await withTimeout(ensureHistory("BTC", "1d", HISTORY_FROM, undefined, { deadline }), ENSURE_CAP_MS).catch(() => {});
  },
  async stored() {
    return (await db.getCandles("BTC", "1d")).map((c) => ({
      t: new Date(c.ts).getTime(),
      o: Number(c.o),
      h: Number(c.h),
      l: Number(c.l),
      c: Number(c.c),
      v: Number(c.v ?? 0),
      src: c.src ?? "hl",
    }));
  },
  async livePage(before) {
    const page = await bitstamp.fetchBefore("BTC", "1d", before, bitstamp.pageSize);
    return page.kind === "ok" ? page.bars.map((b) => ({ ...b, src: "bitstamp" })) : [];
  },
};

/** Stored bars, topped up from Bitstamp where storage doesn't reach back far enough. */
export async function loadHistory(deps: CyclesDeps): Promise<DailyBar[]> {
  let stored: DailyBar[] = [];
  if (deps.hasDb()) {
    await deps.ensure();
    stored = await deps.stored().catch(() => []);
  }
  if (stored.length && stored[0]!.t <= DEEP_ENOUGH) return stored;

  const live: DailyBar[] = [];
  let before = stored[0]?.t ?? deps.now();
  for (let i = 0; i < LIVE_PAGES && before > HISTORY_FROM; i++) {
    const page = (await deps.livePage(before - 1).catch(() => [])).filter((b) => b.t < before);
    if (page.length === 0) break;
    live.unshift(...page);
    before = page[0]!.t;
  }
  // Stored bars win where both exist.
  const byDay = new Map<number, DailyBar>();
  for (const b of [...live, ...stored]) byDay.set(Math.floor(b.t / DAY), b);
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

export function buildCycles(history: DailyBar[], now: number, tf: "1d" | "1w"): CyclesResponse {
  const points = computeCycle(history, now);
  const forecast = forecastNextRun(points);
  const shown = tf === "1w" ? resampleWeekly(points) : points;
  const sources: Record<string, number> = {};
  for (const p of points) sources[p.src] = (sources[p.src] ?? 0) + 1;
  return {
    asOf: points[points.length - 1]?.t ?? now,
    tf,
    bars: shown.map(toCycleBar),
    halvings: [...HALVINGS],
    nextHalving: NEXT_HALVING_ESTIMATE,
    forecast,
    analogs: cycleAnalogs(points, forecast.episodes),
    sources,
  };
}

export function cyclesRoute(deps: CyclesDeps = defaultCyclesDeps) {
  // The model is ~100 ms over 5500 days and the inputs move once a day; one
  // computed body per timeframe is shared until it ages out.
  const cache = new Map<string, { at: number; body: CyclesResponse }>();
  let inflight: Promise<DailyBar[]> | null = null;

  return new Hono().get("/", async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query" }, 400);
    const tf = parsed.data.tf ?? "1d";
    const now = deps.now();
    const hit = cache.get(tf);
    if (hit && now - hit.at < CACHE_MS) return c.json(hit.body);

    inflight ??= loadHistory(deps).finally(() => (inflight = null));
    const history = await inflight;
    if (history.length === 0) return c.json({ error: "no BTC history available" }, 503);
    const body = buildCycles(history, now, tf);
    cache.set(tf, { at: now, body });
    return c.json(body);
  });
}

export const cyclesRoutes = cyclesRoute();
