// Loads the Lab's aligned daily dataset from Postgres. The engine itself is
// pure; this is the only I/O between it and the database.
import { LAB_BASES, labBase } from "../../shared/lab.js";
import * as db from "../db.js";
import { alignDaily, DAY_MS, dayGrid, dayStart, type LabDataset } from "./features.js";
import { LabError } from "./search.js";

export type DatasetDeps = {
  getCandles: (coin: string, tf: string) => Promise<{ ts: Date | string; c: number }[]>;
  seriesRange: (id: string) => Promise<{ ts: Date; value: number }[]>;
  dailyFunding: (coin: string) => Promise<{ ts: Date; rate: number }[]>;
};

const defaultDeps: DatasetDeps = {
  getCandles: (coin, tf) => db.getCandles(coin, tf),
  seriesRange: (id) => db.seriesRange(id),
  dailyFunding: (coin) => db.dailyFunding(coin),
};

const ms = (ts: Date | string) => (ts instanceof Date ? ts.getTime() : Date.parse(ts));

/** Hourly funding fraction -> annualized percent. */
export const annualizeFunding = (hourly: number) => hourly * 24 * 365 * 100;

/**
 * BTC daily closes define the grid; every requested base is aligned onto it
 * with its publication lag. Today's bar is still forming, so the grid ends at
 * the last complete UTC day.
 */
export async function loadDataset(baseIds: string[] = LAB_BASES.map((b) => b.id), deps: DatasetDeps = defaultDeps, nowMs = Date.now()): Promise<LabDataset> {
  const today = dayStart(nowMs);
  const candles = (await deps.getCandles("BTC", "1d")).map((c) => ({ ts: dayStart(ms(c.ts)), value: Number(c.c) })).filter((c) => c.ts < today);
  if (candles.length < 2) throw new LabError("no BTC daily candles yet — run the cron backfill (POST /api/cron/backfill) first");
  const days = dayGrid(candles[0]!.ts, candles.at(-1)!.ts);
  const close = alignDaily(candles, days, 0);

  const bases: Record<string, Float64Array> = { "px.BTC": close };
  await Promise.all(
    baseIds.map(async (id) => {
      const base = labBase(id);
      if (!base || id === "px.BTC") return;
      let points: { ts: number; value: number }[];
      if (id.startsWith("fund.")) {
        const rows = await deps.dailyFunding(id.slice("fund.".length));
        points = rows.map((r) => ({ ts: ms(r.ts), value: annualizeFunding(Number(r.rate)) }));
      } else {
        const rows = await deps.seriesRange(id);
        points = rows.map((r) => ({ ts: ms(r.ts), value: Number(r.value) }));
      }
      if (points.length) bases[id] = alignDaily(points, days, base.lagDays);
    }),
  );
  return { days, close, bases };
}

/** Date of the last grid day, for staleness checks. */
export const lastDay = (ds: LabDataset) => ds.days.at(-1) ?? 0;
export const isStale = (ds: LabDataset, nowMs = Date.now()) => nowMs - lastDay(ds) > 3 * DAY_MS;
