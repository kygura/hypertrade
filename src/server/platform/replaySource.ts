import { fetchCandles, fetchFundingPage, fetchPerpMetaAndCtxs, HL_FUNDING_PAGE, HL_MAX_CANDLES, createHlShare, type FundingPoint } from "../../shared/hl-client.js";
import type { ReplaySource, SetupReplayResponse } from "../../shared/research.js";
import type { Candle } from "../../shared/types.js";
import { databaseUrl, getFunding } from "../db.js";
import { DEFAULT_TAKER_FEE_BPS } from "./costs.js";
import { FEATURE_MIN_TICKS_24H, type RingPoint } from "./features.js";
import { parseHorizons } from "./outcomes.js";
import { DEFAULT_OUTCOME_HORIZONS } from "./outcomesLoop.js";
import { replayEntriesAsync, RING_MS, summarise, type StreamInput } from "./replay.js";
import { isServerless, needsAlwaysOn } from "./runtime.js";
import { DEFAULT_COOLDOWN_MIN, DEFAULT_READY_TTL_MIN, envNum, PERSIST_MS } from "./scanner.js";
import { scanRetentionDays, type PlatformStore, type ScanSnapshot } from "./store.js";
import { selectUniverse } from "./universe.js";

// Ring-point streams for the setup replay (replay.ts) and the memoised background service behind
// GET /api/research/setups/replay and `bun run signals:replay`.
//   candles    HL 15-min candles (the latest 5000, about 52 days) + hourly funding; no OI, book or liquidations.
//   snapshots  stored scan_snapshots (mark, OI, funding, 24 h volume), when dense enough for the features; the top
//              coins by 24 h volume only, over at most SNAPSHOT_REPLAY_MAX_DAYS.
// Both run only on the always-on server or the CLI: a serverless function (Vercel) ends before a replay does.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const GRID_MS = 15 * MIN;
export const GRID = "15m";
/** Coins a replay covers by default: the most liquid by 24 h volume. About 230 HL weight each for candles (one candle page, three funding pages), so 20 coins take about 5 min under the 1000/min guard. */
export const DEFAULT_REPLAY_TOP = 20;
/** Days of scan_snapshots a snapshot replay reads at most (the retention may keep more). */
export const SNAPSHOT_REPLAY_MAX_DAYS = 14;
/** A snapshot exit is graded at the first stored tick at most this long after entry + horizon: one persist step, plus the scanner's 1-min tick spacing (a tick a few ms early leaves the next one a full step later). */
export const SNAPSHOT_GRADE_TOLERANCE_MS = PERSIST_MS + MIN;
/** Trailing-60s HL weight the replay's own fetches stay under (of the guard's 1000): the live scanner keeps the rest. */
export const REPLAY_HL_BUDGET = 600;
/** A candle replay that loaded fewer than this share of its coins failed (a fetch outage), and is retried, never shown as zeros. */
export const REPLAY_MIN_LOADED_SHARE = 0.5;

/**
 * Ring points from 15-min candles: one per closed candle at its close boundary (t + 15 min). mark = close;
 * dayNtlVlm = sum of volume × close over the candles of the trailing 24 h (NaN until the stream has 24 h behind
 * it); funding = the hourly rate of the latest settlement at or before the point (NaN before the first); oiUsd NaN
 * (candles carry no OI, so oiChg1hZ and liqPressure stay null).
 */
export function candleStream(candles: Candle[], funding: FundingPoint[]): RingPoint[] {
  const cs = [...candles].filter((c) => Number.isFinite(c.c) && c.c > 0).sort((a, b) => a.t - b.t);
  const fs = [...funding].filter((f) => Number.isFinite(f.rate)).sort((a, b) => a.t - b.t);
  const out: RingPoint[] = [];
  let lo = 0;
  let sum = 0;
  let fi = -1;
  const first = cs[0]?.t;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    const ts = c.t + GRID_MS;
    sum += (Number.isFinite(c.v) ? c.v : 0) * c.c;
    while (cs[lo]!.t + GRID_MS <= ts - DAY) sum -= (Number.isFinite(cs[lo]!.v) ? cs[lo]!.v : 0) * cs[lo]!.c, lo++;
    while (fi + 1 < fs.length && fs[fi + 1]!.t <= ts) fi++;
    out.push({ ts, mark: c.c, oiUsd: NaN, funding: fi >= 0 ? fs[fi]!.rate : NaN, dayNtlVlm: ts - first! >= DAY ? sum : NaN });
  }
  return out;
}

/** Ring points from stored scan snapshots (the scanner's own seed parse: every input finite, or the row is skipped). */
export function snapshotStreams(rows: ScanSnapshot[]): Map<string, RingPoint[]> {
  const m = new Map<string, Map<number, RingPoint>>();
  for (const s of rows) {
    const { mark, oiUsd, funding, dayNtlVlm } = s.inputs as Record<string, unknown>;
    const ts = Date.parse(s.ts);
    if (![ts, mark, oiUsd, funding, dayNtlVlm].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    (m.get(s.coin) ?? m.set(s.coin, new Map()).get(s.coin)!).set(ts, { ts, mark: mark as number, oiUsd: oiUsd as number, funding: funding as number, dayNtlVlm: dayNtlVlm as number });
  }
  return new Map([...m].map(([coin, pts]) => [coin, [...pts.values()].sort((a, b) => a.ts - b.ts)]));
}

/**
 * Distinct snapshot timestamps per 24 h over the stored history, newest window first (whole 24 h windows ending at
 * `to`). Dense = the median window reaches FEATURE_MIN_TICKS_24H.
 */
export function snapshotDensity(rows: ScanSnapshot[], to: number): { windows: number; medianTicks: number; dense: boolean } {
  const ts = [...new Set(rows.map((r) => Date.parse(r.ts)).filter(Number.isFinite))];
  if (!ts.length) return { windows: 0, medianTicks: 0, dense: false };
  const windows = Math.max(1, Math.floor((to - Math.min(...ts)) / DAY));
  const counts = Array.from({ length: windows }, (_, i) => ts.filter((t) => t <= to - i * DAY && t > to - (i + 1) * DAY).length).sort((a, b) => a - b);
  const medianTicks = counts[Math.floor(counts.length / 2)]!;
  return { windows, medianTicks, dense: medianTicks >= FEATURE_MIN_TICKS_24H };
}

export interface ReplayParams {
  horizons: string[];
  readyTtlMin: number;
  cooldownMin: number;
  feeBps: number;
}
export const replayParams = (env: Record<string, string | undefined> = process.env): ReplayParams => ({
  horizons: parseHorizons(env.PLATFORM_OUTCOME_HORIZONS?.trim() || DEFAULT_OUTCOME_HORIZONS),
  readyTtlMin: envNum("PLATFORM_READY_TTL_MIN", DEFAULT_READY_TTL_MIN),
  cooldownMin: envNum("PLATFORM_COOLDOWN_MIN", DEFAULT_COOLDOWN_MIN),
  feeBps: DEFAULT_TAKER_FEE_BPS,
});

const iso = (t: number) => new Date(t).toISOString();
const empty = (source: ReplaySource, now: number, p: ReplayParams) => ({ asOf: iso(now), source, window: null, coins: [], grid: GRID, horizons: p.horizons, assumptions: [], setups: [] });
/** A replay answer that ran nothing, with the reason. */
export const replayUnavailable = (source: ReplaySource, reason: string, now = Date.now(), env: Record<string, string | undefined> = process.env): SetupReplayResponse => ({ state: "unavailable", reason, ...empty(source, now, replayParams(env)) });

/** What every replay states, whatever the source. */
function commonFacts(p: ReplayParams): string[] {
  return [
    "tests the shipped setup predicate (the scanner's evaluateTick) with the scanner's dedupe, ready TTL and cooldown; a replay of fixed predicates, not a Lab trial",
    "does not test the score (it orders candidates and picks the costed top N, never gates creation), operator decisions, or book-based costs",
    `every fired idea assumed costed and undecided: ready at creation, expired after ${p.readyTtlMin} min, cooldown ${p.cooldownMin} min after expiry`,
    "live differs: an idea the scanner does not cost (beyond PLATFORM_COST_TOP_N by score, or no book) stays new, never expires and blocks its key from firing again, so live can fire fewer re-entries than this replay counts",
    `costs: taker fee ${p.feeBps} bps each way, slippage 0 (no historical book), funding = hourly rate at entry × horizon hours`,
  ];
}

/** Steps where a coin may enter: from 24 h after the stream's first point (a full ring) to its last point. */
function gridOf(streams: Map<string, RingPoint[]>, stepMs: number | null): number[] {
  const all = [...streams.values()].flat().map((p) => p.ts);
  if (!all.length) return [];
  const from = Math.min(...all) + RING_MS;
  const to = Math.max(...all);
  if (stepMs) {
    const out: number[] = [];
    for (let t = Math.ceil(from / stepMs) * stepMs; t <= to; t += stepMs) out.push(t);
    return out;
  }
  return [...new Set(all)].filter((t) => t >= from).sort((a, b) => a - b);
}

/** The replay over the streams; yields to the event loop between slices of steps (replayEntriesAsync). */
async function result(source: ReplaySource, now: number, p: ReplayParams, streams: Map<string, RingPoint[]>, grid: number[], missing: StreamInput[], facts: string[], toleranceMs: number, tierContext?: Array<{ coin: string; dayNtlVlm: number }>): Promise<SetupReplayResponse> {
  const entries = await replayEntriesAsync({ streams, grid, tierContext, readyTtlMs: p.readyTtlMin * MIN, cooldownMs: p.cooldownMin * MIN });
  return {
    state: "ok", asOf: iso(now), source,
    window: grid.length ? { from: iso(grid[0]!), to: iso(grid.at(-1)!) } : null,
    coins: [...streams.keys()], grid: source === "candles" ? GRID : "stored ticks", horizons: p.horizons,
    assumptions: [...commonFacts(p), ...facts],
    setups: summarise({ entries, streams, horizons: p.horizons, missing, feeBps: p.feeBps, toleranceMs }),
  };
}

export interface CandleReplayDeps {
  /** Live coins with their 24 h volume (the universe and the tier context). */
  universe: () => Promise<Array<{ coin: string; dayNtlVlm: number }>>;
  candles: (coin: string, startMs: number, endMs: number) => Promise<Candle[]>;
  /** Hourly funding settlements in [startMs, endMs]. */
  funding: (coin: string, startMs: number, endMs: number) => Promise<FundingPoint[]>;
  now: () => number;
  top: number;
  params: ReplayParams;
  log?: (msg: string) => void;
}

/**
 * Candle replay: the `top` coins by current 24 h volume, the latest HL_MAX_CANDLES 15-min candles each (about 52
 * days), funding over the same span. A coin whose fetch fails is dropped and named in the facts.
 */
export async function runCandleReplay(d: CandleReplayDeps): Promise<SetupReplayResponse> {
  const now = d.now();
  const end = Math.floor(now / GRID_MS) * GRID_MS; // last closed candle boundary
  const start = end - HL_MAX_CANDLES * GRID_MS;
  const live = await d.universe();
  const coins = selectUniverse(live, { top: d.top }).map((c) => c.coin);
  const streams = new Map<string, RingPoint[]>();
  const dropped: string[] = [];
  for (const [i, coin] of coins.entries()) {
    try {
      const [cs, fs] = [await d.candles(coin, start, end - 1), await d.funding(coin, start - HOUR, end)];
      const pts = candleStream(cs.filter((c) => c.t + GRID_MS <= end), fs);
      if (pts.length) streams.set(coin, pts);
      else dropped.push(coin);
      d.log?.(`${i + 1}/${coins.length} ${coin}: ${cs.length} candles, ${fs.length} funding`);
    } catch (err) {
      dropped.push(coin);
      d.log?.(`${i + 1}/${coins.length} ${coin}: dropped (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  // A fetch outage is a failed run (the service retries it), never a replay of nothing shown as zero entries.
  if (!streams.size || streams.size < REPLAY_MIN_LOADED_SHARE * coins.length) {
    throw new Error(`candle replay loaded ${streams.size} of ${coins.length} coins (dropped: ${dropped.join(", ") || "none"})`);
  }
  const facts = [
    `universe: top ${d.top} HL perps by 24 h volume now (survivors of today; ${streams.size} replayed)`,
    "15-min HL candles: mark = close at the candle's close; 24 h volume = trailing sum of volume × close",
    "exit at the stream's mark at exactly entry + horizon (on the 15-min grid); an entry with no point there is not graded at that horizon",
    "funding = the latest hourly settlement at or before each step (the live scanner reads the current predicted rate)",
    "no intraday OI, book or liquidation data: setups reading those features are not evaluable",
    "on the 15-min grid the 1 h realized vol rests on 4 returns (the live 1-min ring has 60)",
    "liquidity tiers rank each step's 24 h volume against every other live coin's 24 h volume now",
    ...(dropped.length ? [`dropped (fetch failed or empty): ${dropped.join(", ")}`] : []),
  ];
  const context = live.filter((c) => !streams.has(c.coin));
  return result("candles", now, d.params, streams, gridOf(streams, GRID_MS), ["oi", "book", "liquidations"], facts, 0, context);
}

/**
 * Snapshot replay over stored scan_snapshots: the `top` coins by their latest stored 24 h volume (ranked from the
 * last 24 h of snapshots), over the last min(sinceDays, SNAPSHOT_REPLAY_MAX_DAYS) days, so the read and the replay
 * stay bounded whatever the retention holds. `unavailable` with the numbers when the snapshots are too sparse.
 */
export async function runSnapshotReplay(d: { store: Pick<PlatformStore, "scanSnapshotsSince">; now: () => number; sinceDays: number; params: ReplayParams; top?: number }): Promise<SetupReplayResponse> {
  const now = d.now();
  const top = d.top ?? DEFAULT_REPLAY_TOP;
  const days = Math.min(d.sinceDays, SNAPSHOT_REPLAY_MAX_DAYS);
  const vol = new Map<string, { ts: number; dayNtlVlm: number }>();
  for (const s of await d.store.scanSnapshotsSince(iso(now - DAY))) {
    const v = (s.inputs as Record<string, unknown>).dayNtlVlm;
    const ts = Date.parse(s.ts);
    if (typeof v === "number" && Number.isFinite(v) && ts >= (vol.get(s.coin)?.ts ?? -Infinity)) vol.set(s.coin, { ts, dayNtlVlm: v });
  }
  const ranked = [...vol].map(([coin, x]) => ({ coin, dayNtlVlm: x.dayNtlVlm }));
  const coins = selectUniverse(ranked, { top }).map((c) => c.coin);
  const rows = coins.length ? await d.store.scanSnapshotsSince(iso(now - days * DAY), coins) : [];
  const dens = snapshotDensity(rows, now);
  if (!dens.dense) {
    return {
      state: "unavailable", ...empty("snapshots", now, d.params),
      reason: `too sparse: median ${dens.medianTicks} scanner ticks per 24 h over ${dens.windows} day(s) of scan_snapshots; the features need ${FEATURE_MIN_TICKS_24H} (one per 15 min)`,
    };
  }
  const streams = snapshotStreams(rows);
  const facts = [
    `universe: top ${top} coins by their latest stored 24 h volume (${streams.size} replayed); stored scan_snapshots, last ${days} days (median ${dens.medianTicks} ticks per 24 h); OI present, no book or liquidation history`,
    `snapshots are the scanner's 1-min ring persisted every ${PERSIST_MS / MIN} min: the replay's ring has a point per ${PERSIST_MS / MIN} min where the live ring has one per minute (the 1 h realized vol rests on ${60 / (PERSIST_MS / MIN)} returns, not 60)`,
    `exit at the first stored tick in [entry + horizon, entry + horizon + ${SNAPSHOT_GRADE_TOLERANCE_MS / MIN} min] (tick timestamps are the scanner's clock, not a grid): never before the horizon, at most one persist step and a minute after it`,
    "liquidity tiers rank each step's 24 h volume against the other replayed coins' and every other stored coin's latest 24 h volume",
  ];
  const context = ranked.filter((c) => !streams.has(c.coin));
  return result("snapshots", now, d.params, streams, gridOf(streams, null), ["book", "liquidations"], facts, SNAPSHOT_GRADE_TOLERANCE_MS, context);
}

// ---------------------------------------------------------------- fetch memo and default deps

/** Coins whose series a memoSeries keeps; the least recently used goes past this. */
export const MEMO_SERIES_COINS = 2 * DEFAULT_REPLAY_TOP;

/**
 * In-process memo of a t-keyed series per coin: a later call whose range starts inside the range already fetched
 * asks only from the newest cached point on (coverage is the range asked, not the first point held: a series whose
 * first point sits after the range start, as hourly funding does, is not refetched in full). At most `maxCoins`
 * coins are kept, least recently used out first.
 */
export function memoSeries<T extends { t: number }>(fetch: (coin: string, startMs: number, endMs: number) => Promise<T[]>, maxCoins = MEMO_SERIES_COINS) {
  const cache = new Map<string, { from: number; rows: T[] }>();
  return async (coin: string, startMs: number, endMs: number): Promise<T[]> => {
    const held = cache.get(coin);
    const have = held && held.from <= startMs ? held.rows : [];
    const from = have.length ? have.at(-1)!.t : startMs; // refetch the newest (it may have been open)
    const got = from > endMs ? [] : await fetch(coin, from, endMs);
    const merged = new Map<number, T>([...have, ...got].map((x) => [x.t, x]));
    const rows = [...merged.values()].filter((x) => x.t >= startMs).sort((a, b) => a.t - b.t);
    cache.delete(coin);
    cache.set(coin, { from: startMs, rows });
    while (cache.size > maxCoins) cache.delete(cache.keys().next().value!);
    return rows.filter((x) => x.t <= endMs);
  };
}

/** The replay's share of the HL guard, and the most one of its requests weighs (a full funding page, a full candle page). */
const replayShare = createHlShare(REPLAY_HL_BUDGET);
const REPLAY_FUNDING_WEIGHT = 20 + Math.ceil(HL_FUNDING_PAGE / 20);
const REPLAY_CANDLE_WEIGHT = 20 + Math.ceil(HL_MAX_CANDLES / 60);

/** fundingHistory pages forward from startMs (500 rows each). */
async function liveFunding(coin: string, startMs: number, endMs: number): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  for (let cursor = startMs; cursor < endMs; ) {
    await replayShare(REPLAY_FUNDING_WEIGHT);
    const rows = await fetchFundingPage(coin, cursor, endMs);
    out.push(...rows);
    if (rows.length < HL_FUNDING_PAGE) break;
    cursor = rows.at(-1)!.t + 1;
  }
  return out;
}

// The replay's own HL requests stay under REPLAY_HL_BUDGET, so the live scanner (same process, same guard) keeps a share.
const candleMemo = memoSeries(async (coin, s, e) => (await replayShare(REPLAY_CANDLE_WEIGHT), fetchCandles(coin, "15m", s, e)));
const fundingMemo = memoSeries(liveFunding);

/**
 * Stored funding (the `funding` table) when a database is configured and it covers at least 95% of the span's hours,
 * else HL fundingHistory (memoised in process).
 */
async function fundingFor(coin: string, startMs: number, endMs: number): Promise<FundingPoint[]> {
  if (databaseUrl()) {
    try {
      const rows = (await getFunding(coin, new Date(startMs), new Date(endMs))).map((r) => ({ t: new Date(r.ts).getTime(), rate: Number(r.rate), premium: Number(r.premium) }));
      if (rows.length >= 0.95 * ((endMs - startMs) / HOUR)) return rows;
    } catch (err) {
      console.error(`[replay] stored funding ${coin}:`, err instanceof Error ? err.message : err);
    }
  }
  return fundingMemo(coin, startMs, endMs);
}

export const defaultCandleDeps = (o: { top?: number; env?: Record<string, string | undefined>; log?: (m: string) => void } = {}): CandleReplayDeps => ({
  universe: async () => (await fetchPerpMetaAndCtxs()).ctxs.filter((c) => !c.isDelisted && c.markPx > 0).map((c) => ({ coin: c.name, dayNtlVlm: c.dayNtlVlm })),
  candles: candleMemo,
  funding: fundingFor,
  now: Date.now,
  top: o.top ?? envNum("PLATFORM_REPLAY_TOP", DEFAULT_REPLAY_TOP),
  params: replayParams(o.env),
  log: o.log,
});

// ---------------------------------------------------------------- background service

export type ServiceAnswer<T> = { state: "ok"; value: T } | { state: "pending" } | { state: "failed" };

/**
 * One background run at a time, memoised for `ttlMs`. get() never waits longer than `waitMs`: before the first
 * result it answers `pending`; a stale result is served while a refresh runs; a failed run with nothing to serve is
 * `failed` until `retryMs` has passed, then retried.
 */
export function createReplayService<T>(o: { run: () => Promise<T>; now: () => number; ttlMs: number; retryMs: number; waitMs: number }) {
  let memo: { at: number; value: T } | null = null;
  let running: Promise<void> | null = null;
  let failedAt: number | null = null;
  const start = () => {
    running = o.run().then(
      (value) => void ((memo = { at: o.now(), value }), (failedAt = null)),
      (err) => void ((failedAt = o.now()), console.error("[replay] run failed:", err instanceof Error ? err.message : err)),
    ).finally(() => void (running = null));
    return running;
  };
  return {
    async get(): Promise<ServiceAnswer<T>> {
      const now = o.now();
      if (memo && now - memo.at < o.ttlMs) return { state: "ok", value: memo.value };
      if (!running && (failedAt === null || now - failedAt >= o.retryMs)) start();
      if (memo) return { state: "ok", value: memo.value };
      if (running) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([running, new Promise((r) => (timer = setTimeout(r, o.waitMs)))]).finally(() => clearTimeout(timer));
      }
      if (memo) return { state: "ok", value: (memo as { value: T }).value };
      return running ? { state: "pending" } : { state: "failed" };
    },
  };
}

/** Memo of a replay: a few hours (the window moves 15 min a step; the predicates are fixed). */
export const REPLAY_TTL_MS = 6 * HOUR;
/** Longest a request waits on a running replay before it answers `pending`. */
export const REPLAY_WAIT_MS = 2_000;
const REPLAY_RETRY_MS = 15 * MIN;

const services = new Map<ReplaySource, ReturnType<typeof createReplayService<SetupReplayResponse>>>();

/**
 * The process's replay of a source as the route answers it. On a serverless runtime nothing is started: a function
 * ends before a 4–5 min replay does, so each poll would start another partial run against Hyperliquid.
 */
export async function replayAnswer(source: ReplaySource, store: () => PlatformStore | null, env: Record<string, string | undefined> = process.env): Promise<SetupReplayResponse> {
  const params = replayParams(env);
  const now = Date.now();
  if (isServerless(env)) return { state: "unavailable", reason: needsAlwaysOn("bun run signals:replay"), ...empty(source, now, params) };
  if (source === "snapshots" && !store()) return { state: "unavailable", reason: "needs a database (DATABASE_URL unset)", ...empty(source, now, params) };
  let svc = services.get(source);
  if (!svc) {
    const run = source === "candles"
      ? () => runCandleReplay(defaultCandleDeps({ env }))
      : () => runSnapshotReplay({ store: store()!, now: Date.now, sinceDays: scanRetentionDays(env), params, top: envNum("PLATFORM_REPLAY_TOP", DEFAULT_REPLAY_TOP) });
    services.set(source, (svc = createReplayService({ run, now: Date.now, ttlMs: REPLAY_TTL_MS, retryMs: REPLAY_RETRY_MS, waitMs: REPLAY_WAIT_MS })));
  }
  const a = await svc.get();
  if (a.state === "ok") return a.value;
  return a.state === "pending" ? { state: "pending", ...empty(source, now, params) } : { state: "unavailable", reason: "replay failed (see server log)", ...empty(source, now, params) };
}

// ---------------------------------------------------------------- CLI text

const pctS = (x: number | null, d = 2) => (x == null ? "-" : `${x < 0 ? "-" : "+"}${Math.abs(x * 100).toFixed(d)}%`);

/** The replay as plain text: header facts, the per-setup table (one line per kind × side × horizon), the not-evaluable list. */
export function formatReplay(r: SetupReplayResponse): string {
  const out = [`setup replay · source ${r.source} · state ${r.state}${r.reason ? ` · ${r.reason}` : ""}`];
  if (r.state !== "ok") return out.join("\n");
  out.push(`window ${r.window?.from ?? "-"} -> ${r.window?.to ?? "-"} · grid ${r.grid} · horizons ${r.horizons.join(",")}`);
  out.push(`coins (${r.coins.length}): ${r.coins.join(" ")}`);
  out.push("", ["kind".padEnd(26), "side ", "hzn".padEnd(4), "entries".padStart(7), "n".padStart(5), "clust".padStart(6), "mean net".padStart(9), "ci95".padStart(17), "hit".padStart(5)].join(" "));
  for (const s of r.setups.filter((x) => x.evaluable)) {
    out.push([
      s.kind.padEnd(26), s.side.padEnd(5), s.horizon.padEnd(4), String(s.entries).padStart(7), String(s.n).padStart(5), String(s.clusters).padStart(6),
      pctS(s.meanNet).padStart(9), (s.ci95 ? `${pctS(s.ci95[0], 1)}..${pctS(s.ci95[1], 1)}` : "-").padStart(17), (s.hitRate == null ? "-" : `${Math.round(s.hitRate * 100)}%`).padStart(5),
    ].join(" "));
  }
  const not = [...new Map(r.setups.filter((x) => !x.evaluable).map((x) => [`${x.kind} ${x.side}`, x.reason])).entries()];
  if (not.length) out.push("", "not evaluable on this stream:", ...not.map(([k, why]) => `  ${k}: ${why}`));
  out.push("", "assumptions:", ...r.assumptions.map((a) => `  - ${a}`));
  return out.join("\n");
}
