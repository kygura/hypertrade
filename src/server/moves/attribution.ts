import type { IntelEvent } from "../../shared/intel.js";
import { WINDOW_HOURS, type Attribution, type BetaFit, type MoveSeriesPoint, type MoveWindow } from "../../shared/moves.js";
import { robustSigma, zRobust } from "../../shared/signalMath.js";
import type { Candle } from "../../shared/types.js";
import { EST_BARS, FLOW_MIN_N, FLOW_Z, HOUR_MS, MIN_EST_BARS, MIN_WINDOW_SHARE, NEWS_AFTER_MS, NEWS_BEFORE_MS, OI_SAMPLE_TOLERANCE_MS, SECTOR_MIN_PEERS, SIGMA_FLOOR } from "./constants.js";

// Move attribution (docs/SPEC.md § Moves). Pure. A coin's hourly log return over the window W (the last h closed
// bars) is split into BTC beta, ETH-ex-BTC beta, sector-ex-majors beta and a residual, with the betas fitted on the
// EST_BARS hourly bars before W (out of sample):
//   f1 = r_BTC
//   f2 = r_ETH − b·r_BTC, b = OLS slope of ETH on BTC over E
//   s  = equal-weight mean of the sector peers present at t (coin, BTC, ETH excluded), only where ≥ 2 are present
//   f3 = s − (c1·f1 + c2·f2), c = OLS of s on f1 and f2 over E
//   r  = α + Σ β_k f_k + e (OLS with intercept over E); the intercept is folded into the residual
// contribution_k = 100·β_k·Σ_W f_k; residual = total − Σ contributions, so the parts sum to the total exactly.
// The residual is then split by hour bucket (OI-drop hours, then news hours, then the rest): a split, not a regression.

/** Log return per bar, keyed by bar open; a bar whose previous bar is missing has no return (never zero). */
export type Returns = Map<number, number>;

export function hourlyReturns(candles: Pick<Candle, "t" | "c">[]): Returns {
  const close = new Map<number, number>();
  for (const c of candles) if (Number.isFinite(c.c) && c.c > 0) close.set(c.t, c.c);
  const out: Returns = new Map();
  for (const [t, c] of [...close].sort((a, b) => a[0] - b[0])) {
    const prev = close.get(t - HOUR_MS);
    if (prev !== undefined) out.set(t, Math.log(c / prev));
  }
  return out;
}

/** Bar opens of the window (the last h closed bars before asOf) and of the estimation window before it. */
export function windowBars(asOf: number, hours: number, estBars = EST_BARS): { est: number[]; win: number[] } {
  const start = asOf - hours * HOUR_MS;
  return {
    est: Array.from({ length: estBars }, (_, i) => start - (estBars - i) * HOUR_MS),
    win: Array.from({ length: hours }, (_, i) => start + i * HOUR_MS),
  };
}

/** OLS with intercept of y on the columns of X (centered normal equations); null when singular or empty. */
export function ols(y: number[], X: number[][]): { alpha: number; betas: number[] } | null {
  const n = y.length;
  const k = X.length;
  if (n <= k) return null;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const my = mean(y);
  const mx = X.map(mean);
  const M = Array.from({ length: k }, (_, i) => Array.from({ length: k + 1 }, (_, j) => {
    let s = 0;
    for (let t = 0; t < n; t++) s += (X[i]![t]! - mx[i]!) * (j < k ? X[j]![t]! - mx[j]! : y[t]! - my);
    return s;
  }));
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (!(Math.abs(M[p]![c]!) > 1e-18)) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= k; j++) M[r]![j]! -= f * M[c]![j]!;
    }
  }
  const betas = M.map((row, i) => row[k]! / row[i]!);
  if (!betas.every(Number.isFinite)) return null;
  return { alpha: my - betas.reduce((a, b, i) => a + b * mx[i]!, 0), betas };
}

const has = (t: number, ...series: Returns[]) => series.every((s) => s.has(t));

export interface Factors {
  f1: Returns;
  f2: Returns;
  /** Null with `sectorReason` when the coin has no usable sector factor. */
  f3: Returns | null;
  /** ETH's beta to BTC on E (b), null when it could not be fitted. */
  ethOnBtc: number | null;
  /** Bars of E where f3 exists. */
  sectorN: number;
  sectorReason: string | null;
  /** The equal-weight peer basket (where ≥ 2 peers are present). */
  basket: Returns | null;
}

/** Equal-weight mean of the peers' returns at each bar where at least SECTOR_MIN_PEERS are present. */
export function basketReturns(peers: Returns[], bars: number[]): Returns {
  const out: Returns = new Map();
  for (const t of bars) {
    const xs = peers.flatMap((p) => (p.has(t) ? [p.get(t)!] : []));
    if (xs.length >= SECTOR_MIN_PEERS) out.set(t, xs.reduce((a, b) => a + b, 0) / xs.length);
  }
  return out;
}

/**
 * The orthogonal factors on E ∪ W. `peers` = the coin's sector peers ex-coin, ex-BTC, ex-ETH (null: no sector).
 */
export function buildFactors(btc: Returns, eth: Returns, peers: Returns[] | null, est: number[], win: number[]): Factors {
  const bars = [...est, ...win];
  const f1: Returns = new Map(bars.flatMap((t) => (btc.has(t) ? [[t, btc.get(t)!] as const] : [])));
  const eb = est.filter((t) => has(t, btc, eth));
  const b = ols(eb.map((t) => eth.get(t)!), [eb.map((t) => btc.get(t)!)])?.betas[0] ?? null;
  const f2: Returns = new Map(b == null ? [] : bars.flatMap((t) => (has(t, btc, eth) ? [[t, eth.get(t)! - b * btc.get(t)!] as const] : [])));
  const none = (reason: string, basket: Returns | null = null, sectorN = 0): Factors => ({ f1, f2, f3: null, ethOnBtc: b, sectorN, sectorReason: reason, basket });
  if (peers == null) return none("not in a sector basket");
  if (peers.length < SECTOR_MIN_PEERS) return none(`sector has ${peers.length} peer${peers.length === 1 ? "" : "s"} ex-majors (needs ${SECTOR_MIN_PEERS})`);
  const s = basketReturns(peers, bars);
  const se = est.filter((t) => has(t, s, f1, f2));
  if (se.length < MIN_EST_BARS) return none(`sector basket has ${se.length} of ${MIN_EST_BARS} bars before the window`, s, se.length);
  const c = ols(se.map((t) => s.get(t)!), [se.map((t) => f1.get(t)!), se.map((t) => f2.get(t)!)]);
  if (!c) return none("sector basket fit is singular", s, se.length);
  const f3: Returns = new Map(bars.flatMap((t) => (has(t, s, f1, f2) ? [[t, s.get(t)! - c.betas[0]! * f1.get(t)! - c.betas[1]! * f2.get(t)!] as const] : [])));
  return { f1, f2, f3, ethOnBtc: b, sectorN: se.length, sectorReason: null, basket: s };
}

// ---------------------------------------------------------------- flow and news hours

/** A series sampled per bar open: the last point at or before the bar close, within OI_SAMPLE_TOLERANCE_MS. */
export function hourlySample(points: Array<{ ts: number; v: number }>, bars: number[]): Map<number, number> {
  const s = points.filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.v)).sort((a, b) => a.ts - b.ts);
  const out = new Map<number, number>();
  let i = -1;
  for (const t of [...bars].sort((a, b) => a - b)) {
    const close = t + HOUR_MS;
    while (i + 1 < s.length && s[i + 1]!.ts <= close) i++;
    if (i >= 0 && close - s[i]!.ts <= OI_SAMPLE_TOLERANCE_MS) out.set(t, s[i]!.v);
  }
  return out;
}

/** Hourly OI per bar open (positive samples only), as hourlySample. */
export function hourlyOi(snaps: Array<{ ts: number; oiUsd: number }>, bars: number[]): Map<number, number> {
  return hourlySample(snaps.filter((x) => x.oiUsd > 0).map((x) => ({ ts: x.ts, v: x.oiUsd })), bars);
}

export type FlowHours = { hours: Set<number>; n: number } | { hours: null; n: number; reason: string };

/**
 * Flow hours of W: hours whose OI change d_t = ln(OI_t / OI_t−1) has a robust z (against d on E) ≤ FLOW_Z, i.e.
 * OI dropped sharply (forced deleveraging, either side). Needs FLOW_MIN_N values of d on E.
 */
export function flowHours(oi: Map<number, number>, est: number[], win: number[]): FlowHours {
  const d = (t: number) => {
    const a = oi.get(t);
    const b = oi.get(t - HOUR_MS);
    return a !== undefined && b !== undefined ? Math.log(a / b) : null;
  };
  const base = est.map(d).filter((x): x is number => x != null);
  if (base.length < FLOW_MIN_N) return { hours: null, n: base.length, reason: `needs ${FLOW_MIN_N} hourly OI changes before the window — has ${base.length}` };
  const hours = new Set(win.filter((t) => {
    const x = d(t);
    return x != null && zRobust(x, base, SIGMA_FLOOR) <= FLOW_Z;
  }));
  return { hours, n: base.length };
}

/** Events naming the coin (case-insensitive), news only (flow-detector events are numbers, not news). */
export function coinEvents(events: Pick<IntelEvent, "assets" | "origin" | "firstSeen">[], coin: string): number[] {
  const c = coin.toLowerCase();
  return events.filter((e) => e.origin !== "flow" && e.assets.some((a) => a.toLowerCase() === c)).map((e) => Date.parse(e.firstSeen)).filter(Number.isFinite);
}

/** News hours of W: hour t when an event was first seen in [t − 2h, t + 1h). */
export function newsHours(firstSeen: number[], win: number[]): Set<number> {
  return new Set(win.filter((t) => firstSeen.some((f) => f >= t - NEWS_BEFORE_MS && f < t + NEWS_AFTER_MS)));
}

// ---------------------------------------------------------------- attribute

export interface AttributeInput {
  coin: string;
  window: MoveWindow;
  /** Close of the last closed 1h bar (ms, on the hour). */
  asOf: number;
  r: Returns;
  btc: Returns;
  eth: Returns;
  /** The coin's sector peers ex-coin, ex-BTC, ex-ETH; null when it is in no sector basket. */
  peers: Returns[] | null;
  /** Null: the flow layer is unavailable for the coin (its bucket is null, its hours fall into other). */
  flow: FlowHours | null;
  /** Null: the news layer is unavailable (no store). */
  news: Set<number> | null;
}

export interface AttributeResult {
  attribution: Attribution | null;
  reason: string | null;
  series: MoveSeriesPoint[];
  /** 100 · robustSigma(r on E) · √24; null under MIN_EST_BARS returns on E. */
  sigma24hPct: number | null;
  /** Window hours that were both flow and news hours (counted as flow). Test-only. */
  overlap: number;
}

const iso = (t: number) => new Date(t).toISOString();
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fit = (factor: BetaFit["factor"], beta: number | null, contributionPct: number | null, n: number, reason: string | null): BetaFit => ({ factor, beta, contributionPct, n, reason });

export function attribute(a: AttributeInput): AttributeResult {
  const h = WINDOW_HOURS[a.window];
  const { est, win } = windowBars(a.asOf, h);
  const ownEst = est.filter((t) => a.r.has(t)).map((t) => a.r.get(t)!);
  const sigma24hPct = ownEst.length >= MIN_EST_BARS ? 100 * robustSigma(ownEst, SIGMA_FLOOR) * Math.sqrt(24) : null;
  const nul = (reason: string): AttributeResult => ({ attribution: null, reason, series: [], sigma24hPct, overlap: 0 });
  const needW = Math.ceil(MIN_WINDOW_SHARE * h);

  // Each factor as [key, series, beta]; BTC itself has none (it is the factor).
  type Used = { key: BetaFit["factor"]; f: Returns; beta: number };
  let used: Used[] = [];
  let betas: BetaFit[];
  let estN: number;
  let r2: number | null = null;
  let alpha = 0;
  let winBars: number[];
  let sigma1h: number | null = null;

  if (a.coin === "BTC") {
    winBars = win.filter((t) => a.r.has(t));
    if (winBars.length < needW) return nul(`window has ${winBars.length} of ${h} hourly bars (needs ${needW})`);
    estN = ownEst.length;
    betas = [fit("BTC", 1, null, estN, "BTC is the factor"), fit("ETH", null, null, 0, "BTC is the factor"), fit("SECTOR", null, null, 0, "BTC is the factor")];
  } else {
    const F = buildFactors(a.btc, a.eth, a.coin === "ETH" ? null : a.peers, est, win);
    const isEth = a.coin === "ETH";
    const base = est.filter((t) => a.r.has(t) && F.f1.has(t) && (isEth || F.f2.has(t)));
    if (base.length < MIN_EST_BARS) return nul(`needs ${MIN_EST_BARS} of ${EST_BARS} hourly bars before the window — has ${base.length}`);
    let sectorReason = isEth ? "majors carry no sector factor" : F.sectorReason;
    let sample = base;
    if (F.f3) {
      const withSector = base.filter((t) => F.f3!.has(t));
      if (withSector.length >= MIN_EST_BARS) sample = withSector;
      else sectorReason = `sector basket has ${withSector.length} of ${MIN_EST_BARS} bars before the window with the coin's`;
    }
    const useSector = F.f3 != null && sectorReason === null;
    const cols: Array<{ key: BetaFit["factor"]; f: Returns }> = [{ key: "BTC", f: F.f1 }, ...(isEth ? [] : [{ key: "ETH" as const, f: F.f2 }]), ...(useSector ? [{ key: "SECTOR" as const, f: F.f3! }] : [])];
    const y = sample.map((t) => a.r.get(t)!);
    const o = ols(y, cols.map((c) => sample.map((t) => c.f.get(t)!)));
    if (!o) return nul("beta fit is singular on the estimation window");
    used = cols.map((c, i) => ({ ...c, beta: o.betas[i]! }));
    alpha = o.alpha;
    estN = sample.length;
    const fitted = (t: number) => sum(used.map((u) => u.beta * u.f.get(t)!));
    const residE = sample.map((t) => a.r.get(t)! - fitted(t));
    const my = sum(y) / y.length;
    const ssTot = sum(y.map((v) => (v - my) ** 2));
    const ssRes = sum(residE.map((e) => (e - alpha) ** 2));
    r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
    sigma1h = robustSigma(residE, SIGMA_FLOOR);
    winBars = win.filter((t) => a.r.has(t) && used.every((u) => u.f.has(t)));
    if (winBars.length < needW) return nul(`window has ${winBars.length} of ${h} hourly bars (needs ${needW})`);
    const contribution = (key: BetaFit["factor"]) => {
      const u = used.find((x) => x.key === key);
      return u ? 100 * u.beta * sum(winBars.map((t) => u.f.get(t)!)) : null;
    };
    betas = [
      fit("BTC", used[0]!.beta, contribution("BTC"), estN, null),
      isEth ? fit("ETH", null, null, 0, "ETH is the factor: its move ex-BTC is the residual") : fit("ETH", used[1]!.beta, contribution("ETH"), estN, null),
      useSector ? fit("SECTOR", used.at(-1)!.beta, contribution("SECTOR"), estN, null) : fit("SECTOR", null, null, F.sectorN, sectorReason),
    ];
  }

  const fittedAt = (t: number) => sum(used.map((u) => u.beta * u.f.get(t)!));
  const residAt = (t: number) => a.r.get(t)! - fittedAt(t);
  const totalPct = 100 * sum(winBars.map((t) => a.r.get(t)!));
  const part = (key: BetaFit["factor"]) => betas.find((b) => b.factor === key)!.contributionPct;
  const btcPct = a.coin === "BTC" ? totalPct : part("BTC")!;
  const ethPct = part("ETH") ?? 0;
  const sectorPct = part("SECTOR");
  const residualPct = a.coin === "BTC" ? 0 : totalPct - btcPct - ethPct - (sectorPct ?? 0);
  if (a.coin === "BTC") betas[0] = fit("BTC", 1, totalPct, estN, "BTC is the factor");

  // Residual split, flow first, then news, then the rest.
  const flowSet = a.flow?.hours ?? null;
  const flowIn = flowSet ? winBars.filter((t) => flowSet.has(t)) : null;
  const newsIn = a.news ? winBars.filter((t) => a.news!.has(t) && !flowSet?.has(t)) : null;
  const overlap = flowSet && a.news ? winBars.filter((t) => flowSet.has(t) && a.news!.has(t)).length : 0;
  const bucket = (bars: number[] | null) => (bars == null ? null : a.coin === "BTC" ? 0 : 100 * sum(bars.map(residAt)));
  const residualFlowPct = bucket(flowIn);
  const residualNewsPct = bucket(newsIn);
  const residualOtherPct = residualPct - (residualFlowPct ?? 0) - (residualNewsPct ?? 0);
  const residualZ = sigma1h == null ? null : (residualPct / 100) / (sigma1h * Math.sqrt(winBars.length));

  let cumT = 0;
  let cumF = 0;
  const series: MoveSeriesPoint[] = winBars.map((t) => {
    cumT += 100 * a.r.get(t)!;
    cumF += a.coin === "BTC" ? 100 * a.r.get(t)! : 100 * fittedAt(t);
    return { t, cumTotalPct: cumT, cumFittedPct: cumF, cumResidualPct: cumT - cumF, flowHour: flowSet?.has(t) ?? false, newsHour: a.news?.has(t) ?? false };
  });

  const start = a.asOf - h * HOUR_MS;
  return {
    attribution: {
      window: a.window, from: iso(start), to: iso(a.asOf), hours: winBars.length,
      totalPct, btcPct, ethPct, sectorPct, residualPct,
      residualFlowPct, residualNewsPct, residualOtherPct,
      flowHours: flowIn?.length ?? null, newsHours: newsIn?.length ?? null,
      residualZ, sigma1hPct: sigma1h == null ? null : 100 * sigma1h, r2,
      estimation: { from: iso(est[0]!), to: iso(start), n: estN },
      betas,
    },
    reason: null,
    series,
    sigma24hPct,
    overlap,
  };
}
