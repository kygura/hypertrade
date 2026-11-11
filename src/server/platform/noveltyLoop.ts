import { hlInfo, parseMetaAndCtxs } from "../../shared/hl-client.js";
import type { NoveltyEntry } from "../../shared/platform.js";
import { defaultOiBackfill, OiRateLimited } from "../collectors/coinalyzeOi.js";
import { toDaily } from "../lab/providers/series.js";
import { defaultHtDeps, type HtDeps } from "../lab/providers/ht.js";
import { syncFunding } from "../market/fundingSync.js";
import { liquidityTiers } from "./features.js";
import { admitRun, novelty, pendingNovel, NOVELTY, type Candidate, type NoveltyDaily } from "./novelty.js";
import type { LoopDef } from "./runtime.js";
import { envNum } from "./scanner.js";
import type { PlatformStore } from "./store.js";
import { ensureSectors, myMarkets, parseUniverseSpec, selectUniverse, type UniverseOpts } from "./universe.js";

// Novelty loop (docs/FEATURES.md section 4): hourly beat, detection once per newly closed UTC day. Every coin in the
// liquidity gate (plus my markets, which bypass it; PLATFORM_NOVELTY_UNIVERSE replaces both) is checked against its own full history from `candles` (1d), `funding` and `observations`
// hl.oi.<COIN>. Information only: it journals and pushes, it never gates or trades.

const DAY = 86_400_000;
/** How far back history is requested (candles reach HL's 5000-bar window; funding back to the coin's listing is wanted, this bounds the first backfill). */
const HISTORY_DAYS = 400;
/** Funding pages per coin per beat: the first backfill walks back over a few beats, under the weight guard. */
const FUNDING_PAGES = 6;
const ENSURE_CAP_MS = 20_000;

export const barOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface RawInputs {
  bars: Array<{ t: number; c: number; v: number }>;
  funding: Array<{ t: number; rate: number }>;
  oi: Array<{ t: number; v: number }>;
}

/** Aligns the three sources on the candle days that closed before `now`. Funding mean per day; OI last per day. */
export function alignDaily(r: RawInputs, now: number): NoveltyDaily {
  const bars = r.bars.filter((b) => b.t + DAY <= now && b.c > 0).sort((a, b) => a.t - b.t);
  const byDay = (s: { t: number[]; v: number[] }) => new Map(s.t.map((t, i) => [t, s.v[i]!]));
  const f = byDay(toDaily(r.funding.map((x) => ({ t: x.t, v: x.rate })), "mean"));
  const oi = byDay(toDaily(r.oi, "last"));
  return { t: bars.map((b) => b.t), c: bars.map((b) => b.c), v: bars.map((b) => b.v), f: bars.map((b) => f.get(b.t) ?? null), oi: bars.map((b) => oi.get(b.t) ?? null) };
}

export interface NoveltyLoopDeps {
  store: PlatformStore;
  /** NOVEL: push; resolves to the channels that took it. */
  notify: (e: NoveltyEntry) => Promise<string[]>;
  /** Closed-day inputs of one coin; default reads the platform tables (backfilling candles and funding first). */
  inputs?: (coin: string, now: number) => Promise<RawInputs>;
  universe?: () => Promise<Array<{ coin: string; dayNtlVlm: number; oiUsd: number }>>;
  now?: () => number;
  /** Coins in liquidity tiers 1..maxTier are checked (tier 1 = most liquid third). */
  maxTier?: number;
  /** Explicit universe filter (see parseUniverseSpec); default PLATFORM_NOVELTY_UNIVERSE, else tiers 1..maxTier plus my markets. */
  filter?: UniverseOpts;
  /** coin -> sectors for a sector filter; default tags new coins through the LLM and caches them in the store. */
  tags?: (coins: string[]) => Promise<Record<string, string[]>>;
  /** The scanner's latest near-miss for a coin; its setup joins nearSetups. */
  nearMiss?: (coin: string) => { setupKind: string } | null;
}

/** `from` bounds only what is synced; the baseline is everything stored (full history since listing). */
export const storedInputs = (ht: Pick<HtDeps, "ensureHistory" | "candles" | "funding" | "series"> = defaultHtDeps, sync: typeof syncFunding = syncFunding, backfillOi?: (coin: string) => Promise<number>) => {
  /** Coinalyze OI backfill runs once per coin per process (idempotent in the store; a failure waits for the next restart, a 429 retries on the next run). */
  const oiTried = new Set<string>();
  return async (coin: string, now: number): Promise<RawInputs> => {
    const from = now - HISTORY_DAYS * DAY;
    await ht.ensureHistory(coin, from, ENSURE_CAP_MS);
    if (backfillOi && !oiTried.has(coin)) {
      oiTried.add(coin);
      await backfillOi(coin).catch((err) => {
        if (err instanceof OiRateLimited) oiTried.delete(coin);
        console.error(`[novelty] ${coin} OI backfill:`, err instanceof Error ? err.message : err);
      });
    }
    await sync(coin, from, { maxPages: FUNDING_PAGES, deadline: Date.now() + ENSURE_CAP_MS });
    const [bars, funding, oi] = await Promise.all([ht.candles(coin, 0), ht.funding(coin, 0, now), ht.series(`hl.oi.${coin}`, 0, now)]);
    return { bars, funding, oi };
  };
};

const defaultUniverse = async () =>
  parseMetaAndCtxs(await hlInfo<unknown>({ type: "metaAndAssetCtxs" })).ctxs
    .filter((c) => !c.isDelisted && c.markPx > 0)
    .map((c) => ({ coin: c.name, dayNtlVlm: c.dayNtlVlm, oiUsd: c.openInterest * c.markPx }));

export interface NoveltyRunOpts {
  /** Epoch ms (on deps.now) after which no coin starts; the rest wait for the next call. Absent: the whole pass. */
  deadline?: number;
  /** Budget a coin needs left to start (ensureHistory and the funding sync are each capped at 20 s). */
  reserveMs?: number;
}

/** What one call did. A pass is one newly closed day; `remaining` coins wait for the next call. */
export interface NoveltyRunReport {
  /** The pass: its newest closed bar. */
  pass: string;
  /** Coins the window's bars cover (the checked universe). */
  universe: number;
  /** Coins read this call (one that threw is not counted), and coins with a bar of the window still unevaluated after it. */
  checked: number;
  remaining: number;
  /** True when every coin of the universe has every bar of the window evaluated (a bar not stored yet keeps it false). */
  done: boolean;
  /** Stopped by the deadline with coins left. */
  stopped: boolean;
  /** Journal entries admitted this call, pushed among them; pushes delivered from the retry queue. */
  journalled: number;
  pushed: number;
  delivered: number;
}

export function createNoveltyLoop(deps: NoveltyLoopDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const inputs = deps.inputs ?? storedInputs(defaultHtDeps, syncFunding, defaultOiBackfill());
  const universe = deps.universe ?? defaultUniverse;
  const maxTier = deps.maxTier ?? envNum("PLATFORM_NOVELTY_MAX_TIER", 1);
  const spec = process.env.PLATFORM_NOVELTY_UNIVERSE?.trim();
  const filter = deps.filter ?? (spec ? parseUniverseSpec(spec) : undefined);
  const tags = deps.tags ?? ((coins: string[]) => ensureSectors(coins, store));

  /**
   * Checks the missing (coin, bar) pairs and journals the hits, newest bar first for the push budget. Progress (which
   * coins each bar has evaluated, pushes spent, where to resume) is stored, not held in memory: the always-on loop and
   * the bounded HTTP job (POST /api/cron/novelty) run this same code, and a restart or a fresh invocation resumes.
   * A coin that threw or lacks the bar stays unchecked and is retried; the cursor rotates the start so such a coin
   * cannot starve the rest of a bounded call.
   */
  async function detect(bars: string[], t: number, opts: NoveltyRunOpts, r: NoveltyRunReport) {
    const held = await store.loadNoveltyProgress();
    const same = held?.pass === bars[0];
    const checked = new Map(bars.map((b) => [b, new Set(held?.checked[b] ?? [])]));
    let pushed = same ? held!.pushed : 0;
    let cursor = same ? held!.cursor : null;
    const all = await universe();
    const tiers = liquidityTiers(all);
    const mine = new Set(myMarkets());
    const u = filter
      ? selectUniverse(all, { ...filter, tags: filter.sectors?.length ? await tags(all.map((c) => c.coin)) : undefined })
      : all.filter((c) => tiers[c.coin]! <= maxTier || mine.has(c.coin));
    r.universe = u.length;
    const missing = (coin: string) => bars.some((b) => !checked.get(b)!.has(coin));
    const k = cursor ? u.findIndex((c) => c.coin === cursor) : -1;
    const coins = (k >= 0 ? [...u.slice(k + 1), ...u.slice(0, k + 1)] : u).filter((c) => missing(c.coin));
    if (!coins.length) return;
    const byOi = [...u].sort((a, b) => b.oiUsd - a.oiUsd).map((x) => x.coin);
    // Setups that signalled on the coin in the 3 days to now: opportunities carry no near-miss data.
    const near = new Map<string, Set<string>>();
    for (const o of await store.listOpportunities({ limit: 2000 })) {
      if (Date.parse(o.createdAt) >= t - 3 * DAY) (near.get(o.coin) ?? near.set(o.coin, new Set()).get(o.coin)!).add(o.setupKind);
    }
    const byBar = bars.map((bar) => ({ bar, cands: [] as Candidate[] }));
    for (const c of coins) {
      if (opts.deadline != null && opts.deadline - now() < (opts.reserveMs ?? 0)) {
        r.stopped = true;
        break;
      }
      cursor = c.coin;
      try {
        const d = alignDaily(await inputs(c.coin, t), t);
        for (const b of byBar) {
          if (checked.get(b.bar)!.has(c.coin)) continue;
          const i = d.t.indexOf(Date.parse(b.bar)); // a bar not stored yet is skipped, never faked, and retried
          if (i < 0) continue;
          checked.get(b.bar)!.add(c.coin);
          const { hit } = novelty(d, i);
          if (hit) b.cands.push({ coin: c.coin, rank: byOi.indexOf(c.coin), hit, nearSetups: [...new Set([...(near.get(c.coin) ?? []), ...(deps.nearMiss?.(c.coin) ? [deps.nearMiss(c.coin)!.setupKind] : [])])] });
        }
        r.checked++;
      } catch (err) {
        console.error(`[novelty] ${c.coin}:`, err instanceof Error ? err.message : err);
      }
    }
    const log = await store.listNovelty(barOf(t - 8 * DAY));
    const admitted = admitRun(byBar, log, Math.max(0, NOVELTY.runBudget - pushed), new Date(t).toISOString());
    // Journal first, then progress: a call killed in between re-checks its coins and admit() dedupes them.
    await store.saveNovelty(admitted);
    r.journalled = admitted.length;
    r.pushed = admitted.filter((e) => e.pushed).length;
    pushed += r.pushed;
    r.remaining = u.filter((c) => missing(c.coin)).length;
    await store.saveNoveltyProgress({ pass: bars[0]!, checked: Object.fromEntries([...checked].map(([b, s]) => [b, [...s].sort()])), pushed, cursor: r.remaining ? cursor : null, at: new Date(t).toISOString() });
  }

  /** One call: detection over the window (bounded by opts.deadline), then delivery retries and retention. */
  async function run(opts: NoveltyRunOpts = {}): Promise<NoveltyRunReport> {
    const t = now();
    const newest = Date.parse(barOf(t - DAY)); // the newest closed UTC day
    const bars = Array.from({ length: NOVELTY.retryDays }, (_, k) => barOf(newest - k * DAY));
    const r: NoveltyRunReport = { pass: bars[0]!, universe: 0, checked: 0, remaining: 0, done: false, stopped: false, journalled: 0, pushed: 0, delivered: 0 };
    await detect(bars, t, opts, r);
    r.done = r.remaining === 0;
    // Deliver (and retry for 3 days) pushed entries no channel has taken.
    for (const e of pendingNovel(await store.listNovelty(barOf(t - 4 * DAY)), t)) {
      const channels = await deps.notify(e);
      if (channels.length) {
        await store.saveNovelty([{ ...e, notified: [...e.notified, { at: new Date(t).toISOString(), channels }] }]);
        r.delivered++;
      }
    }
    await store.pruneNovelty(barOf(t - 365 * DAY));
    return r;
  }

  const tick = async () => void (await run());
  return { tick, run, def: { name: "novelty", intervalSec: 3600, run: tick } satisfies LoopDef };
}
