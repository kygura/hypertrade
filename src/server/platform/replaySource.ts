import { fetchCandles, fetchFundingPage, fetchPerpMetaAndCtxs, HL_FUNDING_PAGE, HL_MAX_CANDLES, type FundingPoint } from "../../shared/hl-client.js";
import type { ReplaySource, SetupReplayResponse } from "../../shared/research.js";
import type { Candle } from "../../shared/types.js";
import { databaseUrl, getFunding } from "../db.js";
import { DEFAULT_TAKER_FEE_BPS } from "./costs.js";
import { FEATURE_MIN_TICKS_24H, type RingPoint } from "./features.js";
import { parseHorizons } from "./outcomes.js";
import { DEFAULT_OUTCOME_HORIZONS } from "./outcomesLoop.js";
import { replayEntries, RING_MS, summarise, type StreamInput } from "./replay.js";
import { DEFAULT_COOLDOWN_MIN, DEFAULT_READY_TTL_MIN, envNum } from "./scanner.js";
import { scanRetentionDays, type PlatformStore, type ScanSnapshot } from "./store.js";
import { selectUniverse } from "./universe.js";

// Ring-point streams for the setup replay (replay.ts) and the memoised background service behind
// GET /api/research/setups/replay and `bun run signals:replay`.
//   candles    HL 15-min candles (the latest 5000, about 52 days) + hourly funding; no OI, book or liquidations.
//   snapshots  stored scan_snapshots (mark, OI, funding, 24 h volume), when dense enough for the features.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const GRID_MS = 15 * MIN;
export const GRID = "15m";
/** Coins a candle replay covers by default: the most liquid by 24 h volume. About 230 HL weight each (one candle page, three funding pages), so 20 coins take about 5 min under the 1000/min guard. */
export const DEFAULT_REPLAY_TOP = 20;

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

/** What every replay states, whatever the source. */
function commonFacts(p: ReplayParams): string[] {
  return [
    "tests the shipped setup predicate (the scanner's evaluateTick) with the scanner's dedupe, ready TTL and cooldown; a replay of fixed predicates, not a Lab trial",
    "does not test the score (it orders candidates and picks the costed top N, never gates creation), operator decisions, or book-based costs",
    `every fired idea assumed costed and undecided: ready at creation, expired after ${p.readyTtlMin} min, cooldown ${p.cooldownMin} min after expiry`,
    `costs: taker fee ${p.feeBps} bps each way, slippage 0 (no historical book), funding = hourly rate at entry × horizon hours`,
    "exit at the stream's mark at entry + horizon; an entry with no point there is not graded at that horizon",
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

function result(source: ReplaySource, now: number, p: ReplayParams, streams: Map<string, RingPoint[]>, grid: number[], missing: StreamInput[], facts: string[], tierContext?: Array<{ coin: string; dayNtlVlm: number }>): SetupReplayResponse {
  const entries = replayEntries({ streams, grid, tierContext, readyTtlMs: p.readyTtlMin * MIN, cooldownMs: p.cooldownMin * MIN });
  return {
    state: "ok", asOf: iso(now), source,
    window: grid.length ? { from: iso(grid[0]!), to: iso(grid.at(-1)!) } : null,
    coins: [...streams.keys()], grid: source === "candles" ? GRID : "stored ticks", horizons: p.horizons,
    assumptions: [...commonFacts(p), ...facts],
    setups: summarise({ entries, streams, horizons: p.horizons, missing, feeBps: p.feeBps }),
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
  const facts = [
    `universe: top ${d.top} HL perps by 24 h volume now (survivors of today; ${streams.size} replayed)`,
    "15-min HL candles: mark = close at the candle's close; 24 h volume = trailing sum of volume × close",
    "funding = the latest hourly settlement at or before each step (the live scanner reads the current predicted rate)",
    "no intraday OI, book or liquidation data: setups reading those features are not evaluable",
    "on the 15-min grid the 1 h realized vol rests on 4 returns (the live 1-min ring has 60)",
    "liquidity tiers rank each step's 24 h volume against every other live coin's 24 h volume now",
    ...(dropped.length ? [`dropped (fetch failed or empty): ${dropped.join(", ")}`] : []),
  ];
  const context = live.filter((c) => !streams.has(c.coin));
  return result("candles", now, d.params, streams, gridOf(streams, GRID_MS), ["oi", "book", "liquidations"], facts, context);
}

/** Snapshot replay over stored scan_snapshots; `unavailable` with the numbers when they are too sparse. */
export async function runSnapshotReplay(d: { store: Pick<PlatformStore, "scanSnapshotsSince">; now: () => number; sinceDays: number; params: ReplayParams }): Promise<SetupReplayResponse> {
  const now = d.now();
  const rows = await d.store.scanSnapshotsSince(iso(now - d.sinceDays * DAY));
  const dens = snapshotDensity(rows, now);
  if (!dens.dense) {
    return {
      state: "unavailable", ...empty("snapshots", now, d.params),
      reason: `too sparse: median ${dens.medianTicks} scanner ticks per 24 h over ${dens.windows} day(s) of scan_snapshots; the features need ${FEATURE_MIN_TICKS_24H} (one per 15 min)`,
    };
  }
  const streams = snapshotStreams(rows);
  const facts = [
    `stored scan_snapshots, last ${d.sinceDays} days (median ${dens.medianTicks} ticks per 24 h); OI present, no book or liquidation history`,
    "liquidity tiers rank the stored coins only",
  ];
  return result("snapshots", now, d.params, streams, gridOf(streams, null), ["book", "liquidations"], facts);
}

// ---------------------------------------------------------------- fetch memo and default deps

/** In-process memo of a t-keyed series per coin: a later call fetches only from the newest cached point on. */
export function memoSeries<T extends { t: number }>(fetch: (coin: string, startMs: number, endMs: number) => Promise<T[]>) {
  const cache = new Map<string, T[]>();
  return async (coin: string, startMs: number, endMs: number): Promise<T[]> => {
    const have = cache.get(coin) ?? [];
    const from = have.length && have[0]!.t <= startMs ? have.at(-1)!.t : startMs; // refetch the newest (it may have been open)
    const got = from > endMs ? [] : await fetch(coin, from, endMs);
    const merged = new Map<number, T>([...have, ...got].map((x) => [x.t, x]));
    const all = [...merged.values()].filter((x) => x.t >= startMs).sort((a, b) => a.t - b.t);
    cache.set(coin, all);
    return all.filter((x) => x.t <= endMs);
  };
}

/** fundingHistory pages forward from startMs (500 rows each). */
async function liveFunding(coin: string, startMs: number, endMs: number): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  for (let cursor = startMs; cursor < endMs; ) {
    const rows = await fetchFundingPage(coin, cursor, endMs);
    out.push(...rows);
    if (rows.length < HL_FUNDING_PAGE) break;
    cursor = rows.at(-1)!.t + 1;
  }
  return out;
}

const candleMemo = memoSeries((coin, s, e) => fetchCandles(coin, "15m", s, e));
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

/** The process's replay of a source as the route answers it. */
export async function replayAnswer(source: ReplaySource, store: () => PlatformStore | null, env: Record<string, string | undefined> = process.env): Promise<SetupReplayResponse> {
  const params = replayParams(env);
  const now = Date.now();
  if (source === "snapshots" && !store()) return { state: "unavailable", reason: "needs a database (DATABASE_URL unset)", ...empty(source, now, params) };
  let svc = services.get(source);
  if (!svc) {
    const run = source === "candles"
      ? () => runCandleReplay(defaultCandleDeps({ env }))
      : () => runSnapshotReplay({ store: store()!, now: Date.now, sinceDays: scanRetentionDays(env), params });
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
