import { isExtremesOpportunity, pastCut, type ExtremeEvent, type ExtremeThresholds } from "../../shared/extremes.js";
import type { Alert } from "../desk/notify.js";
import type { RingPoint } from "../platform/features.js";
import { extremesReadyTtlMin, readyTtlMinFor, shouldExpire } from "../platform/opportunity.js";
import { snapshotStreams } from "../platform/replaySource.js";
import type { PlatformStore, ScanSnapshot } from "../platform/store.js";
import { selectUniverse } from "../platform/universe.js";

// The 15-min extremes job (docs/EXTREMES.md; POST /api/cron/extremes): ranks the top coins by their latest stored 24 h
// volume (plus BTC), reads their stored 15-min history (scan_snapshots), runs the detectors, drops keys inside the
// cooldown, keeps a hard daily cap on what goes out, stores every new event first and then delivers the ones under the cap: one
// wake of the research session for the batch, or, when no wake target is set or the wake fails, one push per event
// through the desk notifier. It also expires extremes takes past EXTREMES_READY_TTL_H. The detector runs under the
// latest applied calibration's thresholds (calibrate.ts appliedThresholds; the code defaults when none is applied or
// the row does not parse). Pure orchestration: store, detector, thresholds, wake, notifier and clock are injected.

type Env = Record<string, string | undefined>;
const MIN = 60_000;
const HOUR = 60 * MIN;

const DEFAULT_EXTREMES_TOP = 30;
const DEFAULT_EXTREMES_COOLDOWN_H = 24;
const DEFAULT_EXTREMES_DAILY_CAP = 3;
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
export type Detect = (input: { coin: string; points: RingPoint[]; btc: RingPoint[] | null; now: number }, thresholds: ExtremeThresholds) => ExtremeEvent[];
/** Which thresholds a run used: a stored calibration (029) or the code defaults. */
type ThresholdsSource = { id: number; ranAt: string } | "defaults";

export interface ExtremesJobDeps {
  store: Pick<PlatformStore, "scanSnapshotsSince" | "latestExtreme" | "extremesDeliveredSince" | "insertExtremeEvent" | "setExtremeDelivery" | "listOpportunities" | "transitionOpportunity">;
  detect: Detect;
  /** The thresholds to detect with and where they came from (calibrate.ts appliedThresholds). */
  thresholds: () => Promise<{ thresholds: ExtremeThresholds; source: ThresholdsSource }>;
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
  /** The calibration whose thresholds the detector ran with, or "defaults". */
  calibration: ThresholdsSource;
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
async function expireExtremeTakes(store: Pick<PlatformStore, "listOpportunities" | "transitionOpportunity">, now: number, env?: Env): Promise<number> {
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

  const { thresholds, source } = await deps.thresholds();
  const report: ExtremesJobReport = { coins: coins.length, evaluated: 0, fired: 0, new: 0, woken: 0, pushed: 0, capped: 0, undelivered: 0, expired, calibration: source, lines: [] };
  const fired: ExtremeEvent[] = [];
  for (const coin of coins) {
    const points = coin === "BTC" ? btcPoints : await history(coin);
    if (!points.length) continue;
    report.evaluated++;
    fired.push(...deps.detect({ coin, points, btc, now }, thresholds));
  }
  report.fired = fired.length;

  // Strongest first, by how far each event is past its own kind's cut (shared/extremes.ts pastCut): raw severities are z-scores
  // of different quantities against different cuts, so sorting on them let crowded_asymmetry take the daily cap.
  // One event per key per run; a key inside its cooldown (measured between bar times) is dropped.
  const fresh: ExtremeEvent[] = [];
  const seen = new Set<string>();
  const rank = new Map(fired.map((e) => [e, pastCut(e, thresholds)]));
  const strength = (e: ExtremeEvent) => (Number.isFinite(rank.get(e)) ? rank.get(e)! : 0);
  for (const e of [...fired].sort((a, b) => strength(b) - strength(a) || (a.key < b.key ? -1 : 1))) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    const last = await deps.store.latestExtreme(e.key);
    if (last && Date.parse(e.ts) < Date.parse(last.event.ts) + p.cooldownMs) continue;
    fresh.push(e);
  }
  if (!fresh.length) return report;

  // Hard daily cap (UTC day, bar time): over it an event is stored with delivery none and nothing is sent.
  const room = Math.max(0, p.dailyCap - (await deps.store.extremesDeliveredSince(utcDayStart(now))));
  // The record is stored before anything is sent and is the claim: (key, ts) is the primary key, so of two overlapping
  // runs only one stores a given event and only that one sends it. An event whose write fails is not sent (a lost alert
  // over a repeat); the next run's cooldown check finds it unstored and tries again.
  // ponytail: runs that see different bar ts for one key would both claim; the route's lease (routes/extremes.ts, the only caller) keeps runs apart unless one outlives it. Add a per-key claim if that shows up.
  const claimed: ExtremeEvent[] = [];
  for (const e of fresh) {
    const stored = await deps.store
      .insertExtremeEvent({ event: e, delivery: "none", verdict: null, verdictAt: null, verdictMark: null, opportunityId: null })
      .catch((err) => (console.error("[extremes] store:", err instanceof Error ? err.message : err), false));
    if (!stored) continue;
    claimed.push(e);
    report.lines.push(e.line);
  }
  report.new = claimed.length;
  const send = claimed.slice(0, room);
  report.capped = claimed.length - send.length;
  if (!send.length) return report;

  // Delivery is written after the send. A failed send or write leaves the record at none: never retried, the cooldown holds.
  const mark = (e: ExtremeEvent, delivery: "woken" | "pushed") =>
    deps.store.setExtremeDelivery(e.key, e.ts, delivery).catch((err) => (console.error("[extremes] delivery:", err instanceof Error ? err.message : err), false));
  const woke = await deps.wake(send).catch(() => false);
  for (const e of send) {
    if (woke) {
      await mark(e, "woken");
      report.woken++;
      continue;
    }
    // Fallback: one push per event.
    const channels = await deps.notifier.send(extremeAlert(e, deps.appUrl)).catch((err) => (console.error("[extremes] push:", err instanceof Error ? err.message : err), [] as string[]));
    if (channels.length) {
      await mark(e, "pushed");
      report.pushed++;
    } else report.undelivered++;
  }
  return report;
}
