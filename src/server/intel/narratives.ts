import { SectorsDataSchema } from "../../shared/schemas.js";
import type { FixedWindow, FlowQuadrant, IntelEvent, NarrativeFlow, NarrativeHeadline, NarrativeHtf, NarrativeStage, NarrativeWindow, SnapshotRow } from "../../shared/intel.js";
import type { SectorsData } from "../../shared/types.js";
import type { Point } from "./normalize.js";
import type { IntelStore } from "./store.js";
import { fin } from "./util.js";
import { FIXED_WINDOWS, robustLevelZ, spanResult, windowResult, type Series } from "./windows.js";

// Narrative flow (docs/SPEC.md § Narratives). Pure, no LLM. A narrative is one
// of the routine's sector baskets, read as one composite asset from the stored
// intel snapshots of its tokens:
//   price    equal-weight index, chained: each step multiplies by the mean
//            price ratio of the tokens present at both snapshot times
//   oi_usd   chained the same way on the summed OI of those tokens, so a token
//            entering coverage never reads as an inflow
//   funding  OI-weighted mean hourly rate at each snapshot time (a level)
// The composite runs through windows.ts unchanged: LTF = 1h/6h/24h Δ and z,
// HTF = 7d/30d Δ (too few independent 7d windows in 90 days for a z) plus
// funding's 30-day level z.
//
// Stage (HTF, from the numbers shown beside it). "Beating"/"lagging" BTC means by
// more than REL_MIN_PP percentage points, OI "up"/"down" by more than OI_MIN_PCT %,
// so noise around zero never names a stage:
//   unknown    7d relative strength or 7d OI change missing
//   crowded    funding level z ≥ 2 while 7d OI is up
//   emerging   beating BTC over 7d with OI up, not over 30d (or no 30d yet)
//   expanding  beating BTC over 7d and 30d with OI up
//   fading     beat BTC over 30d, now lagging over 7d or 7d OI down
//   quiet      anything else
// LTF quadrant per window: OI z ≥ 1 with price z ≥ 1 long_build, ≤ −1
// short_build; OI z ≤ −1 with price z ≥ 1 short_cover, ≤ −1 long_unwind.
// Alignment compares the strongest non-quiet window's direction with the
// basket's own 7d price direction.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const HTF_DAYS = [7, 30] as const;
/** Snapshot history read per token: the 30-day span plus its ±20 min endpoint tolerance. */
export const NARRATIVE_LOOKBACK_DAYS = 31;
export const QUADRANT_Z = 1;
export const CROWDED_FUNDING_Z = 2;
export const REL_MIN_PP = 1;
export const OI_MIN_PCT = 1;
/** Basket tokens added to the snapshot collect beyond held ∪ watched ∪ top-20 (bounds the write volume). */
export const MAX_BASKET_COINS = 60;
export const BENCHMARK = "BTC";

/** The basket composite: price and OI indexes and the OI-weighted funding level, ascending. */
export function basketSeries(members: SnapshotRow[][]): Series {
  const byTs = new Map<number, Map<string, SnapshotRow>>();
  for (const rows of members) {
    for (const r of rows) {
      const t = Date.parse(r.ts);
      if (Number.isFinite(t)) (byTs.get(t) ?? byTs.set(t, new Map()).get(t)!).set(r.asset, r);
    }
  }
  const times = [...byTs.keys()].sort((a, b) => a - b);
  const price: Point[] = [];
  const oi: Point[] = [];
  const funding: Point[] = [];
  let px = 1;
  let oiIdx = 1;
  let prev: Map<string, SnapshotRow> | null = null;
  for (const t of times) {
    const cur = byTs.get(t)!;
    if (prev) {
      const ratios: number[] = [];
      let oiNow = 0;
      let oiThen = 0;
      for (const [asset, r] of cur) {
        const p = prev.get(asset);
        if (!p) continue;
        if (r.price > 0 && p.price > 0) ratios.push(r.price / p.price);
        if (r.oiUsd != null && p.oiUsd != null && r.oiUsd > 0 && p.oiUsd > 0) (oiNow += r.oiUsd, (oiThen += p.oiUsd));
      }
      if (ratios.length) px *= ratios.reduce((s, x) => s + x, 0) / ratios.length;
      if (oiThen > 0) oiIdx *= oiNow / oiThen;
    }
    price.push({ t, v: px });
    oi.push({ t, v: oiIdx });
    let w = 0;
    let f = 0;
    for (const r of cur.values()) {
      if (r.funding == null || r.oiUsd == null || !(r.oiUsd > 0)) continue;
      w += r.oiUsd;
      f += r.funding * r.oiUsd;
    }
    if (w > 0) funding.push({ t, v: f / w });
    prev = cur;
  }
  return { price, oi_usd: oi, funding };
}

export function quadrant(priceZ: number | null, oiZ: number | null): FlowQuadrant {
  if (priceZ == null || oiZ == null) return "unknown";
  if (oiZ >= QUADRANT_Z && priceZ >= QUADRANT_Z) return "long_build";
  if (oiZ >= QUADRANT_Z && priceZ <= -QUADRANT_Z) return "short_build";
  if (oiZ <= -QUADRANT_Z && priceZ >= QUADRANT_Z) return "short_cover";
  if (oiZ <= -QUADRANT_Z && priceZ <= -QUADRANT_Z) return "long_unwind";
  return "quiet";
}

export function ltfWindows(s: Series, now: number): NarrativeWindow[] {
  return FIXED_WINDOWS.map((window: FixedWindow) => {
    const p = windowResult("price", s.price, now, window);
    const o = windowResult("oi_usd", s.oi_usd, now, window);
    return { window, pricePct: p.delta, priceZ: p.z, oiPct: o.delta, oiZ: o.z, quadrant: quadrant(p.z, o.z) };
  });
}

const pctOver = (points: Point[] | undefined, now: number, days: number) => spanResult("price", points, now, days * DAY_MS).delta;
const oiOver = (points: Point[] | undefined, now: number, days: number) => spanResult("oi_usd", points, now, days * DAY_MS).delta;
const minus = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);

/** HTF facts of the basket against the benchmark composite (BTC alone). */
export function htfFacts(s: Series, btc: Series, now: number): NarrativeHtf {
  const [d7, d30] = HTF_DAYS;
  const pricePct7d = pctOver(s.price, now, d7);
  const pricePct30d = pctOver(s.price, now, d30);
  const last = s.funding?.at(-1);
  return {
    pricePct7d,
    pricePct30d,
    relBtc7d: minus(pricePct7d, pctOver(btc.price, now, d7)),
    relBtc30d: minus(pricePct30d, pctOver(btc.price, now, d30)),
    oiPct7d: oiOver(s.oi_usd, now, d7),
    oiPct30d: oiOver(s.oi_usd, now, d30),
    funding: last && Math.abs(last.t - now) <= HOUR_MS ? last.v : null,
    fundingZ: fin(robustLevelZ("funding", s.funding, now)),
  };
}

export function stage(h: NarrativeHtf): NarrativeStage {
  const { relBtc7d: r7, relBtc30d: r30, oiPct7d: oi7, fundingZ } = h;
  if (r7 == null || oi7 == null) return "unknown";
  const oiUp = oi7 > OI_MIN_PCT;
  const beat30 = r30 != null && r30 > REL_MIN_PP;
  if (fundingZ != null && fundingZ >= CROWDED_FUNDING_Z && oiUp) return "crowded";
  if (r7 > REL_MIN_PP && oiUp) return beat30 ? "expanding" : "emerging";
  if (beat30 && (r7 < -REL_MIN_PP || oi7 < -OI_MIN_PCT)) return "fading";
  return "quiet";
}

const DIRECTION: Record<FlowQuadrant, 1 | -1 | 0> = { long_build: 1, short_cover: 1, short_build: -1, long_unwind: -1, quiet: 0, unknown: 0 };
const strength = (w: NarrativeWindow) => Math.max(Math.abs(w.priceZ ?? 0), Math.abs(w.oiZ ?? 0));

export function alignment(ltf: NarrativeWindow[], pricePct7d: number | null): NarrativeFlow["alignment"] {
  const moving = ltf.filter((w) => DIRECTION[w.quadrant] !== 0).sort((a, b) => strength(b) - strength(a))[0];
  if (!moving || pricePct7d == null || pricePct7d === 0) return "none";
  return DIRECTION[moving.quadrant] === Math.sign(pricePct7d) ? "with" : "against";
}

export function flowScore(ltf: NarrativeWindow[]): number | null {
  const zs = ltf.flatMap((w) => [w.priceZ, w.oiZ]).filter((z): z is number => z != null);
  return zs.length ? Math.max(...zs.map(Math.abs)) : null;
}

/** Earliest dated routine file listing each sector id (files that fail the schema are skipped). */
export function firstSeenById(history: Array<{ date: string; data: unknown }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { date, data } of [...history].sort((a, b) => a.date.localeCompare(b.date))) {
    const parsed = SectorsDataSchema.safeParse(data);
    if (!parsed.success) continue;
    for (const s of parsed.data.sectors) if (!out.has(s.id)) out.set(s.id, date);
  }
  return out;
}

/** Every basket token, deduped, in sector order, capped: the snapshot collect's extra coins. */
export function basketCoins(sectors: SectorsData, max = MAX_BASKET_COINS): string[] {
  return [...new Set(sectors.sectors.flatMap((s) => s.tokens))].slice(0, max);
}

/** One narrative's flow from its tokens' rows (keyed by asset) and the benchmark composite. */
export function narrativeFlow(
  sector: SectorsData["sectors"][number],
  rows: Map<string, SnapshotRow[]>,
  btc: Series,
  now: number,
  firstSeen: string | null,
): NarrativeFlow {
  const covered = sector.tokens.filter((t) => (rows.get(t)?.length ?? 0) > 0);
  const series = basketSeries(covered.map((t) => rows.get(t)!));
  const htf = htfFacts(series, btc, now);
  const ltf = ltfWindows(series, now);
  const latest = covered.map((t) => rows.get(t)!.at(-1)!).filter((r) => now - Date.parse(r.ts) <= HOUR_MS);
  const oiUsd = latest.some((r) => r.oiUsd != null) ? latest.reduce((s, r) => s + (r.oiUsd ?? 0), 0) : null;
  return {
    id: sector.id,
    label: sector.label,
    tokens: sector.tokens,
    covered,
    missing: sector.tokens.filter((t) => !covered.includes(t)),
    oiUsd,
    firstSeen,
    htf,
    stage: stage(htf),
    ltf,
    alignment: alignment(ltf, htf.pricePct7d),
    flowScore: flowScore(ltf),
  };
}

/** Strongest LTF flow first; narratives with no z at all last, in sector order. */
export function rankNarratives<T extends Pick<NarrativeFlow, "flowScore">>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.flowScore ?? -1) - (a.r.flowScore ?? -1) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Events whose mapped assets name a basket token (case-insensitive), newest first,
 * one per news cluster (an event without a cluster stands alone), at most `max`.
 */
export function narrativeHeadlines(events: IntelEvent[], tokens: string[], max: number): NarrativeHeadline[] {
  const byLower = new Map(tokens.map((t) => [t.toLowerCase(), t]));
  const clusters = new Set<string>();
  const out: NarrativeHeadline[] = [];
  const sorted = [...events].sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));
  for (const e of sorted) {
    if (out.length >= max) break;
    const assets = [...new Set(e.assets.map((a) => byLower.get(a.toLowerCase())).filter((t): t is string => t != null))];
    if (!assets.length) continue;
    if (e.clusterId) {
      if (clusters.has(e.clusterId)) continue;
      clusters.add(e.clusterId);
    }
    out.push({ title: e.title, firstSeen: e.firstSeen, url: e.sources.find((s) => s.url)?.url ?? null, assets });
  }
  return out;
}

export interface NarrativeFlowDeps {
  store: Pick<IntelStore, "snapshotRange">;
  now(): Date;
  sectors: SectorsData;
  history: Array<{ date: string; data: unknown }>;
}

/** Reads each basket token's (and the benchmark's) snapshots once, then builds every narrative. */
export async function loadNarrativeFlows(deps: NarrativeFlowDeps): Promise<NarrativeFlow[]> {
  const now = deps.now();
  const from = new Date(now.getTime() - NARRATIVE_LOOKBACK_DAYS * DAY_MS);
  const coins = [...new Set([BENCHMARK, ...deps.sectors.sectors.flatMap((s) => s.tokens)])];
  const rows = new Map(await Promise.all(coins.map(async (c) => [c, await deps.store.snapshotRange(c, from, now)] as const)));
  const btc = basketSeries([rows.get(BENCHMARK) ?? []]);
  const seen = firstSeenById(deps.history);
  const t = now.getTime();
  return rankNarratives(deps.sectors.sectors.map((s) => narrativeFlow(s, rows, btc, t, seen.get(s.id) ?? null)));
}
