import { Hono } from "hono";
import { z } from "zod";
import { coolingHighs, cycleAnalogs, forecastNextRun } from "../../shared/cycleForecast.js";
import { computeCycle, CYCLE_COINS, HALVINGS, NEXT_HALVING_ESTIMATE, resampleWeekly, smoothPhases, toCycleBar, type CycleCoin, type CyclesResponse, type DailyBar } from "../../shared/cycles.js";
import * as db from "../db.js";
import { cmProvider } from "../lab/providers/cm.js";
import { ensureHistory } from "../market/candleSync.js";
import { bitstamp } from "../market/sources.js";

export type { CyclesResponse };

// GET /cycles?coin=BTC|ETH&tf=1d|1w
//
// The cycle view (ported from hl-cycles): full daily history run through the
// HTF phase model, plus the next-bull-run estimate and the cycle-from-top
// analogs. Halving anchors are BTC's for both coins: ETH runs on BTC's clock.
// History comes from the stored 1d candles (HL, then Binance, then Bitstamp
// below them); without a DB, or before the backfill reaches far enough back,
// Bitstamp's public OHLC fills in, and Coin Metrics' daily reference price
// (close only) covers what no venue has: ETH before Bitstamp's Aug 2017 listing.

const DAY = 86_400_000;
/** Where each coin's history starts, and how deep stored history must reach to skip the top-up. */
const HISTORY: Record<CycleCoin, { from: number; deepEnough: number }> = {
  BTC: { from: Date.UTC(2011, 7, 18), deepEnough: Date.UTC(2012, 0, 1) }, // Bitstamp BTC/USD
  ETH: { from: Date.UTC(2015, 7, 8), deepEnough: Date.UTC(2015, 8, 1) }, // first ETH trading day
};
const ENSURE_CAP_MS = 15_000;
const LIVE_PAGES = 8; // 1000 daily bars each
const CACHE_MS = 15 * 60_000;

const querySchema = z.object({ coin: z.enum(CYCLE_COINS).optional(), tf: z.enum(["1d", "1w"]).optional() });

export type CyclesDeps = {
  now: () => number;
  hasDb: () => boolean;
  /** Best-effort backfill of stored 1d candles down to `from`; never throws. */
  ensure: (coin: CycleCoin, from: number) => Promise<void>;
  stored: (coin: CycleCoin) => Promise<DailyBar[]>;
  /** Live daily bars older than `before`, ascending (one Bitstamp page). */
  livePage: (coin: CycleCoin, before: number) => Promise<DailyBar[]>;
  /** Close-only daily reference prices in [from, to), ascending (Coin Metrics). */
  seed: (coin: CycleCoin, from: number, to: number) => Promise<DailyBar[]>;
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | void> => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

export const defaultCyclesDeps: CyclesDeps = {
  now: () => Date.now(),
  hasDb: () => Boolean(db.databaseUrl()),
  async ensure(coin, from) {
    const deadline = Date.now() + ENSURE_CAP_MS - 2_000;
    await withTimeout(ensureHistory(coin, "1d", from, undefined, { deadline }), ENSURE_CAP_MS).catch(() => {});
  },
  async stored(coin) {
    return (await db.getCandles(coin, "1d")).map((c) => ({
      t: new Date(c.ts).getTime(),
      o: Number(c.o),
      h: Number(c.h),
      l: Number(c.l),
      c: Number(c.c),
      v: Number(c.v ?? 0),
      src: c.src ?? "hl",
    }));
  },
  async livePage(coin, before) {
    const page = await bitstamp.fetchBefore(coin, "1d", before, bitstamp.pageSize);
    return page.kind === "ok" ? page.bars.map((b) => ({ ...b, src: "bitstamp" })) : [];
  },
  async seed(coin, from, to) {
    const s = await cmProvider.fetch("PriceUSD", coin, from, to - DAY);
    return s.t.map((t, i) => {
      const c = s.v[i]!;
      return { t, o: c, h: c, l: c, c, v: 0, src: "coinmetrics" };
    });
  },
};

/**
 * Stored bars, topped up from Bitstamp where storage doesn't reach back far
 * enough, then from Coin Metrics below the oldest venue bar.
 */
export async function loadHistory(coin: CycleCoin, deps: CyclesDeps): Promise<DailyBar[]> {
  const { from, deepEnough } = HISTORY[coin];
  let stored: DailyBar[] = [];
  if (deps.hasDb()) {
    await deps.ensure(coin, from);
    stored = await deps.stored(coin).catch(() => []);
  }
  if (stored.length && stored[0]!.t <= deepEnough) return stored;

  const live: DailyBar[] = [];
  let before = stored[0]?.t ?? deps.now();
  for (let i = 0; i < LIVE_PAGES && before > from; i++) {
    const page = (await deps.livePage(coin, before - 1).catch(() => [])).filter((b) => b.t < before);
    if (page.length === 0) break;
    live.unshift(...page);
    before = page[0]!.t;
  }
  const seed = before > deepEnough ? (await deps.seed(coin, from, before).catch(() => [])).filter((b) => b.t < before) : [];
  // Later sources win where they overlap: stored over Bitstamp over Coin Metrics.
  const byDay = new Map<number, DailyBar>();
  for (const b of [...seed, ...live, ...stored]) byDay.set(Math.floor(b.t / DAY), b);
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

export function buildCycles(coin: CycleCoin, history: DailyBar[], now: number, tf: "1d" | "1w"): CyclesResponse {
  const points = computeCycle(history, now);
  const forecasts = { breakout: forecastNextRun(points, { kind: "breakout" }), euphoria: forecastNextRun(points, { kind: "euphoria" }) };
  // Bands draw the smoothed phases; the forecast above used the model's own.
  const smooth = smoothPhases(points.map((p) => p.phase));
  const display = points.map((p, i) => ({ ...p, phase: smooth[i]! }));
  const shown = tf === "1w" ? resampleWeekly(display) : display;
  const sources: Record<string, number> = {};
  for (const p of points) sources[p.src] = (sources[p.src] ?? 0) + 1;
  return {
    coin,
    asOf: points[points.length - 1]?.t ?? now,
    tf,
    bars: shown.map(toCycleBar),
    halvings: [...HALVINGS],
    nextHalving: NEXT_HALVING_ESTIMATE,
    forecasts,
    analogs: cycleAnalogs(points, forecasts.breakout.episodes),
    coolingHighs: coolingHighs(points),
    sources,
  };
}

export function cyclesRoute(deps: CyclesDeps = defaultCyclesDeps) {
  // The model is ~100 ms over 5500 days and the inputs move once a day; one
  // computed body per coin and timeframe is shared until it ages out.
  const cache = new Map<string, { at: number; body: CyclesResponse }>();
  const inflight = new Map<CycleCoin, Promise<DailyBar[]>>();

  return new Hono().get("/", async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query" }, 400);
    const coin = parsed.data.coin ?? "BTC";
    const tf = parsed.data.tf ?? "1d";
    const key = `${coin}:${tf}`;
    const now = deps.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return c.json(hit.body);

    let load = inflight.get(coin);
    if (!load) {
      load = loadHistory(coin, deps).finally(() => inflight.delete(coin));
      inflight.set(coin, load);
    }
    const history = await load;
    if (history.length === 0) return c.json({ error: `no ${coin} history available` }, 503);
    const body = buildCycles(coin, history, now, tf);
    cache.set(key, { at: now, body });
    return c.json(body);
  });
}

export const cyclesRoutes = cyclesRoute();
