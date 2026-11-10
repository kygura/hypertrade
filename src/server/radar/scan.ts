import { RADAR_STATE_DAYS, type RadarDay, type RadarState } from "../../shared/radar.js";
import { SIGNAL } from "../../shared/signals.js";
import type { AssetCtx, Candle } from "../../shared/types.js";

// The radar scan (ROUTINE.md §1): every live perp on every Hyperliquid dex (main plus HIP-3), diffed against the
// committed daily memory in data/radar/state.json. Pure: scripts/radar.ts does the fetching and file I/O.
// Code only lists what is unusual; the routine session decides what any of it means.

export const RADAR = {
  /** Floor for movers, spikes and premium: below it a print is noise. */
  minVolUsd: SIGNAL.minVolUsd,
  /** Floor for funding and OI reads. */
  minOiUsd: SIGNAL.minOiUsd,
  topN: 8,
  fundingAprAbs: SIGNAL.fundingAprAbs,
  premiumBpsAbs: SIGNAL.premiumBpsAbs,
  volSpikeX: 3,
  oiChgPctAbs: 25,
  rankTop: 30,
  /** A 7-day lookback accepts a snapshot 7 to 9 days old. */
  weekMinDays: 7,
  weekMaxDays: 9,
} as const;

export interface DexBook {
  /** "" is the main dex. */
  dex: string;
  ctxs: AssetCtx[];
}

/** "main" for a main-dex key ("BTC"), the dex prefix for a HIP-3 key ("xyz:SKHX" → "xyz"). */
export const dexOf = (key: string) => (key.includes(":") ? key.slice(0, key.indexOf(":")) : "main");

export interface RadarMarket {
  /** As HL names it: "BTC" on the main dex, "xyz:SKHX" on a HIP-3 dex. */
  key: string;
  dex: string;
  mark: number;
  chg24hPct: number | null;
  vol24h: number;
  oiUsd: number;
  /** HL funding settles hourly. */
  fundingApr: number;
  premiumBps: number;
  atCap: boolean;
}

export interface Mover extends RadarMarket {
  chgPct: number;
}

export interface Digest {
  date: string;
  btc: number | null;
  history: { days: number; seeded: number; prevDate: string | null; weekDate: string | null };
  /** Median funding over markets with OI >= the floor: the dex's normal, to judge crowding against. */
  dexes: { dex: string; markets: number; vol24h: number; oiUsd: number; volSharePct: number; medianFundingApr: number | null }[];
  up24h: Mover[];
  down24h: Mover[];
  up7d: Mover[] | null;
  down7d: Mover[] | null;
  volSpikes: (RadarMarket & { x: number })[] | null;
  oiMoves: (RadarMarket & { oiChgPct: number })[] | null;
  funding: RadarMarket[];
  premium: RadarMarket[];
  atCap: string[];
  newListings: RadarMarket[] | null;
  rankEntrants: RadarMarket[] | null;
}

const finiteOr0 = (x: number) => (Number.isFinite(x) ? x : 0);

export function toMarkets(books: DexBook[], atCap: ReadonlySet<string>): RadarMarket[] {
  const out: RadarMarket[] = [];
  for (const b of books)
    for (const c of b.ctxs) {
      if (c.isDelisted || !(c.markPx > 0)) continue;
      out.push({
        key: c.name,
        dex: b.dex || "main",
        mark: c.markPx,
        chg24hPct: c.prevDayPx > 0 ? (c.markPx / c.prevDayPx - 1) * 100 : null,
        vol24h: finiteOr0(c.dayNtlVlm),
        oiUsd: finiteOr0(c.openInterest * c.markPx),
        fundingApr: finiteOr0(c.funding) * 24 * 365 * 100,
        premiumBps: finiteOr0(c.premium) * 10_000,
        atCap: atCap.has(c.name),
      });
    }
  return out;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const topVolKeys = (entries: [string, number][], n: number) => new Set([...entries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map((e) => e[0]));

/** Days strictly before `today`, oldest first. A same-day snapshot from an earlier run is not history. */
const pastDays = (state: RadarState | null, today: string) => (state?.days ?? []).filter((d) => d.date < today).sort((a, b) => (a.date < b.date ? -1 : 1));

export function digest(markets: RadarMarket[], state: RadarState | null, today: string): Digest {
  const past = pastDays(state, today);
  // Seeded days carry no OI and only liquid markets, so the diffs that need a full snapshot use real runs only.
  const real = past.filter((d) => !d.seeded);
  const prev: RadarDay | null = real.at(-1) ?? null;
  const week = [...past].reverse().find((d) => {
    const age = daysBetween(d.date, today);
    return age >= RADAR.weekMinDays && age <= RADAR.weekMaxDays;
  }) ?? null;

  const liquid = markets.filter((m) => m.vol24h >= RADAR.minVolUsd);
  const byChg = (rows: Mover[], dir: 1 | -1) => rows.filter((r) => r.chgPct * dir > 0).sort((a, b) => (b.chgPct - a.chgPct) * dir).slice(0, RADAR.topN);
  const movers24 = liquid.flatMap((m) => (m.chg24hPct == null ? [] : [{ ...m, chgPct: m.chg24hPct }]));
  const movers7 = week
    ? liquid.flatMap((m) => {
        const then = week.marks[m.key];
        return then && then[0] > 0 ? [{ ...m, chgPct: (m.mark / then[0] - 1) * 100 }] : [];
      })
    : null;

  const volSpikes =
    past.length >= 2
      ? liquid
          .flatMap((m) => {
            const vols = past.map((d) => d.marks[m.key]?.[1]).filter((v): v is number => v != null && v > 0);
            if (vols.length < 2) return [];
            const x = m.vol24h / median(vols);
            return x >= RADAR.volSpikeX ? [{ ...m, x }] : [];
          })
          .sort((a, b) => b.x - a.x)
          .slice(0, RADAR.topN)
      : null;

  const oiMoves = prev
    ? markets
        .flatMap((m) => {
          // Contracts, not USD: a price move alone must not read as positioning.
          const [thenMark, , thenOiUsd] = prev.marks[m.key] ?? [0, 0, 0];
          if (!thenMark || !thenOiUsd || Math.max(m.oiUsd, thenOiUsd) < RADAR.minOiUsd) return [];
          const oiChgPct = (m.oiUsd / m.mark / (thenOiUsd / thenMark) - 1) * 100;
          return Math.abs(oiChgPct) >= RADAR.oiChgPctAbs ? [{ ...m, oiChgPct }] : [];
        })
        .sort((a, b) => Math.abs(b.oiChgPct) - Math.abs(a.oiChgPct))
        .slice(0, RADAR.topN)
    : null;

  const seen = new Set(real.flatMap((d) => Object.keys(d.marks)));
  const newListings = real.length ? markets.filter((m) => !seen.has(m.key)).sort((a, b) => b.vol24h - a.vol24h) : null;

  let rankEntrants: RadarMarket[] | null = null;
  if (prev) {
    // Rank over the dexes this scan reached, so a dex that failed today cannot promote others into the top.
    const scanned = new Set(markets.map((m) => m.dex));
    const before = topVolKeys(Object.entries(prev.marks).filter(([k]) => scanned.has(dexOf(k))).map(([k, v]) => [k, v[1]]), RADAR.rankTop);
    const now = topVolKeys(markets.map((m) => [m.key, m.vol24h]), RADAR.rankTop);
    rankEntrants = markets.filter((m) => now.has(m.key) && !before.has(m.key)).sort((a, b) => b.vol24h - a.vol24h);
  }

  const dexTotals = new Map<string, { markets: number; vol24h: number; oiUsd: number }>();
  for (const m of markets) {
    const t = dexTotals.get(m.dex) ?? { markets: 0, vol24h: 0, oiUsd: 0 };
    t.markets += 1;
    t.vol24h += m.vol24h;
    t.oiUsd += m.oiUsd;
    dexTotals.set(m.dex, t);
  }
  const totalVol = [...dexTotals.values()].reduce((s, t) => s + t.vol24h, 0);
  const dexFunding = (dex: string) => {
    const xs = markets.filter((m) => m.dex === dex && m.oiUsd >= RADAR.minOiUsd).map((m) => m.fundingApr);
    return xs.length ? median(xs) : null;
  };

  return {
    date: today,
    btc: markets.find((m) => m.key === "BTC")?.mark ?? null,
    history: { days: past.length, seeded: past.length - real.length, prevDate: prev?.date ?? null, weekDate: week?.date ?? null },
    dexes: [...dexTotals.entries()]
      .map(([dex, t]) => ({ dex, ...t, volSharePct: totalVol > 0 ? (t.vol24h / totalVol) * 100 : 0, medianFundingApr: dexFunding(dex) }))
      .sort((a, b) => b.vol24h - a.vol24h),
    up24h: byChg(movers24, 1),
    down24h: byChg(movers24, -1),
    up7d: movers7 && byChg(movers7, 1),
    down7d: movers7 && byChg(movers7, -1),
    volSpikes,
    oiMoves,
    funding: markets
      .filter((m) => m.oiUsd >= RADAR.minOiUsd && Math.abs(m.fundingApr) >= RADAR.fundingAprAbs)
      .sort((a, b) => Math.abs(b.fundingApr) - Math.abs(a.fundingApr))
      .slice(0, RADAR.topN),
    premium: liquid
      .filter((m) => Math.abs(m.premiumBps) >= RADAR.premiumBpsAbs)
      .sort((a, b) => Math.abs(b.premiumBps) - Math.abs(a.premiumBps))
      .slice(0, RADAR.topN),
    atCap: markets.filter((m) => m.atCap).map((m) => m.key),
    newListings,
    rankEntrants,
  };
}

/** 5 significant figures: enough to diff prices and sizes, small enough to commit daily. */
const sig = (x: number) => (x === 0 || !Number.isFinite(x) ? 0 : Number(x.toPrecision(5)));

/**
 * This run's snapshot replaces any earlier one from the same date; the oldest days roll off. A dex in `failed`
 * keeps its markets from the last real snapshot, so tomorrow's diffs do not see it vanish and reappear.
 */
export function nextState(state: RadarState | null, markets: RadarMarket[], today: string, at: string, failed: readonly string[] = []): RadarState {
  const marks: RadarDay["marks"] = {};
  for (const m of markets) marks[m.key] = [sig(m.mark), sig(m.vol24h), sig(m.oiUsd)];
  const lastReal = [...(state?.days ?? [])].filter((d) => !d.seeded && d.date < today).sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1);
  if (lastReal && failed.length) for (const [k, v] of Object.entries(lastReal.marks)) if (failed.includes(dexOf(k)) && !marks[k]) marks[k] = v;
  const dexes = [...new Set([...markets.map((m) => m.dex), ...failed])].sort();
  const days = [...(state?.days ?? []).filter((d) => d.date !== today), { date: today, at, marks, dexes }].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { days: days.slice(-RADAR_STATE_DAYS) };
}

/** Change from the first snapshot on or after `date` to the scan's mark, absolute and relative to BTC. */
export function moveSince(state: RadarState, m: RadarMarket, btcNow: number, date: string): { fromDate: string; pct: number; vsBtcPct: number } | null {
  const day = [...state.days].sort((a, b) => (a.date < b.date ? -1 : 1)).find((d) => d.date >= date && d.marks[m.key]?.[0] && d.marks["BTC"]?.[0]);
  if (!day) return null;
  const then = day.marks[m.key]![0];
  const btcThen = day.marks["BTC"]![0];
  return { fromDate: day.date, pct: (m.mark / then - 1) * 100, vsBtcPct: ((m.mark / then) / (btcNow / btcThen) - 1) * 100 };
}

/** `bun run radar show`: each market's full line, its recent daily marks, and the move since a date. */
export function showMarkets(markets: RadarMarket[], state: RadarState, keys: string[], since?: string): string[] {
  const byKey = new Map(markets.map((m) => [m.key, m]));
  const btc = byKey.get("BTC")?.mark;
  const days = [...state.days].sort((a, b) => (a.date < b.date ? -1 : 1));
  return keys.flatMap((k) => {
    const m = byKey.get(k);
    if (!m) return [`${k}: not a live market in this scan`];
    const hist = days.flatMap((d) => (d.marks[k] ? [`${d.date.slice(5)} ${px(d.marks[k]![0])}`] : []));
    const out = [line(m), `  daily marks: ${hist.length ? hist.join(" · ") : "none in memory"}`];
    if (since && btc != null) {
      const mv = moveSince(state, m, btc, since);
      out.push(mv ? `  since ${mv.fromDate}: ${pct(mv.pct)} (${pct(mv.vsBtcPct)} vs BTC)` : `  since ${since}: no snapshot that old in memory`);
    }
    return out;
  });
}

/**
 * One-off backfill (`bun run radar seed`): daily candles for the liquid markets become seeded days for the
 * `days` UTC dates before `today`. Days the state already has are left alone.
 */
export function seedDays(state: RadarState | null, candles: Map<string, Candle[]>, today: string, days: number = RADAR.weekMaxDays): RadarState {
  const have = new Set((state?.days ?? []).map((d) => d.date));
  const added: RadarDay[] = [];
  for (let i = days; i >= 1; i--) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) - i * DAY_MS).toISOString().slice(0, 10);
    if (have.has(date)) continue;
    const marks: RadarDay["marks"] = {};
    // A snapshot dated D is taken during D, so it pairs with the candle that closed at D 00:00 UTC (day D-1).
    const prior = new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
    for (const [key, rows] of candles) {
      const c = rows.find((r) => new Date(r.t).toISOString().slice(0, 10) === prior);
      if (c && c.c > 0) marks[key] = [sig(c.c), sig(c.v * c.c), 0];
    }
    if (Object.keys(marks).length) added.push({ date, at: `${date}T00:00:00Z`, marks, seeded: true });
  }
  const all = [...(state?.days ?? []), ...added].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { days: all.slice(-RADAR_STATE_DAYS) };
}

// ─── text for the session ───

const usd = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}k`);
const pct = (x: number | null) => (x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
const px = (x: number) => String(sig(x));
export const line = (m: RadarMarket) =>
  `${m.key} [${m.dex}] mark ${px(m.mark)} · 24h ${pct(m.chg24hPct)} · vol ${usd(m.vol24h)} · OI ${usd(m.oiUsd)} · fund ${m.fundingApr.toFixed(0)}% APR · prem ${m.premiumBps.toFixed(0)}bps${m.atCap ? " · AT OI CAP" : ""}`;

/**
 * `names` maps a dex code to its full name ("xyz" → "XYZ"), so the session can search for the deployer. `macro`
 * is radar/macro.ts macroLines(), printed ahead of the dexes.
 */
export function formatDigest(d: Digest, gaps: string[] = [], names: Record<string, string> = {}, macro: string[] = []): string {
  const out: string[] = [];
  const section = (title: string, rows: string[] | null, cold?: string) => {
    out.push(`\n## ${title}`);
    if (rows == null) out.push(`(cold start: ${cold ?? "needs more history"})`);
    else out.push(...(rows.length ? rows : ["(none)"]));
  };
  out.push(`# radar ${d.date} · BTC ${d.btc == null ? "n/a" : px(d.btc)} · history ${d.history.days}d${d.history.seeded ? ` (${d.history.seeded} seeded from candles)` : ""} (prev ${d.history.prevDate ?? "none"}, 7d base ${d.history.weekDate ?? "none"})`);
  if (gaps.length) out.push(`gaps: ${gaps.join("; ")}`);
  if (macro.length) section("macro (keyless · Δ over each series' own history · [as-of] dates the items before it)", macro);
  section(
    "dexes",
    d.dexes.map(
      (x) =>
        `${x.dex}${names[x.dex] && names[x.dex] !== x.dex ? ` (${names[x.dex]})` : ""}: ${x.markets} markets · vol ${usd(x.vol24h)} (${x.volSharePct.toFixed(1)}%) · OI ${usd(x.oiUsd)} · median fund ${x.medianFundingApr == null ? "n/a" : `${x.medianFundingApr.toFixed(0)}% APR`}`,
    ),
  );
  section("up 24h (vol >= $1M)", d.up24h.map(line));
  section("down 24h", d.down24h.map(line));
  section("up 7d", d.up7d && d.up7d.map((m) => `${pct(m.chgPct)} 7d · ${line(m)}`), "no snapshot 7-9 days old yet");
  section("down 7d", d.down7d && d.down7d.map((m) => `${pct(m.chgPct)} 7d · ${line(m)}`), "no snapshot 7-9 days old yet");
  section(`volume spikes (>= ${RADAR.volSpikeX}x the median of past days)`, d.volSpikes && d.volSpikes.map((m) => `${m.x.toFixed(1)}x · ${line(m)}`), "needs 2 past days");
  section(`OI moves since prev (|chg| >= ${RADAR.oiChgPctAbs}%)`, d.oiMoves && d.oiMoves.map((m) => `OI ${pct(m.oiChgPct)} · ${line(m)}`), "no previous snapshot");
  section(`funding extremes (|APR| >= ${RADAR.fundingAprAbs}%, OI >= $1M)`, d.funding.map(line));
  section(`premium vs oracle (|prem| >= ${RADAR.premiumBpsAbs}bps)`, d.premium.map(line));
  section("at OI cap", d.atCap.length ? [d.atCap.join(", ")] : []);
  section("new since memory", d.newListings && d.newListings.map(line), "no memory yet");
  section(`entered top ${RADAR.rankTop} by volume`, d.rankEntrants && d.rankEntrants.map(line), "no previous snapshot");
  return out.join("\n");
}
