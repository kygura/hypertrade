// The eval panel (docs/EVAL.md): one asset's daily closes plus the handful of series the regime thesis reads, on one
// calendar. Missing values are NaN, as in the Lab's datasets. Each series has a measured source and, where the free
// sources have a gap, a named stand-in built from what we do have:
//   iv      Deribit DVOL (BTC, ETH); HYPE has no listed options, so 30-day realized vol scaled by the BTC/ETH
//           implied-over-realized ratio (the variance premium) stands in
//   sthRp   short-term holder cost basis: Glassnode's STH realized price needs UTXO ages, which no free API serves as
//           history; bitcoin-data.com has it for BTC only and only recently. The stand-in is a volume-free 155-day
//           mean of price (STH = coins younger than 155 days), calibrated on the overlap where both exist
//   mvrv    Coin Metrics community (BTC, ETH); NaN for HYPE
//   funding Hyperliquid, the daily sum of hourly rates
//   fng     alternative.me Fear & Greed, a market-wide series

export const EVAL_ASSETS = ["BTC", "ETH", "HYPE"] as const;
export type EvalAsset = (typeof EVAL_ASSETS)[number];

export interface EvalPanel {
  asset: string;
  /** UTC day starts (ms). */
  t: number[];
  price: number[];
  /** Annualized implied vol in percent (DVOL units), measured or stand-in (see ivSource). */
  iv: number[];
  /** Daily funding (fraction/day), NaN where none. */
  funding: number[];
  fng: number[];
  mvrv: number[];
  /** Short-term holder cost basis (USD), measured or stand-in (see sthSource). */
  sthRp: number[];
  ivSource: "dvol" | "realized" | "mixed";
  sthSource: "stored" | "proxy" | "mixed";
}

/** The Lab metric ids each panel column comes from (src/server/lab/providers). null: no free source for that asset. */
export function evalMetricIds(asset: string): { iv: string | null; funding: string; fng: string; mvrv: string | null } {
  const a = asset.toUpperCase();
  return {
    iv: a === "BTC" ? "deribit:btc_dvol" : a === "ETH" ? "deribit:eth_dvol" : null,
    funding: "ht:funding",
    fng: "fng:value",
    mvrv: a === "BTC" || a === "ETH" ? "cm:CapMVRVCur" : null,
  };
}

/** STH holding window in days (Glassnode's 155-day cut-off). */
export const STH_DAYS = 155;
/** Implied over realized vol when no options history exists to measure it (BTC 2021-26 median is about this). */
export const DEFAULT_VARIANCE_PREMIUM = 1.1;

const nan = (n: number) => new Array<number>(n).fill(NaN);
const ok = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);

/** Annualized realized vol (percent) of daily log returns over `win` days, NaN until the window fills. */
export function realizedVol(price: readonly number[], win = 30): number[] {
  const out = nan(price.length);
  const r = price.map((p, i) => (i > 0 && ok(p) && ok(price[i - 1]) && price[i - 1]! > 0 ? Math.log(p / price[i - 1]!) : NaN));
  for (let i = win; i < price.length; i++) {
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let j = i - win + 1; j <= i; j++) {
      const x = r[j]!;
      if (!Number.isFinite(x)) continue;
      s += x;
      s2 += x * x;
      n++;
    }
    if (n < win * 0.8) continue;
    const m = s / n;
    out[i] = Math.sqrt(Math.max(0, s2 / n - m * m)) * Math.sqrt(365) * 100;
  }
  return out;
}

/** Trailing mean of price over `win` days: the STH cost-basis stand-in (before calibration). */
export function trailingMean(price: readonly number[], win = STH_DAYS): number[] {
  const out = nan(price.length);
  let s = 0;
  let n = 0;
  for (let i = 0; i < price.length; i++) {
    const add = price[i]!;
    if (ok(add)) {
      s += add;
      n++;
    }
    if (i >= win) {
      const drop = price[i - win]!;
      if (ok(drop)) {
        s -= drop;
        n--;
      }
    }
    if (i >= win - 1 && n >= win * 0.8) out[i] = s / n;
  }
  return out;
}

function median(xs: number[]): number | null {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** Median of a/b where both exist. */
export function medianRatio(a: readonly number[], b: readonly number[]): number | null {
  return median(a.map((x, i) => (ok(x) && ok(b[i]) && b[i]! > 0 ? x / b[i]! : NaN)));
}

export interface RawPanel {
  asset: string;
  t: number[];
  price: number[];
  iv?: number[];
  funding?: number[];
  fng?: number[];
  mvrv?: number[];
  sthRp?: number[];
  /** Implied/realized ratio measured on another asset (HYPE borrows BTC's). */
  variancePremium?: number;
}

/**
 * Fills the gaps with the stand-ins above and reports which source each filled column uses. The STH stand-in is
 * scaled by the median stored/proxy ratio on the overlap, so where the measured series ends the stand-in continues it
 * at the same level; with no overlap it is used unscaled.
 */
export function buildPanel(raw: RawPanel): EvalPanel {
  const n = raw.t.length;
  const col = (x: number[] | undefined) => (x && x.length === n ? x.map((v) => (ok(v) ? v : NaN)) : nan(n));
  const price = col(raw.price);
  const ivRaw = col(raw.iv);
  const rv = realizedVol(price);
  const vp = medianRatio(ivRaw, rv) ?? raw.variancePremium ?? DEFAULT_VARIANCE_PREMIUM;
  let ivMeasured = 0;
  const iv = ivRaw.map((v, i) => {
    if (Number.isFinite(v)) {
      ivMeasured++;
      return v;
    }
    return Number.isFinite(rv[i]!) ? rv[i]! * vp : NaN;
  });
  const sthRaw = col(raw.sthRp);
  const proxy = trailingMean(price);
  const k = medianRatio(sthRaw, proxy) ?? 1;
  let sthMeasured = 0;
  const sthRp = sthRaw.map((v, i) => {
    if (Number.isFinite(v)) {
      sthMeasured++;
      return v;
    }
    return Number.isFinite(proxy[i]!) ? proxy[i]! * k : NaN;
  });
  const src = (measured: number, total: number) => (measured === 0 ? "none" : measured >= total ? "all" : "some");
  const ivTotal = iv.filter(Number.isFinite).length;
  const sthTotal = sthRp.filter(Number.isFinite).length;
  const ivS = src(ivMeasured, ivTotal);
  const sthS = src(sthMeasured, sthTotal);
  return {
    asset: raw.asset.toUpperCase(),
    t: raw.t.slice(),
    price,
    iv,
    funding: col(raw.funding),
    fng: col(raw.fng),
    mvrv: col(raw.mvrv),
    sthRp,
    ivSource: ivS === "none" ? "realized" : ivS === "all" ? "dvol" : "mixed",
    sthSource: sthS === "none" ? "proxy" : sthS === "all" ? "stored" : "mixed",
  };
}

/** Daily log returns; r[0] and any return across a missing price are 0. */
export function logReturns(price: readonly number[]): number[] {
  return price.map((p, i) => (i > 0 && ok(p) && ok(price[i - 1]) && price[i - 1]! > 0 && p > 0 ? Math.log(p / price[i - 1]!) : 0));
}

/** Drops leading days with no price, so every series starts at the asset's first close. */
export function trimPanel(p: EvalPanel, fromIndex?: number): EvalPanel {
  const first = fromIndex ?? Math.max(0, p.price.findIndex((x) => Number.isFinite(x)));
  const cut = <T>(a: T[]) => a.slice(first);
  return { ...p, t: cut(p.t), price: cut(p.price), iv: cut(p.iv), funding: cut(p.funding), fng: cut(p.fng), mvrv: cut(p.mvrv), sthRp: cut(p.sthRp) };
}
