import type { ExposurePosition, ManualPosition, PositionSourceStatus, PositionsResponse } from "../../shared/intel.js";
import { loadDeskConfig } from "../desk/config.js";
import { readHlAccount } from "../desk/data.js";
import type { AccountState } from "../desk/types.js";
import type { IntelStore } from "./store.js";
import { message } from "./ingest/common.js";

// Three position sources unified at read time (SPEC.md § Intel I0.2):
// manual (intel_positions), hl (the watched address, read-only) and desk
// (the Desk's paper/testnet book). A source that fails is reported in
// `sources` and contributes nothing; loadExposure never throws.

export interface ExposureDeps {
  store: Pick<IntelStore, "listManualPositions">;
  /** Mark prices by asset for manual positions; missing assets fall back to entry. */
  marks(assets: string[]): Promise<Record<string, number>>;
  /** DESK_WATCH_ADDRESS (validated by loadDeskConfig); unset → hl reported as not configured. */
  watchAddress?: string;
  /** DeskService.account, injected so this module never constructs the service. */
  deskAccount?: () => Promise<AccountState>;
  readHl?: (address: string) => Promise<AccountState>;
}

function fromManual(p: ManualPosition, mark: number | undefined): ExposurePosition {
  const px = mark != null && Number.isFinite(mark) && mark > 0 ? mark : null;
  const sign = p.side === "long" ? 1 : -1;
  return {
    id: p.id,
    source: "manual",
    asset: p.asset,
    side: p.side,
    size: p.size,
    entryPx: p.entryPx,
    markPx: px ?? p.entryPx,
    stopPx: p.stopPx,
    leverage: p.leverage,
    venue: p.venue,
    notionalUsd: p.size * (px ?? p.entryPx),
    unrealizedPnl: px == null ? null : sign * (px - p.entryPx) * p.size,
  };
}

/** Account positions; leverage is the position's notional over account equity (the venue does not report it per position here). */
function fromAccount(source: "hl" | "desk", acct: AccountState): ExposurePosition[] {
  return acct.positions.map((p) => ({
    id: `${source}:${p.coin}`,
    source,
    asset: p.coin,
    side: p.side,
    size: p.size,
    entryPx: p.entryPx,
    markPx: p.markPx,
    stopPx: p.stopPx,
    leverage: acct.equityUsd > 0 ? p.notionalUsd / acct.equityUsd : 1,
    venue: acct.venue,
    notionalUsd: p.notionalUsd,
    unrealizedPnl: p.unrealizedPnl,
  }));
}

async function readAccount(source: "hl" | "desk", read: () => Promise<AccountState>): Promise<{ status: PositionSourceStatus; positions: ExposurePosition[] }> {
  try {
    const acct = await read();
    if (!acct.available) return { status: { source, ok: false, error: acct.note ?? "account unavailable" }, positions: [] };
    return { status: { source, ok: true }, positions: fromAccount(source, acct) };
  } catch (err) {
    return { status: { source, ok: false, error: message(err) }, positions: [] };
  }
}

async function readManual(deps: ExposureDeps): Promise<{ status: PositionSourceStatus; positions: ExposurePosition[] }> {
  let rows: ManualPosition[];
  try {
    rows = await deps.store.listManualPositions();
  } catch (err) {
    return { status: { source: "manual", ok: false, error: message(err) }, positions: [] };
  }
  if (!rows.length) return { status: { source: "manual", ok: true }, positions: [] };
  let marks: Record<string, number> = {};
  let error: string | undefined;
  try {
    marks = await deps.marks([...new Set(rows.map((r) => r.asset))]);
  } catch (err) {
    // Positions still count (at entry price); the missing marks are said out loud.
    error = `marks unavailable: ${message(err)}`;
  }
  const status: PositionSourceStatus = error ? { source: "manual", ok: true, error } : { source: "manual", ok: true };
  return { status, positions: rows.map((r) => fromManual(r, marks[r.asset])) };
}

export async function loadExposure(deps: ExposureDeps): Promise<PositionsResponse> {
  const address = deps.watchAddress;
  const readHl = deps.readHl ?? ((a: string) => readHlAccount(a));
  const notConfigured = (source: "hl" | "desk", what: string) => ({ status: { source, ok: false, error: `${what} not configured` }, positions: [] });
  const parts = await Promise.all([
    readManual(deps),
    address ? readAccount("hl", () => readHl(address)) : notConfigured("hl", "DESK_WATCH_ADDRESS"),
    deps.deskAccount ? readAccount("desk", deps.deskAccount) : notConfigured("desk", "desk account"),
  ]);
  const positions = parts.flatMap((p) => p.positions);
  return {
    positions,
    sources: parts.map((p) => p.status),
    totalNotionalUsd: positions.reduce((s, p) => s + Math.abs(p.notionalUsd), 0),
  };
}

/** Watched assets: intel_watchlist, or DESK_WATCHLIST when it is empty. */
export async function watchedAssets(store: Pick<IntelStore, "getWatchlist">, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const items = await store.getWatchlist();
  return items.length ? items.map((i) => i.asset) : loadDeskConfig(env).watchlist;
}
