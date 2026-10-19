import { hlInfo, parseMetaAndCtxs } from "../../shared/hl-client.js";
import type { NoveltyEntry } from "../../shared/platform.js";
import { toDaily } from "../lab/providers/series.js";
import { defaultHtDeps, type HtDeps } from "../lab/providers/ht.js";
import { syncFunding } from "../market/fundingSync.js";
import { liquidityTiers } from "./features.js";
import { admitRun, novelty, pendingNovel, NOVELTY, type Candidate, type NoveltyDaily } from "./novelty.js";
import type { LoopDef } from "./runtime.js";
import { envNum } from "./scanner.js";
import type { PlatformStore } from "./store.js";

// Novelty loop (FEATURES.md section 4): hourly beat, detection once per newly closed UTC day. Every coin in the
// liquidity gate is checked against its own full history from `candles` (1d), `funding` and `observations`
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
}

/** `from` bounds only what is synced; the baseline is everything stored (full history since listing). */
export const storedInputs = (ht: Pick<HtDeps, "ensureHistory" | "candles" | "funding" | "series"> = defaultHtDeps, sync: typeof syncFunding = syncFunding) =>
  async (coin: string, now: number): Promise<RawInputs> => {
    const from = now - HISTORY_DAYS * DAY;
    await ht.ensureHistory(coin, from, ENSURE_CAP_MS);
    await sync(coin, from, { maxPages: FUNDING_PAGES, deadline: Date.now() + ENSURE_CAP_MS });
    const [bars, funding, oi] = await Promise.all([ht.candles(coin, 0), ht.funding(coin, 0, now), ht.series(`hl.oi.${coin}`, 0, now)]);
    return { bars, funding, oi };
  };

const defaultUniverse = async () =>
  parseMetaAndCtxs(await hlInfo<unknown>({ type: "metaAndAssetCtxs" })).ctxs
    .filter((c) => !c.isDelisted && c.markPx > 0)
    .map((c) => ({ coin: c.name, dayNtlVlm: c.dayNtlVlm, oiUsd: c.openInterest * c.markPx }));

export function createNoveltyLoop(deps: NoveltyLoopDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const inputs = deps.inputs ?? storedInputs();
  const universe = deps.universe ?? defaultUniverse;
  const maxTier = deps.maxTier ?? envNum("PLATFORM_NOVELTY_MAX_TIER", 1);
  /** Coins whose bar was evaluated (hit or not), per bar. A coin that threw or lacks the bar stays out and is retried next beat. Lost on restart: the window is re-checked once and admit() dedupes. */
  const checked = new Map<string, Set<string>>();

  /** Checks the missing (coin, bar) pairs and journals the hits, newest bar first for the push budget. */
  async function detect(bars: string[], t: number) {
    const all = await universe();
    const tiers = liquidityTiers(all);
    const u = all.filter((c) => tiers[c.coin]! <= maxTier);
    const todo = new Map(bars.map((b) => [b, u.filter((c) => !checked.get(b)?.has(c.coin))]));
    const coins = u.filter((c) => bars.some((b) => todo.get(b)!.includes(c)));
    if (!coins.length) return;
    const byOi = [...u].sort((a, b) => b.oiUsd - a.oiUsd).map((x) => x.coin);
    // Setups that signalled on the coin in the 3 days to now: opportunities carry no near-miss data.
    const near = new Map<string, Set<string>>();
    for (const o of await store.listOpportunities({ limit: 2000 })) {
      if (Date.parse(o.createdAt) >= t - 3 * DAY) (near.get(o.coin) ?? near.set(o.coin, new Set()).get(o.coin)!).add(o.setupKind);
    }
    const byBar = bars.map((bar) => ({ bar, cands: [] as Candidate[] }));
    for (const c of coins) {
      try {
        const d = alignDaily(await inputs(c.coin, t), t);
        for (const b of byBar) {
          if (checked.get(b.bar)?.has(c.coin)) continue;
          const i = d.t.indexOf(Date.parse(b.bar)); // a bar not stored yet is skipped, never faked, and retried
          if (i < 0) continue;
          (checked.get(b.bar) ?? checked.set(b.bar, new Set()).get(b.bar)!).add(c.coin);
          const { hit } = novelty(d, i);
          if (hit) b.cands.push({ coin: c.coin, rank: byOi.indexOf(c.coin), hit, nearSetups: [...(near.get(c.coin) ?? [])] });
        }
      } catch (err) {
        console.error(`[novelty] ${c.coin}:`, err instanceof Error ? err.message : err);
      }
    }
    const log = await store.listNovelty(barOf(t - 8 * DAY));
    await store.saveNovelty(admitRun(byBar, log, NOVELTY.runBudget, new Date(t).toISOString()));
  }

  async function tick() {
    const t = now();
    const newest = Date.parse(barOf(t - DAY)); // the newest closed UTC day
    const bars = Array.from({ length: NOVELTY.retryDays }, (_, k) => barOf(newest - k * DAY));
    for (const k of checked.keys()) if (!bars.includes(k)) checked.delete(k);
    await detect(bars, t);
    // Deliver (and retry for 3 days) pushed entries no channel has taken.
    for (const e of pendingNovel(await store.listNovelty(barOf(t - 4 * DAY)), t)) {
      const channels = await deps.notify(e);
      if (channels.length) await store.saveNovelty([{ ...e, notified: [...e.notified, { at: new Date(t).toISOString(), channels }] }]);
    }
    await store.pruneNovelty(barOf(t - 365 * DAY));
  }

  return { tick, def: { name: "novelty", intervalSec: 3600, run: tick } satisfies LoopDef };
}
