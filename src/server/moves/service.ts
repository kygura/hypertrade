import { SECTORS_HISTORY } from "../../../data/sectors/index.js";
import sectorsLatest from "../../../data/sectors/latest.json" with { type: "json" };
import { fetchCandles, fetchFundingPage, createHlShare, HL_FUNDING_PAGE, type FundingPoint } from "../../shared/hl-client.js";
import type { IntelEvent, NarrativeStage } from "../../shared/intel.js";
import { WINDOW_HOURS, type FactorMove, type LayerState, type MoveDetail, type MoveRow, type MoveSeriesPoint, type MovesResponse, type MoveWindow } from "../../shared/moves.js";
import { PRE_DECISION_STATUSES, type Position } from "../../shared/platform.js";
import { SectorsDataSchema } from "../../shared/schemas.js";
import type { AssetCtx, Candle, SectorsData } from "../../shared/types.js";
import { databaseUrl } from "../db.js";
import { loadNarrativeFlows, narrativeHeadlines } from "../intel/narratives.js";
import { PgIntelStore, type IntelStore } from "../intel/store.js";
import { dbPlatformContext, getPlatformContext, type PlatformContext } from "../platform/context.js";
import { aggregate, coverage } from "../platform/liqmap.js";
import { createReplayService, memoSeries, type ServiceAnswer } from "../platform/replaySource.js";
import { isServerless, needsAlwaysOn } from "../platform/runtime.js";
import { PgPlatformStore } from "../platform/store-pg.js";
import { myMarkets } from "../platform/universe.js";
import { getCtxs } from "../routes/hl.js";
import { loadSocial, type TokenSocial } from "../routes/sectors.js";
import { attribute, basketReturns, buildFactors, coinEvents, flowHours, hourlyOi, hourlyReturns, hourlySample, newsFeedGap, newsHours, windowBars, type FlowHours, type Returns } from "./attribution.js";
import { checklists } from "./checklists.js";
import {
  CANDLE_BARS, DETAIL_SECTOR_PEERS, EST_BARS, FUNDING_Z_LOOKBACK, HOUR_MS, LIQ_BUCKET_BPS, LIQ_RANGE, MIN_WINDOW_SHARE, MOVES_EVENT_LIMIT, MOVES_HEADLINES,
  MOVES_HL_BUDGET, MOVES_MIN_LOADED_SHARE, MOVES_RESPONSE_CACHE_MS, MOVES_RETRY_MS, MOVES_TOP, MOVES_TOP_VOLUME, MOVES_TTL_SLACK_MS, MOVES_WAIT_MS,
} from "./constants.js";
import { attention, liqProximity, positioning, type Sample } from "./positioning.js";

// Moves service (docs/SPEC.md § Moves). One background run per closed hour loads 1h candles for the universe (memoised
// per coin, under MOVES_HL_BUDGET of the HL weight guard); every answer then recomputes attribution, positioning,
// liquidation proximity, attention and the checklists from the run, the live contexts (60 s cache), the scanner's
// snapshots and the stores. Each layer degrades on its own with a stated reason; nothing is ever filled with demo data.
// universe(): the table (always-on server, or the moves job's own instance, jobs.ts; with `serverless` it answers
// `unavailable` and starts nothing: the serverless route serves the stored run instead, stored.ts).
// coin(): one coin inline (coin, BTC, ETH, up to DETAIL_SECTOR_PEERS sector peers), so it also works on Vercel.

export interface MovesService {
  universe(window: MoveWindow): Promise<MovesResponse>;
  coin(coin: string, window: MoveWindow): Promise<MoveDetail>;
}

/** The coin is not a listed main-dex perp. The route answers 404. */
export class UnknownCoinError extends Error {
  readonly status = 404;
  constructor(coin: string) {
    super(`unknown coin ${coin}: not a listed main-dex perp`);
  }
}

export interface MovesDeps {
  /** Hourly candles in [startMs, endMs]. */
  candles(coin: string, startMs: number, endMs: number): Promise<Candle[]>;
  /** Settled hourly funding in [startMs, endMs]: the fallback when there are no scanner snapshots. */
  funding(coin: string, startMs: number, endMs: number): Promise<FundingPoint[]>;
  /** Live main-dex asset contexts (cached upstream). */
  ctxs(): Promise<AssetCtx[]>;
  /** Scanner snapshots, crawler positions and opportunities; null without the worker and without a database. */
  platform(): PlatformContext | null;
  /** News events; null without a database. */
  intel(): Pick<IntelStore, "listEvents"> | null;
  social(coins: string[]): Promise<Map<string, TokenSocial>>;
  /** Narrative stage per sector id; empty without a database. */
  stages(): Promise<Map<string, NarrativeStage>>;
  sectors(): SectorsData;
  now(): number;
  serverless: boolean;
  /** My markets: always in the universe. */
  mine: string[];
  log?(msg: string): void;
  /** Universe cap (default MOVES_TOP). */
  top?: number;
  /** Longest a universe request waits on a running run before it answers `pending` (default MOVES_WAIT_MS). */
  waitMs?: number;
  /** Epoch ms after which a run starts no more coin fetches (the moves job's budget); those coins are dropped and named. */
  loadDeadline?: number;
}

const iso = (t: number) => new Date(t).toISOString();
const ok: LayerState = { state: "ok", reason: null };
const off = (reason: string): LayerState => ({ state: "unavailable", reason });
const partial = (reason: string): LayerState => ({ state: "partial", reason });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isMain = (c: AssetCtx) => !c.name.includes(":") && !c.isDelisted && c.markPx > 0;

/** Close of the last closed 1h bar the numbers run to: the hour turns MOVES_TTL_SLACK_MS after the close, so HL has the bar. */
export const asOfHour = (now: number) => Math.floor((now - MOVES_TTL_SLACK_MS) / HOUR_MS) * HOUR_MS;

/** Universe: BTC, ETH, the top MOVES_TOP_VOLUME main-dex perps by 24h volume and my markets, capped at MOVES_TOP. */
export function movesUniverse(ctxs: AssetCtx[], mine: string[], top = MOVES_TOP): { coins: string[]; dropped: Array<{ coin: string; reason: string }> } {
  const live = ctxs.filter(isMain).sort((a, b) => b.dayNtlVlm - a.dayNtlVlm || (a.name < b.name ? -1 : 1));
  const listed = new Set(live.map((c) => c.name));
  const dropped = mine.filter((c) => !listed.has(c)).map((coin) => ({ coin, reason: "not a listed main-dex perp" }));
  const want = [...new Set(["BTC", "ETH", ...live.slice(0, MOVES_TOP_VOLUME).map((c) => c.name), ...mine.filter((c) => listed.has(c))])].filter((c) => listed.has(c));
  return { coins: want.slice(0, top), dropped: [...dropped, ...want.slice(top).map((coin) => ({ coin, reason: `beyond the ${top}-coin cap` }))] };
}

interface Loaded {
  asOf: number;
  coins: string[];
  dropped: Array<{ coin: string; reason: string }>;
  candles: Map<string, Candle[]>;
  /** Settled funding per coin, fetched only when no scanner snapshots exist. */
  funding: Map<string, FundingPoint[]>;
}

/** Candles (and, without a scanner, funding) for `coins`, closed bars up to asOf. A failed coin is dropped and named. */
async function load(deps: MovesDeps, asOf: number, coins: string[], fundingFor: (coin: string) => boolean, progress?: { loaded: number; total: number }): Promise<Loaded> {
  const start = asOf - (CANDLE_BARS + 1) * HOUR_MS;
  const out: Loaded = { asOf, coins: [], dropped: [], candles: new Map(), funding: new Map() };
  for (const [i, coin] of coins.entries()) {
    if (deps.loadDeadline != null && deps.now() >= deps.loadDeadline) {
      out.dropped.push({ coin, reason: "not loaded before the job deadline" });
      continue;
    }
    try {
      const cs = (await deps.candles(coin, start, asOf - 1)).filter((c) => c.t + HOUR_MS <= asOf);
      if (!cs.length) throw new Error("no candles");
      out.candles.set(coin, cs);
      if (fundingFor(coin)) out.funding.set(coin, await deps.funding(coin, asOf - (FUNDING_Z_LOOKBACK + 1) * HOUR_MS, asOf));
      out.coins.push(coin);
    } catch (err) {
      out.dropped.push({ coin, reason: `fetch failed: ${errMsg(err)}` });
    }
    if (progress) progress.loaded = i + 1;
    deps.log?.(`${i + 1}/${coins.length} ${coin}`);
  }
  return out;
}

// ---------------------------------------------------------------- per-answer context

interface Ctx {
  now: number;
  ctx: Map<string, AssetCtx>;
  /** Snapshot points per coin (ts ms); null without a platform context. */
  snaps: Map<string, Array<{ ts: number; oiUsd: number; funding: number }>> | null;
  positions: Map<string, Position[]> | null;
  opportunities: Map<string, string>;
  /** Null when the news layer is unknown (`newsOff` says why): no store, a failed read, or a feed not being ingested. */
  events: IntelEvent[] | null;
  newsOff: string | null;
  eventsCapped: boolean;
  social: Map<string, TokenSocial>;
  stages: Map<string, NarrativeStage>;
  sectors: SectorsData;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const NO_NEWS_DB = "needs a database (news and Elfa are stored)";

export function createMovesService(deps: MovesDeps): MovesService {
  const progress = { loaded: 0, total: 0 };
  let cur: { asOf: number; svc: ReturnType<typeof createReplayService<Loaded>> } | null = null;
  let last: Loaded | null = null;
  const snapCache = new Map<string, Promise<Ctx["snaps"]>>();
  const answers = new Map<string, { at: number; value: Promise<unknown> }>();

  const run = async (asOf: number): Promise<Loaded> => {
    const { coins, dropped } = movesUniverse(await deps.ctxs(), deps.mine, deps.top);
    progress.loaded = 0;
    progress.total = coins.length;
    const noScanner = deps.platform() == null;
    const l = await load(deps, asOf, coins, () => noScanner, progress);
    // A fetch outage is a failed run (retried), never a table of nothing.
    if (!l.candles.has("BTC") || !l.candles.has("ETH") || l.coins.length < MOVES_MIN_LOADED_SHARE * coins.length) {
      throw new Error(`moves run loaded ${l.coins.length} of ${coins.length} coins (BTC ${l.candles.has("BTC") ? "ok" : "missing"}, ETH ${l.candles.has("ETH") ? "ok" : "missing"})`);
    }
    return { ...l, dropped: [...dropped, ...l.dropped] };
  };

  /** The run for the current hour; the previous hour's result is served while the new one loads. */
  const current = async (): Promise<ServiceAnswer<Loaded>> => {
    const asOf = asOfHour(deps.now());
    if (!cur || cur.asOf !== asOf) cur = { asOf, svc: createReplayService({ run: () => run(asOf), now: deps.now, ttlMs: Infinity, retryMs: MOVES_RETRY_MS, waitMs: deps.waitMs ?? MOVES_WAIT_MS }) };
    const a = await cur.svc.get();
    if (a.state === "ok") return ((last = a.value), a);
    return last ? { state: "ok", value: last } : a;
  };

  const cachedAnswer = <T>(key: string, make: () => Promise<T>): Promise<T> => {
    const now = deps.now();
    const hit = answers.get(key);
    if (hit && now - hit.at < MOVES_RESPONSE_CACHE_MS) return hit.value as Promise<T>;
    const value = make();
    answers.set(key, { at: now, value });
    value.catch(() => answers.delete(key));
    for (const [k, v] of answers) if (now - v.at >= MOVES_RESPONSE_CACHE_MS) answers.delete(k);
    return value;
  };

  /** Snapshots of `coins` since the funding-z lookback, read once per hour per coin set. */
  const snapshots = (asOf: number, coins: string[]): Promise<Ctx["snaps"]> => {
    const p = deps.platform();
    if (!p) return Promise.resolve(null);
    const key = `${asOf}|${coins.join(",")}`;
    let hit = snapCache.get(key);
    if (!hit) {
      const since = asOf - (Math.max(FUNDING_Z_LOOKBACK, 72 + EST_BARS) + 2) * HOUR_MS;
      hit = p.store.scanSnapshotsSince(iso(since), coins).then((rows) => {
        const m = new Map<string, Array<{ ts: number; oiUsd: number; funding: number }>>();
        for (const r of rows) {
          const ts = Date.parse(r.ts);
          const oiUsd = num(r.inputs.oiUsd);
          const funding = num(r.inputs.funding);
          if (!Number.isFinite(ts) || oiUsd == null || funding == null) continue;
          (m.get(r.coin) ?? m.set(r.coin, []).get(r.coin)!).push({ ts, oiUsd, funding });
        }
        for (const v of m.values()) v.sort((a, b) => a.ts - b.ts);
        return m;
      });
      hit.catch(() => snapCache.delete(key));
      for (const k of snapCache.keys()) if (!k.startsWith(`${asOf}|`)) snapCache.delete(k);
      snapCache.set(key, hit);
    }
    return hit;
  };

  const context = async (asOf: number, coins: string[]): Promise<Ctx> => {
    const now = deps.now();
    const p = deps.platform();
    const intel = deps.intel();
    const [ctxs, snaps, positions, opps, read, social, stages] = await Promise.all([
      deps.ctxs(),
      snapshots(asOf, coins).catch((err) => (deps.log?.(`snapshots: ${errMsg(err)}`), null)),
      p ? p.store.listPositions().then((ps) => {
        const m = new Map<string, Position[]>();
        for (const x of ps) (m.get(x.coin) ?? m.set(x.coin, []).get(x.coin)!).push(x);
        return m;
      }).catch(() => null) : null,
      p ? p.store.listOpportunities({ statuses: [...PRE_DECISION_STATUSES], limit: 500 }).catch(() => []) : [],
      intel ? intel.listEvents({ since: new Date(now - 8 * 24 * HOUR_MS), limit: MOVES_EVENT_LIMIT }).catch((err) => (deps.log?.(`events: ${errMsg(err)}`), null)) : null,
      deps.social(coins).catch(() => new Map<string, TokenSocial>()),
      deps.stages().catch(() => new Map<string, NarrativeStage>()),
    ]);
    const opportunities = new Map<string, string>();
    for (const o of opps) if (!opportunities.has(o.coin)) opportunities.set(o.coin, o.id);
    // An empty or silent feed is not "no news": the layer is known only while the feed is being ingested.
    const newsOff = !intel ? NO_NEWS_DB : read == null ? "news read failed (see server log)" : newsFeedGap(read, now);
    const events = newsOff ? null : read;
    return {
      now, ctx: new Map(ctxs.filter(isMain).map((c) => [c.name, c])), snaps, positions, opportunities,
      events, newsOff, eventsCapped: events != null && events.length >= MOVES_EVENT_LIMIT, social, stages, sectors: deps.sectors(),
    };
  };

  const sectorOf = (s: SectorsData, coin: string) => s.sectors.find((x) => x.tokens.includes(coin)) ?? null;
  /** Sector peers ex-coin, ex-majors. */
  const peersOf = (s: SectorsData, coin: string) => (sectorOf(s, coin)?.tokens ?? []).filter((t) => t !== coin && t !== "BTC" && t !== "ETH");

  interface Built { row: MoveRow; series: MoveSeriesPoint[]; flow: FlowHours | null }

  function buildRow(coin: string, window: MoveWindow, l: Loaded, returns: Map<string, Returns>, c: Ctx): Built {
    const live = c.ctx.get(coin);
    const sector = sectorOf(c.sectors, coin);
    const peerNames = peersOf(c.sectors, coin).filter((t) => returns.has(t));
    const h = WINDOW_HOURS[window];
    const { est, win } = windowBars(l.asOf, h);
    const snaps = c.snaps?.get(coin) ?? (c.snaps ? [] : null);
    const flow = snaps == null ? null : flowHours(hourlyOi(snaps, [...est, ...win, est[0]! - HOUR_MS]), est, win);
    const news = c.events == null ? null : coinEvents(c.events, coin);
    const r = returns.get(coin)!;
    const run = (w: MoveWindow, f: FlowHours | null, n: Set<number> | null) =>
      attribute({ coin, window: w, asOf: l.asOf, r, btc: returns.get("BTC")!, eth: returns.get("ETH")!, peers: sector ? peerNames.map((t) => returns.get(t)!) : null, flow: f, news: n });
    const res = run(window, flow, news == null ? null : newsHours(news, win));
    const res24 = window === "24h" ? res : run("24h", null, null);

    // Positioning: live context now, hourly funding and OI from snapshots (or settled funding without a scanner).
    const cs = l.candles.get(coin) ?? [];
    const closeAt = (t: number) => cs.find((x) => x.t === t)?.c;
    const c0 = closeAt(l.asOf - HOUR_MS), c72 = closeAt(l.asOf - 73 * HOUR_MS);
    const fundingBars = Array.from({ length: FUNDING_Z_LOOKBACK }, (_, i) => l.asOf - (FUNDING_Z_LOOKBACK - i) * HOUR_MS);
    const fundingHourly = snaps
      ? [...hourlySample(snaps.map((s) => ({ ts: s.ts, v: s.funding })), fundingBars).values()]
      : (l.funding.get(coin) ?? []).filter((f) => f.t < c.now).map((f) => f.rate).slice(-FUNDING_Z_LOOKBACK);
    const oiSamples: Sample[] = (snaps ?? []).map((s) => ({ ts: s.ts, v: s.oiUsd }));
    const mark = live?.markPx ?? cs.at(-1)?.c ?? 0;
    const pos = positioning({
      ctx: { funding: live?.funding ?? 0, premium: live ? live.premium : null, oiUsd: live ? live.openInterest * live.markPx : 0, dayNtlVlm: live?.dayNtlVlm ?? 0 },
      fundingHourly, oi: oiSamples, priceChg72hPct: c0 && c72 ? 100 * Math.log(c0 / c72) : null, now: c.now,
    });

    // Liquidation proximity: the crawler's positions on the board's grid.
    let liqState: LayerState;
    let clusters = null;
    let ratio: number | null = null;
    if (c.positions == null) liqState = off("needs the always-on scanner and crawler");
    else {
      const ps = c.positions.get(coin) ?? [];
      if (!ps.length || !(mark > 0)) liqState = partial(`the crawler holds no positions in ${coin}`);
      else {
        liqState = ok;
        clusters = aggregate(ps, { mark, bucketBps: LIQ_BUCKET_BPS, rangePct: LIQ_RANGE }).nearestClusters;
      }
      const oiUsd = live ? live.openInterest * live.markPx : null;
      ratio = coverage(ps.reduce((a, x) => a + x.positionValue, 0), oiUsd, new Set(ps.map((x) => x.address)).size, []).ratio;
    }
    const liq = liqProximity(liqState, clusters, ratio, res.sigma24hPct);

    const social = c.social.get(coin) ?? null;
    const att = attention({
      state: c.events == null ? off(c.newsOff ?? NO_NEWS_DB) : c.eventsCapped ? partial(`news read capped at ${MOVES_EVENT_LIMIT} events`) : ok,
      news, social, sectorId: sector?.id ?? null, sectorStage: sector ? (c.stages.get(sector.id) ?? null) : null, now: c.now,
    });
    const a24 = res24.attribution;
    const row: MoveRow = {
      coin,
      sector: sector ? { id: sector.id, label: sector.label } : null,
      mark,
      dayNtlVlm: live?.dayNtlVlm ?? 0,
      attribution: res.attribution,
      attributionReason: res.reason,
      positioning: pos,
      liq,
      attention: att,
      setups: checklists({ residual24h: a24 ? { residualPct: a24.residualPct, residualZ: a24.residualZ } : null, positioning: pos, attention: att, liq }),
      opportunityId: c.opportunities.get(coin) ?? null,
    };
    return { row, series: res.series, flow };
  }

  function layers(built: Built[], c: Ctx): MovesResponse["layers"] {
    const missing = built.filter((b) => b.row.attribution == null);
    const beta = !built.length ? off("no coins loaded")
      : missing.length === built.length ? off(missing[0]!.row.attributionReason ?? "no attribution")
      : missing.length ? partial(`${missing.length} of ${built.length} coins lack history (${missing[0]!.row.coin}: ${missing[0]!.row.attributionReason})`) : ok;
    const thin = built.find((b) => b.flow?.hours === null);
    const flow = c.snaps == null ? off("needs the always-on scanner (OI snapshots)")
      : thin ? partial(`OI snapshots too short: ${thin.row.coin} ${(thin.flow as { reason: string }).reason}`) : ok;
    const attentionL = c.events == null ? off(c.newsOff ?? NO_NEWS_DB) : c.eventsCapped ? partial(`news read capped at ${MOVES_EVENT_LIMIT} events`) : ok;
    const liq = c.positions == null ? off("needs the always-on scanner and crawler") : c.positions.size === 0 ? partial("the crawler holds no positions yet") : ok;
    return { beta, flow, attention: attentionL, liq, agents: off("agent watch not attached") };
  }

  function factorStrip(window: MoveWindow, l: Loaded, returns: Map<string, Returns>, sectors: SectorsData): FactorMove[] {
    const h = WINDOW_HOURS[window];
    const { est, win } = windowBars(l.asOf, h);
    const btc = returns.get("BTC")!, eth = returns.get("ETH")!;
    const sumW = (r: Returns) => {
      const xs = win.filter((t) => r.has(t));
      return xs.length >= Math.ceil(MIN_WINDOW_SHARE * h) ? 100 * xs.reduce((a, t) => a + r.get(t)!, 0) : null;
    };
    const out: FactorMove[] = [];
    const push = (id: string, label: string, pct: number | null, n: number) => void (pct != null && out.push({ id, label, pct, n }));
    push("BTC", "BTC", sumW(btc), 1);
    push("ETH", "ETH", sumW(eth), 1);
    push("ETHX", "ETH ex-BTC", sumW(buildFactors(btc, eth, null, est, win).f2), 1);
    const baskets: FactorMove[] = [];
    for (const s of sectors.sectors) {
      const peers = s.tokens.filter((t) => t !== "BTC" && t !== "ETH" && returns.has(t));
      if (peers.length < 2) continue;
      const pct = sumW(basketReturns(peers.map((t) => returns.get(t)!), win));
      if (pct != null) baskets.push({ id: `sector:${s.id}`, label: s.label, pct, n: peers.length });
    }
    return [...out, ...baskets.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 6)];
  }

  const returnsOf = (l: Loaded) => new Map([...l.candles].map(([k, v]) => [k, hourlyReturns(v)]));

  async function universe(window: MoveWindow): Promise<MovesResponse> {
    const now = deps.now();
    const sectors = deps.sectors();
    const blank = { computedAt: iso(now), window, universe: { coins: 0, dropped: [] }, sectorsAsOf: sectors.generated_at, factors: [], rows: [], asOf: null, progress: null };
    const allOff = (reason: string): MovesResponse["layers"] => ({ beta: off(reason), flow: off(reason), attention: off(reason), liq: off(reason), agents: off(reason) });
    if (deps.serverless) {
      const reason = needsAlwaysOn("bun run moves");
      return { ...blank, state: "unavailable", reason, layers: allOff(reason) };
    }
    const a = await current();
    if (a.state === "pending") return { ...blank, state: "pending", reason: "first run: loading hourly candles", progress: { ...progress }, layers: allOff("first run still loading") };
    if (a.state === "failed") return { ...blank, state: "unavailable", reason: "moves run failed (see server log); retried in 15 min", layers: allOff("moves run failed") };
    const l = a.value;
    return cachedAnswer(`u|${window}|${l.asOf}`, async () => {
      const c = await context(l.asOf, l.coins);
      const returns = returnsOf(l);
      const built = l.coins.map((coin) => buildRow(coin, window, l, returns, c));
      return {
        state: "ok", reason: null, asOf: iso(l.asOf), computedAt: iso(c.now), window, progress: null,
        universe: { coins: l.coins.length, dropped: l.dropped }, sectorsAsOf: c.sectors.generated_at,
        factors: factorStrip(window, l, returns, c.sectors), layers: layers(built, c), rows: built.map((b) => b.row),
      };
    });
  }

  async function coin(param: string, window: MoveWindow): Promise<MoveDetail> {
    const ctxs = (await deps.ctxs()).filter(isMain);
    const hit = ctxs.find((x) => x.name === param) ?? ctxs.find((x) => x.name.toLowerCase() === param.toLowerCase());
    if (!hit) throw new UnknownCoinError(param);
    const name = hit.name;
    return cachedAnswer(`c|${name}|${window}|${asOfHour(deps.now())}`, async () => {
      const asOf = asOfHour(deps.now());
      const sectors = deps.sectors();
      // Reuse the hour's run when it holds the coin; else load coin, BTC, ETH and a few sector peers inline.
      const memo = last && last.asOf === asOf && last.candles.has(name) ? last : null;
      const listed = new Set(ctxs.map((x) => x.name));
      const peers = peersOf(sectors, name).filter((t) => listed.has(t)).slice(0, DETAIL_SECTOR_PEERS);
      const noScanner = deps.platform() == null;
      const l = memo ?? (await load(deps, asOf, [...new Set([name, "BTC", "ETH", ...peers])], (x) => noScanner && x === name));
      const c = await context(asOf, [...new Set([name, "BTC", "ETH", ...peers])]);
      const unavailable = (reason: string): MoveDetail => ({
        ...emptyRow(name, hit, sectors, deps.now()), state: "unavailable", reason, asOf: null, window,
        layers: { beta: off(reason), flow: off(reason), attention: off(reason), liq: off(reason), agents: off("agent watch not attached") }, series: [], headlines: [], record: null,
      });
      if (!l.candles.has(name) || !l.candles.has("BTC") || !l.candles.has("ETH")) {
        return unavailable(`hourly candles unavailable (${l.dropped.map((d) => `${d.coin}: ${d.reason}`).join("; ") || "none loaded"})`);
      }
      const built = buildRow(name, window, l, returnsOf(l), c);
      const headlines = c.events ? narrativeHeadlines(c.events.filter((e) => Date.parse(e.firstSeen) >= c.now - 72 * HOUR_MS), [name], MOVES_HEADLINES) : [];
      return { ...built.row, state: "ok", reason: null, asOf: iso(l.asOf), window, layers: layers([built], c), series: built.series, headlines, record: null };
    });
  }

  return { universe, coin };
}

function emptyRow(coin: string, live: AssetCtx, sectors: SectorsData, now: number): MoveRow {
  const sector = sectors.sectors.find((x) => x.tokens.includes(coin)) ?? null;
  const na = off("not computed");
  return {
    coin, sector: sector ? { id: sector.id, label: sector.label } : null, mark: live.markPx, dayNtlVlm: live.dayNtlVlm,
    attribution: null, attributionReason: "not computed",
    positioning: positioning({ ctx: { funding: live.funding, premium: live.premium, oiUsd: live.openInterest * live.markPx, dayNtlVlm: live.dayNtlVlm }, fundingHourly: [], oi: [], priceChg72hPct: null, now }),
    liq: liqProximity(na, null, null, null),
    attention: attention({ state: na, news: null, social: null, sectorId: sector?.id ?? null, sectorStage: null, now }),
    setups: [], opportunityId: null,
  };
}

// ---------------------------------------------------------------- process defaults

// The moves fetches' own trailing-60s weight stays under MOVES_HL_BUDGET (createHlShare); the memo keeps one series per coin.
const hlShare = createHlShare(MOVES_HL_BUDGET);
let weightBooked = 0;
const movesShare = async (weight: number) => {
  await hlShare(weight);
  weightBooked += weight;
};
/** HL weight the moves fetches of this process have booked so far (the moves job reports its own delta). */
export const movesWeightBooked = () => weightBooked;
const candleMemo = memoSeries(async (coin: string, s: number, e: number) => (await movesShare(20 + Math.ceil(CANDLE_BARS / 60)), fetchCandles(coin, "1h", s, e)), MOVES_TOP + 8);
const fundingMemo = memoSeries(async (coin: string, s: number, e: number) => (await movesShare(20 + Math.ceil(HL_FUNDING_PAGE / 20)), fetchFundingPage(coin, s, e)), MOVES_TOP + 8);

const STAGES_TTL_MS = HOUR_MS;
let stagesCache: { at: number; value: Promise<Map<string, NarrativeStage>> } | null = null;
/** Sector stages from the stored intel snapshots (narratives.ts), cached an hour; empty without a database. */
function defaultStages(sectors: () => SectorsData): () => Promise<Map<string, NarrativeStage>> {
  return () => {
    if (!databaseUrl()) return Promise.resolve(new Map());
    if (!stagesCache || Date.now() - stagesCache.at >= STAGES_TTL_MS) {
      const value = loadNarrativeFlows({ store: new PgIntelStore(), now: () => new Date(), sectors: sectors(), history: SECTORS_HISTORY })
        .then((flows) => new Map(flows.map((f) => [f.id, f.stage] as const)));
      value.catch(() => (stagesCache = null));
      stagesCache = { at: Date.now(), value };
    }
    return stagesCache.value;
  };
}

let dbCtx: PlatformContext | null = null;
let intelStore: PgIntelStore | null = null;

export function defaultMovesDeps(o: { env?: Record<string, string | undefined>; log?: (m: string) => void } = {}): MovesDeps {
  const env = o.env ?? process.env;
  const sectors = () => SectorsDataSchema.parse(sectorsLatest);
  return {
    candles: candleMemo,
    funding: fundingMemo,
    ctxs: async () => (await getCtxs()).ctxs,
    platform: () => getPlatformContext() ?? (databaseUrl() ? (dbCtx ??= dbPlatformContext(new PgPlatformStore())) : null),
    intel: () => (databaseUrl() ? (intelStore ??= new PgIntelStore()) : null),
    social: loadSocial,
    stages: defaultStages(sectors),
    sectors,
    now: Date.now,
    serverless: isServerless(env),
    mine: myMarkets(env.PLATFORM_MY_MARKETS),
    log: o.log,
  };
}

let singleton: MovesService | null = null;
/** The process's moves service on the default deps. */
export function getMovesService(): MovesService {
  singleton ??= createMovesService(defaultMovesDeps());
  return singleton;
}
