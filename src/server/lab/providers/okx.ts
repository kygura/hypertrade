import { z } from "zod";
import { DAY_MS, type DailySeries, type LabProvider } from "../types.js";
import { clip, dayStart, getJson, toDaily, type LabMetricDef } from "./series.js";

// OKX open interest (keyless): daily USD open interest of the coin's OKX USDT-margined perpetual swap, from
// February 2024. It stands in for market positioning because Hyperliquid publishes no OI history (ht:oi is the
// collector's own snapshots, a few weeks deep). It is OKX's book, not Hyperliquid's.
//
// Day alignment (probed 2026-11-11): with period=1Dutc a bar is stamped 00:00 UTC of day D and holds the last
// 5-minute snapshot of D (stamped 23:55), so the value of day D is known at D's close, as the day's close price is:
// lagDays 0. The bar of the current UTC day is still moving (it holds the latest snapshot) and is never returned.
// period=1D bars are stamped 16:00 UTC (the UTC+8 day) and are not used.

export const OKX_OI_URL = "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history";
/** The earliest 1Dutc bar OKX serves (BTC-USDT-SWAP, probed 2026-11-11). */
export const OKX_OI_EPOCH = Date.UTC(2024, 1, 1);
/** Bars per page; pages run newest first and `end` (exclusive) pages back. */
export const OKX_PAGE = 100;
/** OKX allows 5 requests per 2 s per IP on these endpoints: requests are spaced this far apart. */
export const OKX_PACE_MS = 450;
/** OKX's "Instrument ID doesn't exist". */
const NO_INSTRUMENT = "51001";

const OiSchema = z.object({
  code: z.string(),
  msg: z.string().optional(),
  // [ts, oi (contracts), oiCcy (coin), oiUsd]; strings.
  data: z.array(z.array(z.string()).min(4)),
});

/**
 * Hyperliquid's k-prefixed coins are 1000 units of the token; OKX lists the token itself. Open interest in USD does
 * not depend on the unit, so these map to the token's swap. kNEIRO is left out: two tokens trade as NEIRO, and which
 * one OKX's NEIRO-USDT-SWAP is cannot be told from the ticker.
 */
const K_PREFIXED: Record<string, string> = { kPEPE: "PEPE", kSHIB: "SHIB", kBONK: "BONK", kFLOKI: "FLOKI", kLUNC: "LUNC" };

/**
 * OKX instrument for a Hyperliquid coin, or null when it cannot be mapped correctly: an unlisted k-prefixed coin,
 * a 1000-prefixed name (a contract multiple whose OKX counterpart is not known), anything not an uppercase ticker.
 * A ticker OKX does not list maps here and comes back as an empty series.
 */
export function okxInstrument(asset: string): string | null {
  if (Object.prototype.hasOwnProperty.call(K_PREFIXED, asset)) return `${K_PREFIXED[asset]}-USDT-SWAP`;
  if (!/^[A-Z0-9]{1,20}$/.test(asset) || /^1000/.test(asset)) return null;
  return `${asset}-USDT-SWAP`;
}

/** One page → points (USD OI), or null when OKX has no such instrument. Throws on any other API error. Exported for fixture tests. */
export function parseOiPage(json: unknown): Array<{ t: number; v: number }> | null {
  const r = OiSchema.parse(json);
  if (r.code === NO_INSTRUMENT) return null;
  if (r.code !== "0") throw new Error(`okx open interest: code ${r.code}${r.msg ? ` (${r.msg})` : ""}`);
  return r.data.map((row) => ({ t: Number(row[0]), v: Number(row[3]) })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v >= 0);
}

export function oiUrl(inst: string, endMs: number): string {
  return `${OKX_OI_URL}?${new URLSearchParams({ instId: inst, period: "1Dutc", limit: String(OKX_PAGE), end: String(endMs) })}`;
}

const METRICS: LabMetricDef[] = [
  {
    id: "okx:oi",
    provider: "okx",
    key: "oi",
    name: "Open interest (OKX swap)",
    category: "derivatives",
    scope: "asset",
    units: "USD",
    description:
      "USD open interest of the coin's OKX USDT perpetual swap, end of each UTC day (the day's last 5-minute snapshot), since Feb 2024. OKX's market, standing in for positioning: Hyperliquid has no public OI history. kPEPE-style coins map to the token's swap; unmappable coins have none.",
    lagDays: 0,
    stationary: false,
  },
];

export interface OkxDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createOkxProvider(deps: OkxDeps = {}): LabProvider {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Every request of this provider goes through one queue, OKX_PACE_MS apart (a scan loads several coins at once).
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt = -Infinity;
  const paced = <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const wait = lastAt + OKX_PACE_MS - now();
      if (wait > 0) await sleep(wait);
      lastAt = now();
      return f();
    });
    queue = run.catch(() => {});
    return run;
  };

  async function history(inst: string, fromMs: number, toMs: number): Promise<DailySeries> {
    const today = dayStart(now());
    const lo = Math.max(dayStart(fromMs), OKX_OI_EPOCH);
    const points: Array<{ t: number; v: number }> = [];
    // `end` is exclusive: start just after the last day wanted, never past the running day.
    let end = Math.min(dayStart(toMs) + DAY_MS, today);
    while (end > lo) {
      const page = parseOiPage(await paced(() => getJson(oiUrl(inst, end), fetchFn, `okx ${inst}`)));
      if (page === null) return { t: [], v: [] }; // not listed on OKX
      points.push(...page);
      const oldest = Math.min(...page.map((p) => p.t));
      if (page.length < OKX_PAGE || !(oldest < end)) break; // the start of the history, or no progress
      end = oldest;
    }
    return toDaily(points.filter((p) => p.t < today), "last");
  }

  return {
    id: "okx",
    name: "OKX open interest",
    notes:
      "Keyless. rubik/stat/contracts/open-interest-history, period 1Dutc: daily USD open interest of <COIN>-USDT-SWAP since Feb 2024, the day's last 5-minute snapshot; the running day is left out. 100 bars per request, requests 450 ms apart.",
    metrics: () => METRICS,
    async fetch(key, asset, fromMs, toMs) {
      if (key !== "oi") throw new Error(`unknown okx metric: ${key}`);
      const inst = okxInstrument(asset);
      if (!inst) return { t: [], v: [] };
      return clip(await history(inst, fromMs, toMs), fromMs, toMs);
    },
  };
}

export const okxProvider = createOkxProvider();
