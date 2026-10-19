import type { NoveltyEntry, NoveltyFeature } from "../../shared/platform.js";

// Novelty detector (FEATURES.md section 4): has this coin ever been here? Pure: detection on closed daily
// bars against the coin's own history, then admission (dedupe, which hits are pushed). Information only.

const DAY = 86_400_000;
export const NOVELTY = { minBars: 365, minFeatureHistory: 90, minOiDays: 365, cooldownDays: 3, runBudget: 3, retryDays: 3 };
export type NoveltyCfg = typeof NOVELTY;

/** Aligned daily columns, one row per closed UTC day (t = day start, ms). null = not known that day. */
export interface NoveltyDaily {
  t: number[];
  c: number[];
  v: number[];
  /** Mean hourly funding rate of the day. */
  f: (number | null)[];
  /** Open interest in USD, last of the day. */
  oi: (number | null)[];
}

type Family = NoveltyEntry["families"][number];
const FAMILY: Record<string, Family> = {
  funding_z90: "funding", "funding_apr(7)": "funding", "oi_from_peak(20)": "oi", "oi_change(7)": "oi", "ret(7)": "price", rv5to60: "price", vol_x: "price",
};
const IDS = Object.keys(FAMILY);
const ORDER: Family[] = ["funding", "oi", "price"];
const familiesOf = (ids: string[]) => ORDER.filter((f) => ids.some((id) => FAMILY[id] === f));

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Feature `id` at bar i; null where its inputs don't cover the bar. */
function at(d: NoveltyDaily, id: string, i: number): number | null {
  const { c, v, f, oi } = d;
  const oiCoins = (j: number) => (ok(oi[j]) && c[j]! > 0 ? oi[j]! / c[j]! : null);
  const rv = (n: number) => (i >= n ? stdev(Array.from({ length: n }, (_, k) => Math.log(c[i - k]! / c[i - k - 1]!))) : null);
  let x: number | null = null;
  if (id === "ret(7)") x = i >= 7 ? c[i]! / c[i - 7]! - 1 : null;
  else if (id === "vol_x") x = i >= 20 ? v[i]! / mean(v.slice(i - 20, i)) : null;
  else if (id === "rv5to60") {
    const a = rv(5), b = rv(60);
    x = a != null && b != null ? a / b : null;
  } else if (id === "funding_apr(7)") {
    const w = f.slice(i - 6, i + 1);
    x = i >= 6 && w.every(ok) ? mean(w as number[]) * 24 * 365 * 100 : null;
  } else if (id === "funding_z90") {
    const w = f.slice(Math.max(0, i - 90), i).filter(ok);
    const s = w.length >= 60 && ok(f[i]) ? stdev(w) : 0;
    x = s > 0 ? (f[i]! - mean(w)) / s : null;
  } else if (id === "oi_change(7)") {
    const a = oiCoins(i), b = i >= 7 ? oiCoins(i - 7) : null;
    x = a != null && b ? a / b - 1 : null;
  } else if (id === "oi_from_peak(20)") {
    const w = i >= 19 ? Array.from({ length: 20 }, (_, k) => oiCoins(i - k)) : [];
    x = w.length && w.every(ok) ? w[0]! / Math.max(...(w as number[])) - 1 : null;
  }
  return ok(x) ? x : null;
}

/** Linear-interpolated quantile of an ascending array. */
const quantile = (s: number[], q: number) => {
  const k = (s.length - 1) * q, lo = Math.floor(k);
  return s[lo]! + (s[Math.ceil(k)]! - s[lo]!) * (k - lo);
};

export interface NoveltyHit {
  kind: NoveltyEntry["kind"];
  /** Every monitored feature beyond its own 1st/99th percentile. */
  features: NoveltyFeature[];
  /** How many of them are beyond the historical min/max. */
  newExtremes: number;
  families: Family[];
}

const cache = new WeakMap<NoveltyDaily, Map<string, (number | null)[]>>();
const series = (d: NoveltyDaily, id: string) => {
  const m = cache.get(d) ?? cache.set(d, new Map()).get(d)!;
  return m.get(id) ?? m.set(id, d.c.map((_, i) => at(d, id, i))).get(id)!;
};

/**
 * Bar `i` (default: the last) against every earlier bar. New extreme: a feature strictly beyond its historical
 * min/max. Joint extreme: features of two or more families beyond their 1st/99th percentile (linear interpolation).
 * `skipped` says what was not checked and why. Needs minBars closed bars; a non-OI feature needs minFeatureHistory
 * past values; OI features need minOiDays of OI.
 */
export function novelty(d: NoveltyDaily, i = d.c.length - 1, cfg: NoveltyCfg = NOVELTY): { hit: NoveltyHit | null; skipped: string[] } {
  const skipped: string[] = [];
  if (i + 1 < cfg.minBars) return { hit: null, skipped: [`fewer than ${cfg.minBars} closed bars`] };
  const oiDays = d.oi.slice(0, i + 1).filter(ok).length;
  const features: NoveltyFeature[] = [];
  let newExtremes = 0;
  for (const id of IDS) {
    if (FAMILY[id] === "oi" && oiDays < cfg.minOiDays) {
      if (id === "oi_change(7)") skipped.push(`oi: OI history ${oiDays} of ${cfg.minOiDays} days`);
      continue;
    }
    const s = series(d, id), val = s[i];
    if (val == null) {
      skipped.push(`${id}: not measurable on the bar`);
      continue;
    }
    const hist = s.slice(0, i).filter(ok).sort((a, b) => a - b);
    if (hist.length < cfg.minFeatureHistory) {
      skipped.push(`${id}: under ${cfg.minFeatureHistory} past values`);
      continue;
    }
    const lo = hist[0]!, hi = hist.at(-1)!, p1 = quantile(hist, 0.01), p99 = quantile(hist, 0.99);
    if (!(val > p99 || val < p1)) continue;
    if (val > hi || val < lo) newExtremes++;
    const below = hist.filter((x) => x < val).length, eq = hist.filter((x) => x === val).length;
    features.push({ id, value: r4(val), histMin: r4(lo), histMax: r4(hi), p1: r4(p1), p99: r4(p99), bars: hist.length, pctRank: Math.round(((below + eq / 2) / hist.length) * 1000) / 10 });
  }
  const families = familiesOf(features.map((f) => f.id));
  const kind = newExtremes ? "new_extreme" : families.length >= 2 ? "joint_extreme" : null;
  return { hit: kind ? { kind, features, newExtremes, families } : null, skipped };
}

export interface Candidate {
  coin: string;
  /** OI rank this run; breaks extremeness ties (lower first). */
  rank: number;
  hit: NoveltyHit;
  nearSetups: string[];
}

const dayMs = (bar: string) => Date.parse(`${bar}T00:00:00Z`);

/**
 * New journal entries for one bar; every hit is journalled, deduped per (coin, bar) against `log`. Only new extremes
 * are pushed: a coin pushed within cooldownDays of the bar (either side) is suppressed as cooldown; past `budget`
 * pushes left, the rest are run_cap. Joint-only hits are never pushed. Most extreme first: more new extremes, then
 * more features, then OI rank.
 */
export function admit(bar: string, cands: Candidate[], log: NoveltyEntry[], budget: number, detectedAt: string, cfg: NoveltyCfg = NOVELTY): NoveltyEntry[] {
  const known = new Set(log.map((e) => e.id));
  return cands
    .filter((c) => !known.has(`${bar}:${c.coin}`))
    .sort((a, b) => b.hit.newExtremes - a.hit.newExtremes || b.hit.features.length - a.hit.features.length || a.rank - b.rank)
    .map((c): NoveltyEntry => {
      const novel = c.hit.kind === "new_extreme";
      const cooling = log.some((e) => e.coin === c.coin && e.pushed && e.barDate !== bar && Math.abs(dayMs(bar) - dayMs(e.barDate)) < cfg.cooldownDays * DAY);
      const suppressed = !novel ? undefined : cooling ? "cooldown" : budget > 0 ? undefined : "run_cap";
      const pushed = novel && !suppressed;
      if (pushed) budget--;
      return {
        id: `${bar}:${c.coin}`, detectedAt, barDate: bar, coin: c.coin, kind: c.hit.kind, families: c.hit.families, features: c.hit.features,
        nearSetups: c.nearSetups, marketWide: c.coin === "BTC", pushed, ...(suppressed ? { suppressed } : {}), notified: [],
      };
    });
}

/** admit over every bar one run evaluates (a late run backfills several): the newest bar gets the push budget first. Oldest bar first out. */
export function admitRun(byBar: Array<{ bar: string; cands: Candidate[] }>, log: NoveltyEntry[], budget: number, detectedAt: string, cfg: NoveltyCfg = NOVELTY): NoveltyEntry[] {
  const out: NoveltyEntry[] = [];
  for (const { bar, cands } of [...byBar].sort((a, b) => b.bar.localeCompare(a.bar))) {
    const added = admit(bar, cands, [...log, ...out], budget, detectedAt, cfg);
    out.push(...added);
    budget -= added.filter((e) => e.pushed).length;
  }
  return out.sort((a, b) => a.barDate.localeCompare(b.barDate));
}

/** Pushed entries no channel has taken yet, for bars closed within `days`: retried each run. */
export const pendingNovel = (log: NoveltyEntry[], now: number, days = NOVELTY.retryDays) =>
  log.filter((e) => e.pushed && !e.notified.some((n) => n.channels.length) && dayMs(e.barDate) + DAY >= now - days * DAY);

/** Alert text: facts only. */
export function novelText(e: NoveltyEntry): { title: string; body: string } {
  const news = e.features.filter((f) => f.value > f.histMax || f.value < f.histMin);
  const ids = news.map((f) => f.id).join(", ");
  const cover = e.nearSetups.length ? `near: ${e.nearSetups.join(", ")}` : "no setup covers this";
  return {
    title: `NOVEL: ${e.coin} — ${ids} — ${cover}`,
    body: [`new extreme on bar ${e.barDate}${e.marketWide ? " · market-wide (BTC)" : ""}`, ...news.map((f) => `${f.id} ${f.value} (history ${f.histMin} to ${f.histMax}, pct rank ${f.pctRank})`)].join("\n"),
  };
}

/** The detector over the last `days` closed bars of each coin, admitted oldest bar first as a live run would: the measured push rate. */
export function replay(dailies: Record<string, NoveltyDaily>, days = 365, cfg: NoveltyCfg = NOVELTY): { entries: NoveltyEntry[]; perDay: Record<string, { entries: number; pushes: number }> } {
  const coins = Object.keys(dailies);
  const last = Math.max(...coins.map((c) => dailies[c]!.t.at(-1) ?? 0));
  const log: NoveltyEntry[] = [], perDay: Record<string, { entries: number; pushes: number }> = {};
  for (let k = days - 1; k >= 0; k--) {
    const t = last - k * DAY, bar = new Date(t).toISOString().slice(0, 10);
    const cands = coins.flatMap((coin, rank): Candidate[] => {
      const d = dailies[coin]!, i = d.t.indexOf(t), { hit } = i < 0 ? { hit: null } : novelty(d, i, cfg);
      return hit ? [{ coin, rank, hit, nearSetups: [] }] : [];
    });
    const added = admit(bar, cands, log, cfg.runBudget, bar, cfg);
    log.push(...added);
    perDay[bar] = { entries: added.length, pushes: added.filter((e) => e.pushed).length };
  }
  return { entries: log, perDay };
}
