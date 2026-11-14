// BTC Vector: daily-spine helpers and the Market Compass, ported from hl-cycles
// (backend/src/model/indicators.ts §8.1 helpers + model/compass.ts; docs/MODEL.md
// §8.2). Pure functions. The HTF indicators it shares (percentile rank, SMA,
// hysteresis) come from cycles.ts. Inputs, polarity and bands as in hl-cycles.

import { DAY_MS, percentileRank, sma } from "./cycles.js";
import type { InputUnit } from "./vector.js";

export const DAY = DAY_MS;

/** One daily observation keyed by its UTC day start. */
export type Row = { t: number; v: number };
/** One value per spine day, null = missing. */
export type Series = (number | null)[];
/** Hourly funding settlement; premium null when unknown (never fabricated as 0). */
export type FundingRow = { t: number; rate: number; premium: number | null };
/** Open interest observation (daily here: OKX end-of-day USD OI). */
export type OiRow = { t: number; oiUsd: number };
/** One rotation alt: daily closes (UTC day start) and hourly funding. */
export type AltData = { coin: string; closes: Row[]; funding: FundingRow[] };

/** Hyperliquid's neutral hourly funding (0.01% per 8h). */
const HL_NEUTRAL_HOURLY = 0.0000125;

const PCT_WINDOW = 1460; // rolling 4y
const PCT_MIN = 365; // expanding window minimum
export const CARRY_DAYS = 10; // D5 carry-forward, also used for compass inputs
const BREADTH_MIN_ALTS = 5; // rotation breadth is null with fewer reporting alts
// Relative float tolerance: an alt resting exactly at the neutral rate must not count as "hot".
const NEUTRAL_EPS = 1e-6;

// ─── daily-spine helpers (MODEL §8.1) ───

/**
 * Values of `rows` on a gap-free ascending daily spine, exact-day match only. With `zero`, days
 * between the first and last row that have no row read 0 (flows: no print = no flow).
 */
export function onSpine(rows: Row[], spine: number[], zero = false): Series {
  const byT = new Map(rows.map((r) => [r.t, r.v]));
  const first = rows.length ? rows[0]!.t : Infinity;
  const last = rows.length ? rows[rows.length - 1]!.t : -Infinity;
  return spine.map((t) => byT.get(t) ?? (zero && t >= first && t <= last ? 0 : null));
}

/** Forward-fill a null that follows a value, for at most `max` consecutive days (D5). */
export function carry(x: Series, max: number): Series {
  let last: number | null = null;
  let age = 0;
  return x.map((v) => {
    if (v != null) {
      last = v;
      age = 0;
      return v;
    }
    age++;
    return last != null && age <= max ? last : null;
  });
}

/** Trailing mean of x[i-k+1..i]; null if any value in the window is null. */
export function rollMean(x: Series, k: number): Series {
  return x.map((_, i) => {
    if (i < k - 1) return null;
    let s = 0;
    for (let j = i - k + 1; j <= i; j++) {
      const v = x[j];
      if (v == null) return null;
      s += v;
    }
    return s / k;
  });
}

/** x[i] / x[i-k] - 1, null-propagating. */
export function change(x: Series, k: number): Series {
  return x.map((v, i) => (i >= k && v != null && x[i - k] != null && x[i - k] !== 0 ? v / x[i - k]! - 1 : null));
}

/** Elementwise a op b, null if either side is null. */
export function zip(a: Series, b: Series, f: (x: number, y: number) => number | null): Series {
  return a.map((x, i) => (x == null || b[i] == null ? null : f(x, b[i]!)));
}

// ─── compass ───

export type CompassInput = {
  key: string;
  label: string;
  unit: InputUnit;
  polarity: 1 | -1;
  /** Rotation breadth shares: already a 0–100 cross-section, scored as-is (no time percentile). */
  raw?: boolean;
  values: Series;
  asOf: number | null;
};
export type LensSpec = { key: string; label: string; standalone: boolean; bands: string[]; inputs: CompassInput[] };

export type Ctx = {
  spine: number[];
  price: number[];
  heat: Series;
  /** Daily value on the spine, carried forward <= CARRY_DAYS. */
  s: (name: string) => Series;
  rows: (name: string) => Row[];
  asOf: (name: string) => number | null;
  funding: FundingRow[];
  oi: OiRow[];
  alts: AltData[];
};

export const HEADLINE_BANDS = ["Risk-Off", "Defensive", "Neutral", "Constructive", "Risk-On"];
export const FORWARD = ["macro", "flows", "behaviour", "fundamentals"];

/** Band from a 0–100 score (edges 20/40/60/80, 100 -> top band). */
export function bandOf(score: number | null, bands: string[]): string | null {
  return score == null ? null : bands[Math.min(4, Math.floor(score / 20))]!;
}

/** 0–100 percentile (raw, before polarity) per day: rolling 4y, expanding >= 365 values. */
export function inputPct(inp: Pick<CompassInput, "values" | "raw">): Series {
  return inp.raw ? inp.values : percentileRank(inp.values, PCT_WINDOW, PCT_MIN).map((p) => (p == null ? null : p * 100));
}

/** Polarity-adjusted score: high always means the lens's high pole. */
export function inputScore(inp: CompassInput): Series {
  return inputPct(inp).map((p) => (p == null ? null : inp.polarity > 0 ? p : 100 - p));
}

/** Mean of the non-null parts per day; null when fewer than half of the parts are present (D4). */
export function meanIfHalf(parts: Series[], n: number): Series {
  return Array.from({ length: n }, (_, i) => {
    let s = 0;
    let k = 0;
    for (const p of parts) {
      const v = p[i];
      if (v != null) {
        s += v;
        k++;
      }
    }
    return k * 2 < parts.length || k === 0 ? null : s / k;
  });
}

export type LensOut = LensSpec & { score: Series; pcts: Series[] };

export function computeCompass(lenses: LensSpec[], n: number): { lenses: LensOut[]; headline: Series } {
  const out = lenses.map((l) => ({
    ...l,
    pcts: l.inputs.map(inputPct),
    score: meanIfHalf(l.inputs.map(inputScore), n),
  }));
  const headline = meanIfHalf(
    out.filter((l) => FORWARD.includes(l.key)).map((l) => l.score),
    n,
  );
  return { lenses: out, headline };
}

// ─── input construction from loaded data ───

/** Apply `f` to the native row values (e.g. a 200-observation SMA), keep the row dates. */
function mapRows(rows: Row[], f: (v: number[]) => (number | null)[]): Row[] {
  const out = f(rows.map((r) => r.v));
  return rows.flatMap((r, i) => (out[i] == null ? [] : [{ t: r.t, v: out[i] as number }]));
}

/** Per-UTC-day mean of `pick` over (hourly or daily) rows. */
function dailyMean<T extends { t: number }>(rows: T[], pick: (r: T) => number | null): Row[] {
  const acc = new Map<number, [number, number]>();
  for (const r of rows) {
    const v = pick(r);
    if (v == null || !Number.isFinite(v)) continue;
    const d = Math.floor(r.t / DAY) * DAY;
    const a = acc.get(d) ?? [0, 0];
    acc.set(d, [a[0] + v, a[1] + 1]);
  }
  return [...acc].map(([t, [s, k]]) => ({ t, v: s / k })).sort((a, b) => a.t - b.t);
}

const lastT = (rows: { t: number }[]) => (rows.length ? Math.floor(rows[rows.length - 1]!.t / DAY) * DAY : null);
/** Fraction -> percent, null-propagating. */
export const pct = (x: Series) => x.map((v) => (v == null ? null : v * 100));
const ratio30v365 = (x: Series) => zip(rollMean(x, 30), rollMean(x, 365), (a, b) => (b === 0 ? null : a / b));

/** Share (0–100) of alts whose value beats a threshold, per spine day; null below BREADTH_MIN_ALTS reporting alts. */
function breadth(n: number, perAlt: Series[], beats: (v: number, i: number) => boolean | null): Series {
  return Array.from({ length: n }, (_, i) => {
    let k = 0;
    let hit = 0;
    for (const x of perAlt) {
      const v = x[i];
      if (v == null) continue;
      const b = beats(v, i);
      if (b == null) continue;
      k++;
      if (b) hit++;
    }
    return k < BREADTH_MIN_ALTS ? null : (hit / k) * 100;
  });
}

export function buildLenses(c: Ctx): LensSpec[] {
  const n = c.spine.length;
  const S = c.s;
  const price: Series = c.price;
  const inp = (key: string, label: string, unit: InputUnit, polarity: 1 | -1, values: Series, asOf: number | null, raw?: boolean): CompassInput => ({
    key,
    label,
    unit,
    polarity,
    values,
    asOf,
    raw,
  });
  const on = (rows: Row[]) => carry(onSpine(rows, c.spine), CARRY_DAYS);

  const dollar = mapRows(c.rows("DTWEXBGS"), (v) => sma(v, 200).map((m, i) => (m == null ? null : (v[i]! / m - 1) * 100)));
  const btcRet30 = change(price, 30);
  const spxRet30 = change(S("SP500"), 30);
  // 30d sum; a null (outside the ETF data range) nulls the window.
  const etf = carry(
    rollMean(onSpine(c.rows("etf-flow-btc"), c.spine, true), 30).map((m) => (m == null ? null : m * 30)),
    CARRY_DAYS,
  );
  const fundingApr = dailyMean(c.funding, (r) => r.rate * 8760 * 100);
  const premium = dailyMean(c.funding, (r) => (r.premium == null ? null : r.premium * 100));
  const oiDaily = dailyMean(c.oi, (r) => r.oiUsd);
  const fundAsOf = lastT(c.funding);

  // Rotation: alt daily closes on the spine; BTC from the daily spine.
  const altClose = c.alts.map((a) => on(a.closes));
  const altFund = c.alts.map((a) => carry(rollMean(on(dailyMean(a.funding, (r) => r.rate)), 7), CARRY_DAYS));
  const altAsOf = c.alts.length ? Math.min(...c.alts.map((a) => lastT(a.closes) ?? 0)) || null : null;

  return [
    {
      key: "macro",
      label: "Macro",
      standalone: false,
      bands: ["Tightening", "Restrictive", "Neutral", "Accommodative", "Expansionary"],
      inputs: [
        inp("dollar_vs_200d", "Broad dollar vs 200d avg", "pct", -1, on(dollar), c.asOf("DTWEXBGS")),
        inp(
          "us10y_chg90d",
          "US 10Y 90d change",
          "pct",
          -1,
          S("DGS10").map((v, i, a) => (i >= 90 && v != null && a[i - 90] != null ? v - a[i - 90]! : null)),
          c.asOf("DGS10"),
        ),
        inp("curve_10y2y", "Curve 10Y−2Y", "pct", 1, S("T10Y2Y"), c.asOf("T10Y2Y")),
        inp("policy_gap", "2Y minus Fed funds upper", "pct", -1, zip(S("DGS2"), S("DFEDTARU"), (a, b) => a - b), c.asOf("DGS2")),
        inp("btc_vs_spx_30d", "BTC vs S&P 500, 30d", "pct", 1, pct(zip(btcRet30, spxRet30, (a, b) => a - b)), c.asOf("SP500")),
      ],
    },
    {
      key: "flows",
      label: "Capital Flows",
      standalone: false,
      bands: ["Drained", "Light", "Neutral", "Healthy", "Flush"],
      inputs: [
        inp("stables_roc30", "Stablecoin supply 30d change", "pct", 1, pct(change(S("totalStablecoinMcapUSD"), 30)), c.asOf("totalStablecoinMcapUSD")),
        inp("realized_cap_chg30", "Realized cap 30d change", "pct", 1, pct(change(S("RealizedCapUSD"), 30)), c.asOf("RealizedCapUSD")),
        inp("etf_flow_30d", "ETF net flow, 30d sum", "btc", 1, etf, c.asOf("etf-flow-btc")),
        inp("exchange_supply_chg30", "Exchange supply 30d change", "pct", -1, pct(change(S("SplyExNtv"), 30)), c.asOf("SplyExNtv")),
      ],
    },
    {
      key: "behaviour",
      label: "Investor Behaviour",
      standalone: false,
      bands: ["Distributing", "Soft", "Neutral", "Firm", "Accumulating"],
      inputs: [
        inp("sth_sopr_30d", "STH-SOPR 30d mean", "ratio", 1, rollMean(S("sth-sopr"), 30), c.asOf("sth-sopr")),
        inp("price_vs_sth", "Price / STH cost basis", "ratio", 1, zip(price, S("sth-realized-price"), (p, b) => p / b), c.asOf("sth-realized-price")),
        inp("exchange_inflow_ratio", "Exchange inflow 30d / 365d", "ratio", -1, ratio30v365(S("FlowInExNtv")), c.asOf("FlowInExNtv")),
        inp("fear_greed", "Fear & Greed (contrarian)", "index", -1, S("fearGreed"), c.asOf("fearGreed")),
      ],
    },
    {
      key: "fundamentals",
      label: "On-chain Fundamentals",
      standalone: false,
      bands: ["Contracting", "Soft", "Neutral", "Expanding", "Hot"],
      inputs: [
        inp("active_addresses", "Active addresses 30d / 365d", "ratio", 1, ratio30v365(S("AdrActCnt")), c.asOf("AdrActCnt")),
        inp("tx_count", "Transactions 30d / 365d", "ratio", 1, ratio30v365(S("TxCnt")), c.asOf("TxCnt")),
        inp("fees_btc", "Fees in BTC 30d / 365d", "ratio", 1, ratio30v365(S("FeeTotNtv")), c.asOf("FeeTotNtv")),
        inp("hashrate", "Hashrate 30d / 365d", "ratio", 1, ratio30v365(S("HashRate")), c.asOf("HashRate")),
      ],
    },
    {
      key: "cycle",
      label: "Cycle Position",
      standalone: true,
      bands: ["Capitulation", "Cold", "Neutral", "Warm", "Euphoria"],
      inputs: [
        inp("mvrv", "MVRV", "ratio", 1, S("CapMVRVCur"), c.asOf("CapMVRVCur")),
        inp("nupl", "NUPL", "ratio", 1, S("nupl"), c.asOf("nupl")),
        inp("supply_in_profit", "Supply in profit", "pct", 1, pct(zip(S("supply-profit"), S("SplyCur"), (a, b) => a / b)), c.asOf("supply-profit")),
        inp("htf_heat", "HTF heat", "index", 1, c.heat, c.spine.length ? c.spine[n - 1]! : null),
      ],
    },
    {
      key: "derivatives",
      label: "Derivatives",
      standalone: true,
      bands: ["Deleveraged", "Light", "Neutral", "Heavy", "Frothy"],
      inputs: [
        inp("funding_apr", "Funding APR, 7d mean", "pct", 1, carry(rollMean(on(fundingApr), 7), CARRY_DAYS), fundAsOf),
        inp("oi_to_mcap", "Open interest / market cap", "pct", 1, pct(zip(on(oiDaily), S("CapMrktCurUSD"), (a, b) => a / b)), lastT(c.oi)),
        inp("dvol", "DVOL", "index", 1, S("dvol"), c.asOf("dvol")),
        inp("skew_25d", "25Δ skew (put − call)", "index", -1, S("skew25d"), c.asOf("skew25d")),
        inp("hl_premium", "Perp premium, 7d mean", "pct", 1, carry(rollMean(on(premium), 7), CARRY_DAYS), fundAsOf),
      ],
    },
    {
      key: "rotation",
      label: "Rotation",
      standalone: true,
      bands: ["BTC Season", "BTC-Led", "Mixed", "Alt-Led", "Altseason"],
      inputs: [
        inp(
          "alts_beating_btc",
          "Alts beating BTC, 30d",
          "pct",
          1,
          breadth(
            n,
            altClose.map((x) => change(x, 30)),
            (v, i) => (btcRet30[i] == null ? null : v > btcRet30[i]!),
          ),
          altAsOf,
          true,
        ),
        inp(
          "alts_funding_hot",
          "Alts with funding above neutral",
          "pct",
          1,
          breadth(n, altFund, (v) => v > HL_NEUTRAL_HOURLY * (1 + NEUTRAL_EPS)),
          altAsOf,
          true,
        ),
      ],
    },
  ];
}
