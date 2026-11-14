import { isExtremesOpportunity, type ExtremeEvent, type ExtremeRecord } from "../../shared/extremes.js";
import type { Alert } from "../desk/notify.js";
import type { RingPoint } from "../platform/features.js";
import { extremesReadyTtlMin, readyTtlMinFor, shouldExpire } from "../platform/opportunity.js";
import { snapshotStreams } from "../platform/replaySource.js";
import type { PlatformStore, ScanSnapshot } from "../platform/store.js";
import { selectUniverse } from "../platform/universe.js";

// The 15-min extremes job (docs/EXTREMES.md; POST /api/cron/extremes): ranks the top coins by their latest stored 24 h
// volume (plus BTC), reads their stored 15-min history (scan_snapshots), runs the detectors, drops keys inside the
// cooldown, keeps a hard daily cap on what goes out, stores every new event and delivers the ones under the cap: one
// wake of the research session for the batch, or, when no wake target is set or the wake fails, one push per event
// through the desk notifier. It also expires extremes takes past EXTREMES_READY_TTL_H. Pure orchestration: store, detector, wake, notifier and clock are injected.

type Env = Record<string, string | undefined>;
const MIN = 60_000;
const HOUR = 60 * MIN;

export const DEFAULT_EXTREMES_TOP = 30;
export const DEFAULT_EXTREMES_COOLDOWN_H = 24;
export const DEFAULT_EXTREMES_DAILY_CAP = 3;
/** Snapshots read to rank coins by their latest 24 h volume (the tick persists one every 5 min). */
export const RANK_WINDOW_MS = HOUR;

const posInt = (v: string | undefined, d: number) => {
  const n = Number(v?.trim());
  return v?.trim() && Number.isInteger(n) && n >= 0 ? n : d;
};
export const extremesParams = (env: Env = process.env) => ({
  top: posInt(env.EXTREMES_TOP, DEFAULT_EXTREMES_TOP) || DEFAULT_EXTREMES_TOP,
  cooldownMs: posInt(env.EXTREMES_COOLDOWN_H, DEFAULT_EXTREMES_COOLDOWN_H) * HOUR,
  dailyCap: posInt(env.EXTREMES_DAILY_CAP, DEFAULT_EXTREMES_DAILY_CAP),
});

/** The detector's input (src/server/extremes/detect.ts DetectInput), stated here so the job does not import the detector. */
export type Detect = (input: { coin: string; points: RingPoint[]; btc: RingPoint[] | null; now: number }) => ExtremeEvent[];

export interface ExtremesJobDeps {
  store: Pick<PlatformStore, "scanSnapshotsSince" | "latestExtreme" | "extremesDeliveredSince" | "insertExtremeEvent" | "listOpportunities" | "transitionOpportunity">;
  detect: Detect;
  /** History each coin's detector reads (EXTREME_LOOKBACK_MS). */
  lookbackMs: number;
  wake: (events: ExtremeEvent[]) => Promise<boolean>;
  notifier: { send(a: Alert): Promise<string[]> };
  appUrl: string | null;
  now: () => number;
  env?: Env;
}

export interface ExtremesJobReport {
  coins: number;
  evaluated: number;
  fired: number;
  new: number;
  woken: number;
  pushed: number;
  capped: number;
  /** Delivery attempted and nothing went out (every push channel failed or none is configured). */
  undelivered: number;
  /** Extremes takes moved ready -> expired past EXTREMES_READY_TTL_H (the scanner does the same where it runs). */
  expired: number;
  lines: string[];
}

/** The fallback push for one event: facts only, a link to the coin page. */
export function extremeAlert(e: ExtremeEvent, appUrl: string | null): Alert {
  const base = appUrl?.trim().replace(/\/+$/, "");
  return { level: "info", title: `Extreme: ${e.coin} ${e.kind}`, body: e.line, ...(base ? { click: `${base}/coin/${encodeURIComponent(e.coin)}` } : {}) };
}

/** Each coin's latest snapshot with a finite 24 h volume (ranking, liquidity tiers): its time, volume and inputs. */
export function latestVolumes(snaps: ScanSnapshot[]): Map<string, { ts: number; dayNtlVlm: number; inputs: Record<string, unknown> }> {
  const vol = new Map<string, { ts: number; dayNtlVlm: number; inputs: Record<string, unknown> }>();
  for (const s of snaps) {
    const v = (s.inputs as Record<string, unknown>).dayNtlVlm;
    const ts = Date.parse(s.ts);
    if (typeof v === "number" && Number.isFinite(v) && ts >= (vol.get(s.coin)?.ts ?? -Infinity)) vol.set(s.coin, { ts, dayNtlVlm: v, inputs: s.inputs });
  }
  return vol;
}

const utcDayStart = (t: number) => {
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
};

/**
 * Expires extremes takes past their ready TTL (platform/opportunity.ts readyTtlMinFor). Here as well as in the scanner
 * because the serverless API has no scanner; both are compare-and-set moves, so two runners never double-expire.
 */
export async function expireExtremeTakes(store: Pick<PlatformStore, "listOpportunities" | "transitionOpportunity">, now: number, env?: Env): Promise<number> {
  const ttl = { scannerMin: Infinity, extremesMin: extremesReadyTtlMin(env) };
  let n = 0;
  for (const o of await store.listOpportunities({ statuses: ["ready"], limit: 500 })) {
    if (!isExtremesOpportunity(o) || !shouldExpire(o, new Date(now), readyTtlMinFor(o, ttl))) continue;
    if (await store.transitionOpportunity(o.id, "ready", "expired", "system")) n++;
  }
  return n;
}

export async function runExtremesJob(deps: ExtremesJobDeps): Promise<ExtremesJobReport> {
  const now = deps.now();
  const p = extremesParams(deps.env);
  const iso = (t: number) => new Date(t).toISOString();
  const expired = await expireExtremeTakes(deps.store, now, deps.env).catch((err) => (console.error("[extremes] expiry:", err instanceof Error ? err.message : err), 0));

  // Universe: the top N by the latest stored 24 h volume, plus BTC (the detectors' market reference).
  const vol = latestVolumes(await deps.store.scanSnapshotsSince(iso(now - RANK_WINDOW_MS)));
  const coins = selectUniverse([...vol].map(([coin, x]) => ({ coin, dayNtlVlm: x.dayNtlVlm })), { top: p.top, mine: ["BTC"] }).map((c) => c.coin);
  // One coin's history at a time (30 days of snapshots per coin), so the read never holds the whole universe at once.
  const since = iso(now - deps.lookbackMs);
  const history = async (coin: string) => snapshotStreams(await deps.store.scanSnapshotsSince(since, [coin])).get(coin) ?? [];
  const btcPoints = coins.includes("BTC") ? await history("BTC") : [];
  const btc = btcPoints.length ? btcPoints : null;

  const report: ExtremesJobReport = { coins: coins.length, evaluated: 0, fired: 0, new: 0, woken: 0, pushed: 0, capped: 0, undelivered: 0, expired, lines: [] };
  const fired: ExtremeEvent[] = [];
  for (const coin of coins) {
    const points = coin === "BTC" ? btcPoints : await history(coin);
    if (!points.length) continue;
    report.evaluated++;
    fired.push(...deps.detect({ coin, points, btc, now }));
  }
  report.fired = fired.length;

  // Strongest first; one event per key per run; a key inside its cooldown (measured between bar times) is dropped.
  const fresh: ExtremeEvent[] = [];
  const seen = new Set<string>();
  for (const e of [...fired].sort((a, b) => b.severity - a.severity || (a.key < b.key ? -1 : 1))) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    const last = await deps.store.latestExtreme(e.key);
    if (last && Date.parse(e.ts) < Date.parse(last.event.ts) + p.cooldownMs) continue;
    fresh.push(e);
  }
  report.new = fresh.length;
  if (!fresh.length) return report;

  // Hard daily cap (UTC day, bar time): over it an event is stored with delivery none and nothing is sent.
  const room = Math.max(0, p.dailyCap - (await deps.store.extremesDeliveredSince(utcDayStart(now))));
  const send = fresh.slice(0, room);
  const delivery = new Map<ExtremeEvent, ExtremeRecord["delivery"]>(fresh.map((e) => [e, "none"]));
  report.capped = fresh.length - send.length;

  if (send.length) {
    const woke = await deps.wake(send).catch(() => false);
    for (const e of send) {
      if (woke) {
        delivery.set(e, "woken");
        report.woken++;
        continue;
      }
      // Fallback: one push per event. Sent before the record is stored, and the stored record is what stops a repeat.
      const channels = await deps.notifier.send(extremeAlert(e, deps.appUrl)).catch((err) => (console.error("[extremes] push:", err instanceof Error ? err.message : err), [] as string[]));
      if (channels.length) {
        delivery.set(e, "pushed");
        report.pushed++;
      } else report.undelivered++;
    }
  }

  for (const e of fresh) {
    await deps.store.insertExtremeEvent({ event: e, delivery: delivery.get(e)!, verdict: null, verdictAt: null, verdictMark: null, opportunityId: null });
    report.lines.push(e.line);
  }
  return report;
}
