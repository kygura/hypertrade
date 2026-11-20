// Hypothetical future timelines (docs/EVAL.md §6): a regime-aware filtered historical simulation.
//   1. Each past day's log return is divided by the 30-day realized vol before it (a standardized shock z).
//   2. A path starts in today's regime. Every `block` days it draws the next regime from the empirical transition
//      matrix (raised to the block length), then copies `block` consecutive shocks from a random past stretch that
//      began in that regime: crashes come in runs, as they do.
//   3. Shocks are rescaled to the vol the path should have today: implied vol (DVOL, the market's own 30-day
//      forecast) blended with realized, decaying toward the long-run median with a half-life, and scaled by how much
//      more or less volatile the drawn regime has been than today's.
//   4. Drift is the mean shock of the drawn regime, shrunk halfway to zero.
// Out come percentile bands per day, the odds of touching or closing beyond each level, which of two levels comes
// first, the mix of regimes the paths drew from, and a calibration check of the method itself on history.
import { fork, mulberry32, type Rng } from "../lab/engine/rng.js";
import { logReturns, trailingMean, type EvalPanel } from "./panel.js";
import { labelRegimes, REGIMES, transitionMatrix, type Regime } from "./regimes.js";

export interface PathOptions {
  horizon?: number;
  n?: number;
  seed?: number;
  block?: number;
  /** Weight of implied vol in today's vol (rest realized). */
  ivWeight?: number;
  /** Days for the vol gap to today's long-run level to halve. */
  volHalfLife?: number;
  /** Share of the regime's mean shock kept as drift. */
  driftKeep?: number;
  levels?: number[];
  /** Pairs [lo, hi]: P(lo is touched before hi). */
  races?: Array<[number, number]>;
  /** Paths to return whole (for drawing). */
  keepPaths?: number;
  /** Use only data up to this index (calibration). */
  asOf?: number;
}

export interface LevelOdds {
  level: number;
  /** P(any close at or beyond the level within the horizon), beyond = below if under spot, above if over. */
  touch: number;
  /** P(the horizon's close is beyond it). */
  close: number;
  /** Median day of first touch among paths that touch. */
  medianDay: number | null;
}

export interface PathResult {
  asset: string;
  asOf: string;
  spot: number;
  regime: Regime;
  horizon: number;
  n: number;
  /** Daily vol used on day 1 (annualized %), and its sources. */
  vol0: number;
  iv: number | null;
  rv: number | null;
  /** Percentiles per day 0..horizon. */
  bands: Array<{ day: number; p5: number; p25: number; p50: number; p75: number; p95: number }>;
  levels: LevelOdds[];
  races: Array<{ lo: number; hi: number; loFirst: number; hiFirst: number; neither: number }>;
  /** Share of simulated days whose shocks came from each regime (the mix of conditions the fan assumes). */
  regimeMix: Array<{ regime: Regime; share: number }>;
  paths: number[][];
}

const DAY = 86_400_000;

function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function median(xs: number[]): number | null {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? quantile(v, 0.5) : null;
}

type Matrix = Record<Regime, Record<Regime, number>>;

function matPow(m: Matrix, k: number): Matrix {
  let out = Object.fromEntries(REGIMES.map((a) => [a, Object.fromEntries(REGIMES.map((b) => [b, a === b ? 1 : 0]))])) as Matrix;
  for (let s = 0; s < k; s++) {
    const next = Object.fromEntries(REGIMES.map((a) => [a, Object.fromEntries(REGIMES.map((b) => [b, 0]))])) as Matrix;
    for (const a of REGIMES) for (const c of REGIMES) for (const b of REGIMES) next[a][b] += out[a][c] * m[c][b];
    out = next;
  }
  return out;
}

function draw(row: Record<Regime, number>, rng: Rng): Regime {
  let u = rng();
  for (const r of REGIMES) {
    u -= row[r];
    if (u <= 0) return r;
  }
  return REGIMES[REGIMES.length - 1]!;
}

/** Daily realized vol (not annualized) over the 30 days ending at each index. */
function dailyVol(lr: readonly number[], win = 30): number[] {
  const out = new Array<number>(lr.length).fill(NaN);
  for (let i = win; i < lr.length; i++) {
    let s = 0;
    let s2 = 0;
    for (let j = i - win + 1; j <= i; j++) {
      s += lr[j]!;
      s2 += lr[j]! ** 2;
    }
    out[i] = Math.sqrt(Math.max(0, s2 / win - (s / win) ** 2));
  }
  return out;
}

export function defaultLevels(spot: number, panel: EvalPanel, at: number): number[] {
  const ma200 = trailingMean(panel.price, 200)[at];
  const sth = panel.sthRp[at];
  const raw = [spot * 0.8, spot * 0.9, spot * 1.1, spot * 1.2, ...(Number.isFinite(ma200) ? [ma200!] : []), ...(Number.isFinite(sth) ? [sth!] : [])];
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(spot)) - 2);
  return [...new Set(raw.map((x) => Math.round(x / mag) * mag))].sort((a, b) => a - b);
}

export function simulatePaths(panel: EvalPanel, o: PathOptions = {}): PathResult {
  const horizon = o.horizon ?? 60;
  const n = o.n ?? 5000;
  const block = Math.max(1, o.block ?? 5);
  const ivW = o.ivWeight ?? 0.6;
  const half = o.volHalfLife ?? 30;
  const keepDrift = o.driftKeep ?? 0.5;
  const end = Math.min(panel.price.length - 1, o.asOf ?? panel.price.length - 1);
  const price = panel.price.slice(0, end + 1);
  const regimes = labelRegimes({ price, sthRp: panel.sthRp.slice(0, end + 1), fng: panel.fng.slice(0, end + 1), mvrv: panel.mvrv.slice(0, end + 1) });
  const lr = logReturns(price);
  const dv = dailyVol(lr);
  // Standardized shocks z[i] = r[i] / vol before day i; each with the regime of day i-1 (the state it was drawn from).
  const z: number[] = new Array(lr.length).fill(NaN);
  for (let i = 31; i < lr.length; i++) if (dv[i - 1]! > 0 && Number.isFinite(price[i]!) && Number.isFinite(price[i - 1]!)) z[i] = lr[i]! / dv[i - 1]!;
  const starts: Record<Regime, number[]> = Object.fromEntries(REGIMES.map((r) => [r, []])) as unknown as Record<Regime, number[]>;
  for (let i = 31; i + block - 1 <= end; i++) {
    let okBlock = true;
    for (let j = i; j < i + block; j++) if (!Number.isFinite(z[j]!)) okBlock = false;
    if (okBlock) starts[regimes[i - 1]!].push(i);
  }
  const all = REGIMES.flatMap((r) => starts[r]);
  if (!all.length) throw new Error(`${panel.asset}: not enough history to simulate`);
  const regMean: Record<string, number> = {};
  const regVol: Record<string, number> = {};
  const allVol = median(dv.slice(31, end + 1)) ?? 0.03;
  for (const r of REGIMES) {
    const xs = starts[r].map((i) => z[i]!);
    regMean[r] = xs.length >= 30 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
    const vols = starts[r].map((i) => dv[i - 1]!);
    regVol[r] = vols.length >= 30 ? (median(vols) ?? allVol) / allVol : 1;
  }
  const spot = price[end]!;
  const regime0 = regimes[end]!;
  const rvNow = dv[end]!;
  const ivNow = panel.iv[end];
  const ivDaily = Number.isFinite(ivNow) ? ivNow! / 100 / Math.sqrt(365) : NaN;
  const sigma0 = Number.isFinite(ivDaily) ? ivW * ivDaily + (1 - ivW) * rvNow : rvNow;
  const sigmaLong = median(dv.slice(Math.max(31, end - 730), end + 1)) ?? rvNow;
  const P = matPow(transitionMatrix(regimes.slice(Math.max(0, end - 1460), end + 1)), block);
  const levels = o.levels?.length ? o.levels : defaultLevels(spot, panel, end);
  const races = o.races ?? [];
  const rng = mulberry32(o.seed ?? 7);

  const byDay: number[][] = Array.from({ length: horizon + 1 }, () => new Array<number>(n));
  const touchDay = levels.map(() => new Array<number>(n).fill(-1));
  const raceOut = races.map(() => ({ lo: 0, hi: 0, none: 0 }));
  const mix: Record<string, number> = Object.fromEntries(REGIMES.map((r) => [r, 0]));
  const kept: number[][] = [];
  const keep = o.keepPaths ?? 24;
  for (let k = 0; k < n; k++) {
    const r = fork(rng);
    let lp = Math.log(spot);
    let reg = regime0;
    let pos = -1;
    let left = 0;
    const raceState = races.map(() => 0);
    const path = keep > k ? [spot] : null;
    byDay[0]![k] = spot;
    for (let t = 1; t <= horizon; t++) {
      if (left === 0) {
        reg = draw(P[reg], r);
        const pool = starts[reg].length >= 20 ? starts[reg] : all;
        pos = pool[Math.floor(r() * pool.length)]!;
        left = block;
      }
      mix[reg]!++;
      const shock = z[pos]!;
      pos++;
      left--;
      const volT = (sigmaLong + (sigma0 - sigmaLong) * Math.pow(0.5, (t - 1) / half)) * (regVol[reg]! / regVol[regime0]!);
      const drift = keepDrift * regMean[reg]! * volT;
      lp += drift + (shock - regMean[reg]!) * volT;
      const px = Math.exp(lp);
      byDay[t]![k] = px;
      path?.push(px);
      for (let j = 0; j < levels.length; j++) {
        if (touchDay[j]![k]! >= 0) continue;
        const L = levels[j]!;
        if ((L <= spot && px <= L) || (L > spot && px >= L)) touchDay[j]![k] = t;
      }
      races.forEach(([lo, hi], j) => {
        if (raceState[j] !== 0) return;
        if (px <= lo) raceState[j] = -1;
        else if (px >= hi) raceState[j] = 1;
      });
    }
    raceState.forEach((s, j) => {
      if (s < 0) raceOut[j]!.lo++;
      else if (s > 0) raceOut[j]!.hi++;
      else raceOut[j]!.none++;
    });
    if (path) kept.push(path);
  }
  const bands = byDay.map((xs, day) => {
    const s = [...xs].sort((a, b) => a - b);
    return { day, p5: quantile(s, 0.05), p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), p95: quantile(s, 0.95) };
  });
  const last = byDay[horizon]!;
  const lvl = levels.map((L, j): LevelOdds => {
    const days = touchDay[j]!.filter((d) => d >= 0);
    const beyond = last.filter((px) => (L <= spot ? px <= L : px >= L)).length;
    return { level: L, touch: days.length / n, close: beyond / n, medianDay: days.length ? median(days) : null };
  });
  return {
    asset: panel.asset,
    asOf: new Date(panel.t[end]!).toISOString().slice(0, 10),
    spot,
    regime: regime0,
    horizon,
    n,
    vol0: sigma0 * Math.sqrt(365) * 100,
    iv: Number.isFinite(ivNow) ? ivNow! : null,
    rv: Number.isFinite(rvNow) ? rvNow * Math.sqrt(365) * 100 : null,
    bands,
    levels: lvl,
    races: races.map(([lo, hi], j) => ({ lo, hi, loFirst: raceOut[j]!.lo / n, hiFirst: raceOut[j]!.hi / n, neither: raceOut[j]!.none / n })),
    regimeMix: REGIMES.map((regime) => ({ regime, share: mix[regime]! / (n * horizon) })).filter((e) => e.share > 0),
    paths: kept,
  };
}

export interface Calibration {
  asset: string;
  horizon: number;
  samples: number;
  /** Share of realized horizon closes inside the 25–75 and 5–95 bands (ideal 0.5 and 0.9). */
  in50: number;
  in90: number;
  /** Realized close's percentile among the paths, bucketed in deciles (ideal: flat at 0.1 each). */
  pit: number[];
  /** Mean continuous ranked probability score proxy: mean |log(realized/median)|. */
  medianLogError: number;
}

/** Re-runs the simulation at past dates, `every` days apart, using only data up to each, and scores the forecasts. */
export function calibrate(panel: EvalPanel, o: { horizon?: number; every?: number; n?: number; fromIndex?: number; seed?: number } = {}): Calibration {
  const h = o.horizon ?? 30;
  const every = o.every ?? 21;
  const nPaths = o.n ?? 400;
  const first = Math.max(o.fromIndex ?? 0, panel.price.findIndex((x) => Number.isFinite(x)) + 400);
  let in50 = 0;
  let in90 = 0;
  let samples = 0;
  let err = 0;
  const pit = new Array<number>(10).fill(0);
  for (let at = first; at + h < panel.price.length; at += every) {
    let res: PathResult;
    try {
      res = simulatePaths(panel, { asOf: at, horizon: h, n: nPaths, seed: (o.seed ?? 11) + at, keepPaths: 0, levels: [panel.price[at]!] });
    } catch {
      continue;
    }
    const real = panel.price[at + h]!;
    if (!Number.isFinite(real)) continue;
    const b = res.bands[h]!;
    if (real >= b.p25 && real <= b.p75) in50++;
    if (real >= b.p5 && real <= b.p95) in90++;
    // Percentile of the realized close: interpolate within the five band points.
    const pts: Array<[number, number]> = [
      [0, 0],
      [0.05, b.p5],
      [0.25, b.p25],
      [0.5, b.p50],
      [0.75, b.p75],
      [0.95, b.p95],
      [1, Infinity],
    ];
    let q = 1;
    for (let j = 1; j < pts.length; j++) {
      if (real <= pts[j]![1]) {
        const [q0, v0] = pts[j - 1]!;
        const [q1, v1] = pts[j]!;
        q = Number.isFinite(v1) && v1 > v0 ? q0 + ((real - v0) / (v1 - v0)) * (q1 - q0) : q1;
        break;
      }
    }
    pit[Math.min(9, Math.max(0, Math.floor(q * 10)))]!++;
    err += Math.abs(Math.log(real / b.p50));
    samples++;
  }
  return {
    asset: panel.asset,
    horizon: h,
    samples,
    in50: samples ? in50 / samples : NaN,
    in90: samples ? in90 / samples : NaN,
    pit: pit.map((c) => (samples ? c / samples : 0)),
    medianLogError: samples ? err / samples : NaN,
  };
}

/** Day index → ISO date for a path day counted from the panel's last day. */
export function pathDate(res: PathResult, day: number): string {
  return new Date(Date.parse(res.asOf) + day * DAY).toISOString().slice(0, 10);
}
