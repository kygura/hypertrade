// Hourly funding history from Hyperliquid fundingHistory (500 rows per call,
// full history back to each coin's listing; BTC starts 2023-05-12). Stored
// in `funding`, synced newest-first so a chart gets recent funding at once
// and older pages fill in on later requests and cron runs.
import { fetchFundingPage, HL_FUNDING_PAGE, type FundingPoint } from "../../shared/hl-client.js";
import * as db from "../db.js";

const HOUR = 3_600_000;
const PAGE_SPAN = HL_FUNDING_PAGE * HOUR;
const SERIES = "funding";

export interface FundingDeps {
  now(): number;
  page(coin: string, start: number, end: number): Promise<FundingPoint[]>;
  bounds(coin: string): Promise<{ min: number; max: number } | null>;
  upsert(coin: string, rows: FundingPoint[]): Promise<void>;
  getState(coin: string, series: string): Promise<db.SyncState>;
  saveState(s: db.SyncState): Promise<void>;
}

export const defaultFundingDeps: FundingDeps = {
  now: () => Date.now(),
  page: (coin, start, end) => fetchFundingPage(coin, start, end),
  async bounds(coin) {
    const c = await db.fundingCoverage(coin);
    return c ? { min: c.min.getTime(), max: c.max.getTime() } : null;
  },
  async upsert(coin, rows) {
    await db.upsertFunding(coin, rows);
  },
  getState: db.getSyncState,
  saveState: db.saveSyncState,
};

export interface FundingSyncResult {
  pages: number;
  /** Oldest stored settlement after this pass, or null with nothing stored. */
  from: number | null;
  /** Reached the coin's first-ever settlement. */
  complete: boolean;
}

/**
 * Head: pages forward from the newest stored row to now. Older: pages
 * backward until `from` is covered, the listing is reached, or the budget
 * runs out. Never throws — a failed page leaves what was stored and records
 * the error on sync_state.
 */
export async function syncFunding(
  coin: string,
  from: number,
  opts: { maxPages: number; deadline?: number },
  deps: FundingDeps = defaultFundingDeps,
): Promise<FundingSyncResult> {
  const now = deps.now();
  const deadline = opts.deadline ?? Infinity;
  const state = await deps.getState(coin, SERIES);
  let pages = 0;
  const canPage = () => pages < opts.maxPages && Date.now() < deadline;
  let b = await deps.bounds(coin);

  try {
    // Head: settlements land hourly; skip when the newest is under an hour old.
    if (b && now - b.max > HOUR) {
      let cursor = b.max + 1;
      while (canPage() && cursor < now) {
        pages++;
        const rows = await deps.page(coin, cursor, now);
        await deps.upsert(coin, rows);
        if (rows.length < HL_FUNDING_PAGE) break;
        cursor = rows[rows.length - 1]!.t + 1;
      }
    }

    // Older: fixed 500h windows walking backward from the oldest stored row.
    let cursor = b ? b.min : now + 1;
    while (canPage() && cursor > from && (state.hlFloor == null || cursor > state.hlFloor)) {
      pages++;
      const start = cursor - PAGE_SPAN;
      const rows = (await deps.page(coin, start, cursor - 1)).filter((r) => r.t < cursor);
      await deps.upsert(coin, rows);
      if (rows.length === 0) {
        state.hlFloor = cursor; // nothing in a whole 500h window: before listing
        break;
      }
      if (rows[0]!.t - start > 2 * HOUR) state.hlFloor = rows[0]!.t; // window straddles the listing
      cursor = rows[0]!.t;
    }
    state.syncedAt = now;
    state.error = null;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }
  await deps.saveState(state);
  b = await deps.bounds(coin);
  return {
    pages,
    from: b?.min ?? null,
    complete: state.hlFloor != null && b != null && b.min <= state.hlFloor,
  };
}
