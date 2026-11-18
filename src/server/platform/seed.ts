import { z } from "zod";
import type { FundingPoint } from "../../shared/hl-client.js";
import { median } from "../../shared/signalMath.js";
import type { Candle } from "../../shared/types.js";
import { coinalyzeGet, hlSymbolMap } from "../collectors/coinalyzeOi.js";
import type { RingPoint } from "./features.js";
import { candleStream, GRID_MS } from "./replaySource.js";
import type { PlatformStore, ScanSnapshot } from "./store.js";

// Intraday seed for scan_snapshots (docs/RESEARCH.md S5, "Seed"). scan_snapshots is the one stored intraday series
// every consumer reads (the scanner's ring at boot, the extremes job and its grading, the snapshot replay), and only
// the always-on scanner writes it. This fills its gaps on the 15-min grid from data that has history:
//   mark, 24 h volume  Hyperliquid 15-min candles (close; trailing sum of volume × close), as the candle replay reads them
//   funding            the latest hourly settlement at or before the point (the live row holds the predicted rate)
//   oiUsd              Coinalyze open interest of the Hyperliquid perp in coins × the candle close: the live row's
//                      openInterest × markPx
// Coinalyze keeps 1500 to 2000 intraday bars, so a run reaches about 15 to 20 days back at 15 min; older gaps stay.
// Gaps only: a grid slot that already holds a stored row is left alone. Before writing, a coin's seeded OI is compared
// with its stored rows where both exist; a coin whose levels disagree is skipped, so a unit or symbol mismatch cannot
// reach the detectors. Seeded rows carry `seeded: "coinalyze"` in `inputs`; readers ignore the extra key.
// Cheap when there is nothing to do: a coin's stored rows are read first, a coin with no empty slot in the window costs
// no request, and one with a gap is fetched only from its first empty slot on. A run stops starting coins at its
// deadline and reports the rest. Scheduled by POST /api/cron/seed-snapshots (routes/cronSeed.ts, db/cron/schedule.sql):
// a 6 h window every 15 min for missed ticks, a 14-day window once a day for long outages and the first backfill.

const DAY = 86_400_000;
/** Requested span: past Coinalyze's intraday retention, so a run takes everything it keeps. */
export const SEED_DAYS = 21;
/** Stored rows a coin needs in common with the seed before its OI level is judged. */
const MIN_OVERLAP = 8;
/** Seeded OI may differ from stored OI by this share at the median (the stored row is up to 15 min older). */
const MAX_OI_DRIFT = 0.1;

const OiSchema = z.array(z.object({ symbol: z.string(), history: z.array(z.object({ t: z.number(), c: z.number().nonnegative() })) }));

/** Pure: Coinalyze 15-min open-interest-history (t = bar start, s; c = OI at the bar's close) → OI in coins by bar close (ms). */
export function parseIntradayOi(raw: unknown): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of OiSchema.parse(raw)[0]?.history ?? []) out.set(p.t * 1000 + GRID_MS, p.c);
  return out;
}

/** The grid close a stored snapshot belongs to: ts in (close − 15 min, close]. */
const slot = (ts: number) => Math.ceil(ts / GRID_MS) * GRID_MS;

export interface SeedPlan {
  /** Rows for the empty grid slots. */
  rows: ScanSnapshot[];
  /** Grid slots with both a seed point and a stored row. */
  overlap: number;
  /** Median seeded / stored oiUsd over those slots; null without any. */
  oiRatio: number | null;
  /** False when the overlap is large enough to judge and the levels disagree: nothing may be written. */
  consistent: boolean;
}

/**
 * Pure: seed rows for one coin. A point needs a finite mark, funding and 24 h volume and an OI bar at its close; a
 * slot that already holds a stored row is skipped and compared instead.
 */
export function seedPlan(coin: string, stream: RingPoint[], oiCoins: Map<number, number>, stored: ScanSnapshot[]): SeedPlan {
  const have = new Map<number, number | null>();
  for (const s of stored) {
    const oi = (s.inputs as Record<string, unknown>).oiUsd;
    have.set(slot(Date.parse(s.ts)), typeof oi === "number" && Number.isFinite(oi) && oi > 0 ? oi : null);
  }
  const rows: ScanSnapshot[] = [];
  const ratios: number[] = [];
  let overlap = 0;
  for (const p of stream) {
    const coins = oiCoins.get(p.ts);
    if (coins == null || ![p.mark, p.funding, p.dayNtlVlm].every(Number.isFinite)) continue;
    const oiUsd = coins * p.mark;
    if (have.has(p.ts)) {
      overlap++;
      const live = have.get(p.ts);
      if (live) ratios.push(oiUsd / live);
      continue;
    }
    rows.push({ coin, ts: new Date(p.ts).toISOString(), inputs: { mark: p.mark, oiUsd, funding: p.funding, dayNtlVlm: p.dayNtlVlm, seeded: "coinalyze" } });
  }
  const oiRatio = ratios.length ? median(ratios) : null;
  const consistent = ratios.length < MIN_OVERLAP || Math.abs(oiRatio! - 1) <= MAX_OI_DRIFT;
  return { rows, overlap, oiRatio, consistent };
}

export interface SnapshotSeedDeps {
  coins: () => Promise<string[]>;
  candles: (coin: string, startMs: number, endMs: number) => Promise<Candle[]>;
  /** Hourly funding settlements in [startMs, endMs]. */
  funding: (coin: string, startMs: number, endMs: number) => Promise<FundingPoint[]>;
  /** OI in coins by 15-min bar close over [startMs, endMs]; null when Coinalyze lists no Hyperliquid perp for the coin. */
  oi: (coin: string, startMs: number, endMs: number) => Promise<Map<number, number> | null>;
  store: Pick<PlatformStore, "scanSnapshotsSince" | "insertScanSnapshots">;
  now: () => number;
  /** Plan and report only: nothing is written. */
  dryRun: boolean;
  /** Days back the run looks for gaps; default SEED_DAYS. */
  days?: number;
  /** No coin is started at or after this time (ms); absent: every coin runs. */
  deadline?: number;
  log?: (msg: string) => void;
}

export interface SeedCoinReport { coin: string; written: number; planned: number; overlap: number; oiRatio: number | null; skipped: string | null }

/** The first grid slot in (from, end] that holds no stored row; null when every slot is filled. */
export function firstGap(stored: ScanSnapshot[], from: number, end: number): number | null {
  const have = new Set(stored.map((s) => slot(Date.parse(s.ts))));
  for (let t = from + GRID_MS; t <= end; t += GRID_MS) if (!have.has(t)) return t;
  return null;
}

/** Why a coin was not started: the run's deadline. The next run takes it. */
export const SEED_DEADLINE = "not started before the deadline";

/** Seeds every coin in turn; one coin's failure is reported and the rest go on. */
export async function runSnapshotSeed(d: SnapshotSeedDeps): Promise<SeedCoinReport[]> {
  const end = Math.floor(d.now() / GRID_MS) * GRID_MS; // last closed candle boundary
  const span = end - Math.round((d.days ?? SEED_DAYS) * DAY / GRID_MS) * GRID_MS;
  const out: SeedCoinReport[] = [];
  for (const coin of await d.coins()) {
    const r: SeedCoinReport = { coin, written: 0, planned: 0, overlap: 0, oiRatio: null, skipped: null };
    if (d.deadline != null && d.now() >= d.deadline) {
      out.push({ ...r, skipped: SEED_DEADLINE });
      continue;
    }
    try {
      const stored = await d.store.scanSnapshotsSince(new Date(span).toISOString(), [coin]);
      const gap = firstGap(stored, span, end);
      if (gap == null) {
        out.push(r); // every slot is filled: no request
        continue;
      }
      // Bars are keyed by their close: the bar closing at `gap` opens one step before it.
      const start = gap - GRID_MS;
      const oi = await d.oi(coin, start, end);
      if (!oi) r.skipped = "no Hyperliquid perp on Coinalyze";
      else if (!oi.size) r.skipped = "Coinalyze returned no OI bars";
      else {
        // One more day of candles in front: the 24 h volume needs a full day behind the first seeded point.
        const [cs, fs] = [await d.candles(coin, start - DAY, end - 1), await d.funding(coin, start - DAY, end)];
        const stream = candleStream(cs.filter((c) => c.t + GRID_MS <= end), fs);
        const plan = seedPlan(coin, stream, oi, stored);
        Object.assign(r, { planned: plan.rows.length, overlap: plan.overlap, oiRatio: plan.oiRatio });
        if (!plan.consistent) r.skipped = `seeded OI is ${plan.oiRatio!.toFixed(2)}x the stored OI over ${plan.overlap} shared slots`;
        else if (!d.dryRun) r.written = await d.store.insertScanSnapshots(plan.rows);
      }
    } catch (e) {
      r.skipped = e instanceof Error ? e.message : String(e);
    }
    d.log?.(`${coin}: ${r.skipped ? `skipped (${r.skipped})` : `${d.dryRun ? `${r.planned} planned` : `${r.written} written`}, ${r.overlap} already stored${r.oiRatio == null ? "" : `, OI ratio ${r.oiRatio.toFixed(3)}`}`}`);
    out.push(r);
  }
  return out;
}

/** Coinalyze 15-min OI of the Hyperliquid perp, in coins. The symbol map is fetched once. */
export function coinalyzeIntradayOi(key: string, deps: { fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void> }): SnapshotSeedDeps["oi"] {
  const get = coinalyzeGet(key, deps);
  let symbols: Promise<Map<string, string>> | undefined;
  return async (coin, startMs, endMs) => {
    const symbol = (await (symbols ??= (async () => hlSymbolMap(await get("exchanges"), await get("future-markets")))())).get(coin);
    if (!symbol) return null;
    return parseIntradayOi(await get("open-interest-history", { symbols: symbol, interval: "15min", from: String(Math.floor(startMs / 1000)), to: String(Math.floor(endMs / 1000)), convert_to_usd: "false" }));
  };
}
