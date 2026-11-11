// BTC Vector: regime, key levels, WoC phase, brief and the /api/vector payload,
// ported from hl-cycles (backend/src/model/vector.ts; docs/MODEL.md §8.3–8.7).
// Pure functions over loaded series; the HTF spine is cycles.ts's computeCycle
// (the same trend/heat/phase model hl-cycles' htf.ts computes).

import { commitWithHysteresis, type CyclePhase, type CyclePoint } from "./cycles.js";
import type { Flip, LevelStatus, RegimeState, VectorResponse, WocPhase } from "./vector.js";
import {
  bandOf,
  buildLenses,
  CARRY_DAYS,
  carry,
  change,
  computeCompass,
  DAY,
  FORWARD,
  HEADLINE_BANDS,
  inputScore,
  onSpine,
  pct,
  rollMean,
  zip,
  type AltData,
  type Ctx,
  type FundingRow,
  type LensOut,
  type OiRow,
  type Row,
  type Series,
} from "./vectorCompass.js";

// --- regime constants (MODEL §8.3) ---
export const ON_MAX = 0.25; // mild_risk_on needs riskOff <= this
export const OFF_MIN = 0.5; // strong_risk_off needs riskOff >= this
export const COMMIT_CLOSES = 3;
export const MOM_LOOKBACKS = [20, 50, 200] as const;
export const MOM_SIGMA = 0.035; // daily log-return scale; lookback k is normalised by MOM_SIGMA·√k
const MOM_MAX_LOOKBACK = Math.max(...MOM_LOOKBACKS); // momentum is null before this many closes
const ETF_START = Date.UTC(2024, 0, 11); // US spot ETF launch: the ETF condition is exempt before it
const DSV_MEDIAN_DAYS = 365;
const WEEKS52_LAG = 364; // 52-week average = the last 365 closes, today included
const CORR_DAYS = 30; // BTC vs S&P 500 correlation window, in daily log returns
const CORR_MIN_N = 10; // fewer paired returns -> no correlation

export const ALLOCATION: Record<RegimeState, number> = { strong_risk_on: 100, mild_risk_on: 66, mild_risk_off: 33, strong_risk_off: 0 };
const WORD: Record<RegimeState, string> = {
  strong_risk_on: "strong risk-on",
  mild_risk_on: "mild risk-on",
  mild_risk_off: "mild risk-off",
  strong_risk_off: "strong risk-off",
};
const isOn = (s: string | null) => s != null && s.endsWith("risk_on");

/** MODEL §8.3 raw state. flows null counts as not > 0. */
export function rawState(riskOff: number | null, momentum: number | null, flows: number | null): RegimeState | null {
  if (riskOff == null || momentum == null) return null;
  if (riskOff === 0 && momentum > 0 && flows != null && flows > 0) return "strong_risk_on";
  if (riskOff <= ON_MAX && momentum > 0) return "mild_risk_on";
  if (riskOff >= OFF_MIN && momentum < 0) return "strong_risk_off";
  return "mild_risk_off";
}

/** A new state commits only after holding COMMIT_CLOSES consecutive daily closes (D5). */
export function commitRegime(raw: (RegimeState | null)[]): (RegimeState | null)[] {
  return commitWithHysteresis(raw, () => COMMIT_CLOSES);
}

/** momentum = 100 · mean_k tanh( ln(c[i]/c[i−k]) / (MOM_SIGMA·√k) ), k in 20/50/200. In [−100, 100]. */
export function momentumScore(c: number[]): Series {
  return c.map((x, i) => {
    if (i < MOM_MAX_LOOKBACK) return null;
    let s = 0;
    for (const k of MOM_LOOKBACKS) s += Math.tanh(Math.log(x / c[i - k]!) / (MOM_SIGMA * Math.sqrt(k)));
    return (100 * s) / MOM_LOOKBACKS.length;
  });
}

/** 30d downside semivolatility: sqrt(mean(min(lr, 0)^2)) over 30 daily log returns, × √365. */
export function downsideSemivol(c: number[], k = 30): Series {
  return c.map((_, i) => {
    if (i < k) return null;
    let s = 0;
    for (let j = i - k + 1; j <= i; j++) s += Math.min(0, Math.log(c[j]! / c[j - 1]!)) ** 2;
    return Math.sqrt((s / k) * 365);
  });
}

/** Trailing median of x[i−k+1..i]; null unless all k values are present. */
export function rollMedian(x: Series, k: number): Series {
  return x.map((_, i) => {
    if (i < k - 1) return null;
    const w = x.slice(i - k + 1, i + 1);
    if (w.some((v) => v == null)) return null;
    const s = (w as number[]).sort((a, b) => a - b);
    return k % 2 ? s[(k - 1) / 2]! : (s[k / 2 - 1]! + s[k / 2]!) / 2;
  });
}

/** D5: share of conditions that are true; a null (missing beyond carry-forward) counts as not stressed. Never renormalised. */
export function riskOffShare(conds: (boolean | null)[]): number {
  return conds.filter((c) => c === true).length / conds.length;
}

/** holding: above for the last 2 closes; lost: at/below for both (price == level counts as below); contested: crossed within them. */
export function levelStatus(price: number[], level: Series, i: number): LevelStatus | null {
  if (i < 1 || level[i] == null || level[i - 1] == null) return null;
  const a = price[i]! > level[i]!;
  const b = price[i - 1]! > level[i - 1]!;
  return a && b ? "holding" : !a && !b ? "lost" : "contested";
}

export function wocPhase(price: number, sth: number | null, tmm: number | null): WocPhase | null {
  if (sth == null || tmm == null) return null;
  if (price > tmm && price > sth) return "strong_uptrend";
  if (price < tmm && price < sth) return sth < tmm ? "capitulation" : "bear";
  return "transition";
}

/** D7 disagreement sentence (hl-cycles DESIGN 14.4.1 table, complete as written). */
export function htfNote(state: RegimeState | null, phase: CyclePhase | null): string | null {
  if (state == null || phase == null) return null;
  const on = isOn(state);
  if ((on && ["distribution", "markdown", "capitulation"].includes(phase)) || (!on && phase === "expansion")) {
    return `HTF phase reads ${phase.toUpperCase()} — the cycle frame disagrees with the regime.`;
  }
  return null;
}

/**
 * Flip = the committed state reaches the opposite extreme: strong_risk_on (100% BTC) after the last
 * extreme was strong_risk_off (0%), or vice versa. Mild states are graded steps, not flips (MODEL §8.3).
 * `from` is the committed state of the previous day.
 */
export function flipsOf(t: number[], committed: (RegimeState | null)[], price: number[]): Flip[] {
  const out: Flip[] = [];
  let lastExtreme: RegimeState | null = null;
  committed.forEach((s, i) => {
    if (s !== "strong_risk_on" && s !== "strong_risk_off") return;
    if (lastExtreme != null && s !== lastExtreme) out.push({ t: t[i]!, from: committed[i - 1]!, to: s, price: price[i]! });
    lastExtreme = s;
  });
  return out;
}

/** First day of the current committed state's run (null when the last day has no state). */
export function stateSince(t: number[], committed: (RegimeState | null)[]): number | null {
  let i = committed.length - 1;
  if (i < 0 || committed[i] == null) return null;
  while (i > 0 && committed[i - 1] === committed[i]) i--;
  return t[i]!;
}

// --- payload ---------------------------------------------------------------------------

/** The HTF fields the Vector reads from each daily point (computeCycle output, closed days only). */
export type VectorHtfPoint = Pick<CyclePoint, "t" | "c" | "heat" | "sma200" | "phase">;

export type VectorData = {
  htf: VectorHtfPoint[];
  /** Daily series by name (Coin Metrics, bitcoin-data, FRED, DefiLlama, Deribit, Fear & Greed). */
  series: Record<string, Row[]>;
  /** BTC hourly funding. */
  funding: FundingRow[];
  /** BTC open interest. */
  oi: OiRow[];
  alts: AltData[];
  sources: VectorResponse["sources"];
};

const rnd = (v: number | null | undefined, d: number) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const sig = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(4)));
const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(0)}`);
const signed = (v: number, d = 0) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
const date = (t: number) => new Date(t).toISOString().slice(0, 10);
const at = (x: Series, i: number) => (i >= 0 && i < x.length ? (x[i] ?? null) : null);
const delta = (x: Series, i: number, k: number) => {
  const a = at(x, i);
  const b = at(x, i - k);
  return a == null || b == null ? null : a - b;
};
function avg52w(x: Series, i: number): number | null {
  const w = x.slice(Math.max(0, i - WEEKS52_LAG), i + 1).filter((v): v is number => v != null);
  return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
}
/** Consecutive closes up to i on the same side of `level` as close i. */
function streak(price: number[], level: Series, i: number): number {
  const above = price[i]! > (level[i] ?? NaN);
  let k = 0;
  for (let j = i; j >= 0 && level[j] != null && price[j]! > level[j]! === above; j--) k++;
  return k;
}
function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < CORR_MIN_N) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}

type CondDef = {
  key: string;
  label: string;
  /** Series whose last row dates the condition; null = price-derived (as fresh as the spine). */
  src: string | null;
  value: Series;
  on: (i: number) => boolean | null;
  /** Before this day the condition reads false and its staleness is not checked (D5). */
  exemptBefore?: number;
};
const condOn = (c: CondDef, spine: number[], i: number) => (c.exemptBefore != null && spine[i]! < c.exemptBefore ? false : c.on(i));

/** Regime (MODEL §8.3): six stress conditions, momentum, flows, committed state, flips, staleness. */
export function computeRegime(c: Ctx) {
  const { spine, price } = c;
  const n = spine.length;
  const L = n - 1;
  const tLast = n ? spine[L]! : null;
  const sth = c.s("sth-realized-price");
  const tmm = c.s("true-market-mean");
  const sopr7 = rollMean(c.s("sth-sopr"), 7);
  const dsv = downsideSemivol(price);
  const dsvMed = rollMedian(dsv, DSV_MEDIAN_DAYS);
  const stab30 = change(c.s("totalStablecoinMcapUSD"), 30);
  const etf7 = carry(
    rollMean(onSpine(c.rows("etf-flow-btc"), spine, true), 7).map((m) => (m == null ? null : m * 7)),
    CARRY_DAYS,
  );
  const momentum = momentumScore(price);
  const flows = pct(change(c.s("RealizedCapUSD"), 30));
  const lt = (a: number | null, b: number | null) => (a == null || b == null ? null : a < b);
  const conds: CondDef[] = [
    { key: "price_below_sth", label: "Price below STH cost basis", src: "sth-realized-price", value: sth, on: (i) => lt(price[i]!, sth[i]!) },
    { key: "sth_sopr_below_1", label: "STH-SOPR 7d mean below 1", src: "sth-sopr", value: sopr7, on: (i) => lt(sopr7[i]!, 1) },
    { key: "price_below_tmm", label: "Price below True Market Mean", src: "true-market-mean", value: tmm, on: (i) => lt(price[i]!, tmm[i]!) },
    {
      key: "downside_vol_high",
      label: "30d downside volatility above its 365d median",
      src: null,
      value: zip(dsv, dsvMed, (a, b) => a / b),
      on: (i) => lt(dsvMed[i]!, dsv[i]!),
    },
    { key: "stables_contracting", label: "Stablecoin supply falling over 30d", src: "totalStablecoinMcapUSD", value: pct(stab30), on: (i) => lt(stab30[i]!, 0) },
    { key: "etf_outflow_7d", label: "ETF 7d net outflow", src: "etf-flow-btc", value: etf7, on: (i) => lt(etf7[i]!, 0), exemptBefore: ETF_START },
  ];
  // The regime starts once every on-chain cost-basis input exists (bitcoin-data, 2022-10); no proxies before.
  const ready = (i: number) => sth[i] != null && tmm[i] != null && sopr7[i] != null && dsvMed[i] != null && stab30[i] != null && momentum[i] != null;
  let start = -1;
  for (let i = 0; i < n && start < 0; i++) if (ready(i)) start = i;
  const riskOff: Series = spine.map((_, i) => (start < 0 || i < start ? null : riskOffShare(conds.map((d) => condOn(d, spine, i)))));
  const state = commitRegime(spine.map((_, i) => rawState(riskOff[i]!, momentum[i]!, flows[i]!)));
  const srcAsOf = conds.map((d) => (d.src == null || (d.exemptBefore != null && tLast != null && tLast < d.exemptBefore) ? tLast : c.asOf(d.src)));
  const oldest = srcAsOf.filter((a): a is number => a != null);
  return {
    sth,
    tmm,
    momentum,
    flows,
    riskOff,
    state,
    cur: n ? state[L]! : null,
    since: stateSince(spine, state),
    flips: flipsOf(spine, state, price),
    stale: tLast == null || srcAsOf.some((a) => a == null || tLast - a > CARRY_DAYS * DAY),
    oldestInputAsOf: oldest.length ? Math.min(...oldest) : null,
    conditions: conds.map((d, j) => ({
      key: d.key,
      label: d.label,
      on: n && start >= 0 ? condOn(d, spine, L) === true : false,
      value: sig(at(d.value, L)),
      asOf: srcAsOf[j] ?? null,
    })),
  };
}
type Regime = ReturnType<typeof computeRegime>;

/** Key levels (MODEL §8.4) on the last close. */
export function computeLevels(c: Ctx, r: Regime, sma200: Series): VectorResponse["levels"] {
  const { spine, price } = c;
  const L = spine.length - 1;
  const rp = c.s("RealizedPriceUSD");
  let mvrvSum = 0;
  let mvrvK = 0;
  const meanMvrv = new Map<number, number>();
  for (const row of c.rows("CapMVRVCur")) meanMvrv.set(row.t, (mvrvSum += row.v) / ++mvrvK);
  const meanMvrvPrice = zip(
    rp,
    carry(
      spine.map((t) => meanMvrv.get(t) ?? null),
      CARRY_DAYS,
    ),
    (a, b) => a * b,
  );
  let pv = 0;
  let vol = 0;
  const etfCb: Series = onSpine(c.rows("etf-flow-btc"), spine, true).map((f, i) => {
    if (f != null && f > 0) {
      pv += price[i]! * f;
      vol += f;
    }
    return vol > 0 ? pv / vol : null;
  });
  const defs: { key: string; label: string; series: Series; proxy: boolean }[] = [
    { key: "sth_cost_basis", label: "STH cost basis", series: r.sth, proxy: false },
    { key: "true_market_mean", label: "True Market Mean", series: r.tmm, proxy: false },
    { key: "realized_price", label: "Realized price", series: rp, proxy: false },
    { key: "lth_realized_price", label: "LTH realized price", series: c.s("lth-realized-price"), proxy: false },
    { key: "mean_mvrv_price", label: "Mean MVRV price", series: meanMvrvPrice, proxy: false },
    { key: "sma200", label: "200-day average", series: sma200, proxy: false },
    { key: "etf_cost_basis", label: "ETF cost basis", series: etfCb, proxy: true },
  ];
  const px = L >= 0 ? price[L]! : null;
  return defs.map((l) => {
    const v = at(l.series, L);
    return {
      key: l.key,
      label: l.label,
      value: rnd(v, 2),
      distancePct: v == null || px == null ? null : rnd((px / v - 1) * 100, 2),
      status: levelStatus(price, l.series, L),
      proxy: l.proxy,
    };
  });
}

/** Daily brief (MODEL §8.6): templated sentences plus confirm/invalidate from the nearest levels. */
export function buildBrief(c: Ctx, r: Regime, levels: VectorResponse["levels"], lenses: LensOut[], headline: Series): VectorResponse["brief"] {
  const { spine, price } = c;
  const n = spine.length;
  const L = n - 1;
  const tLast = n ? spine[L]! : null;
  const sentences: string[] = [];
  const nConds = r.conditions.length;
  const active = n && r.riskOff[L] != null ? Math.round(r.riskOff[L]! * nConds) : null;
  if (r.cur && r.since != null && active != null) {
    const days = Math.floor((tLast! - r.since) / DAY);
    const trig = isOn(r.cur)
      ? `momentum below zero or ${Math.floor(ON_MAX * nConds) + 1} active conditions would end risk-on`
      : `risk-on needs positive momentum with at most ${Math.floor(ON_MAX * nConds)} active condition`;
    sentences.push(
      `The Vector regime reads ${WORD[r.cur]} (${ALLOCATION[r.cur]}% BTC) for ${days} days since ${date(r.since)}, with ${active} of ${nConds} stress conditions active; ${trig}.`,
    );
  }
  const levelSentence = (series: Series, name: string, slip: string) => {
    if (!n || series[L] == null) return;
    const k = streak(price, series, L);
    const above = price[L]! > series[L]!;
    sentences.push(
      above
        ? `Price holds above the ${name} (${usd(series[L]!)}) for ${k} sessions; ${slip}.`
        : `Price sits below the ${name} (${usd(series[L]!)}) for ${k} sessions; two daily closes back above it would reclaim it.`,
    );
  };
  levelSentence(r.sth, "short-term holder cost basis", "a daily close below it would end the stretch");
  levelSentence(r.tmm, "True Market Mean", "one daily close below it is a slip, a second confirms the break");
  if (n && r.momentum[L] != null) {
    const m7 = at(r.momentum, L - 7);
    sentences.push(`Momentum reads ${signed(r.momentum[L]!)}${m7 != null ? ` against ${signed(m7)} a week ago` : ""}; a move through zero would flip its leg of the regime.`);
  }
  const fl = n ? r.flows[L] : null;
  if (fl != null) {
    const flowsLens = lenses.find((l) => l.key === "flows")!;
    const p = at(inputScore(flowsLens.inputs.find((x) => x.key === "realized_cap_chg30")!), L);
    sentences.push(
      `Realized cap changed ${signed(fl, 1)}% over 30 days${p != null ? `, the ${Math.round(p)}th percentile of the last four years` : ""}; a turn ${fl > 0 ? "negative would remove" : "positive would restore"} the flows leg of strong risk-on.`,
    );
  }
  const hl = n ? headline[L] : null;
  if (hl != null) {
    const fwd = lenses.filter((l) => FORWARD.includes(l.key) && l.score[L] != null).sort((a, b) => a.score[L]! - b.score[L]!)[0];
    const d30 = delta(headline, L, 30);
    sentences.push(
      `The Compass headline is ${Math.round(hl)} (${bandOf(hl, HEADLINE_BANDS)})${d30 != null ? `, ${signed(d30)} points over 30 days` : ""}${fwd ? `; ${fwd.label} is the weakest forward lens at ${Math.round(fwd.score[L]!)} (${bandOf(fwd.score[L]!, fwd.bands)})` : ""}.`,
    );
  }
  const px = n ? price[L]! : null;
  const live = levels.filter((l) => l.value != null && px != null);
  const above = live.filter((l) => l.value! > px!).sort((a, b) => a.value! - b.value!)[0];
  const below = live.filter((l) => l.value! < px!).sort((a, b) => b.value! - a.value!)[0];
  return {
    sentences,
    confirm: above ? `a daily close above the ${above.label} (${usd(above.value!)}) with realized cap growing` : null,
    invalidate: below ? `a daily close below the ${below.label} (${usd(below.value!)})` : null,
  };
}

const MACRO_SERIES = ["DTWEXBGS", "DGS10", "DGS2", "DFEDTARU", "T10Y2Y", "SP500"];

/** Macro strip: the same last-close (carried) values the Macro lens scores; asOf = oldest series used. */
export function macroStrip(c: Ctx, lenses: LensOut[]): VectorResponse["macro"] {
  const { spine, price } = c;
  const L = spine.length - 1;
  const latest = (name: string) => at(c.s(name), L);
  const dollarIn = lenses.find((l) => l.key === "macro")!.inputs.find((x) => x.key === "dollar_vs_200d")!;
  const priceByT = new Map(spine.map((t, i) => [t, price[i]!]));
  const spx = c
    .rows("SP500")
    .filter((r) => priceByT.has(r.t))
    .slice(-(CORR_DAYS + 1));
  const lr = (xs: number[]) => xs.slice(1).map((x, i) => Math.log(x / xs[i]!));
  const asOfs = MACRO_SERIES.map(c.asOf).filter((a): a is number => a != null);
  return {
    dollarVs200d: rnd(at(dollarIn.values, L), 2),
    us10y: latest("DGS10"),
    us2y: latest("DGS2"),
    fedFundsUpper: latest("DFEDTARU"),
    curve: latest("T10Y2Y"),
    spxCorr30d: rnd(pearson(lr(spx.map((r) => priceByT.get(r.t)!)), lr(spx.map((r) => r.v))), 2),
    asOf: asOfs.length ? Math.min(...asOfs) : null,
  };
}

/** /api/vector payload: regime, Compass, levels, brief, gauges, macro; `price` is the last daily close. */
export function buildVector(d: VectorData): VectorResponse {
  const spine = d.htf.map((p) => p.t);
  const price = d.htf.map((p) => p.c);
  const n = spine.length;
  const L = n - 1;
  const rows = (name: string) => d.series[name] ?? [];
  const memo = new Map<string, Series>();
  const S = (name: string) => {
    if (!memo.has(name)) memo.set(name, carry(onSpine(rows(name), spine), CARRY_DAYS));
    return memo.get(name)!;
  };
  const asOf = (name: string) => {
    const r = rows(name);
    return r.length ? r[r.length - 1]!.t : null;
  };
  const ctx: Ctx = { spine, price, heat: d.htf.map((p) => p.heat), s: S, rows, asOf, funding: d.funding, oi: d.oi, alts: d.alts };

  const regime = computeRegime(ctx);
  const { lenses, headline } = computeCompass(buildLenses(ctx), n);
  const lensByKey = Object.fromEntries(lenses.map((l) => [l.key, l]));
  const levels = computeLevels(
    ctx,
    regime,
    d.htf.map((p) => p.sma200),
  );

  // Gauges (hl-cycles SPEC 4.7.1)
  const gauge = (x: Series, min: number, max: number, dp = 1) => ({
    now: rnd(at(x, L), dp),
    lastWeek: rnd(at(x, L - 7), dp),
    avg52w: rnd(n ? avg52w(x, L) : null, dp),
    scale: { min, max },
  });

  const lensOut = lenses.map((l) => ({
    key: l.key,
    label: l.label,
    score: rnd(at(l.score, L), 1),
    band: bandOf(at(l.score, L), l.bands),
    d7: rnd(delta(l.score, L, 7), 1),
    d30: rnd(delta(l.score, L, 30), 1),
    standalone: l.standalone,
    inputs: l.inputs.map((x, j) => ({
      key: x.key,
      label: x.label,
      value: sig(at(x.values, L)),
      pct: rnd(at(l.pcts[j]!, L), 1),
      asOf: x.asOf,
      unit: x.unit,
    })),
  }));
  const firstCompass = spine.findIndex((_, i) => lenses.some((l) => l.score[i] != null));
  const lensAt = (key: string, i: number) => rnd(lensByKey[key]?.score[i], 1);
  const { cur } = regime;

  return {
    asOf: n ? spine[L]! : null,
    oldestInputAsOf: regime.oldestInputAsOf,
    stale: regime.stale,
    price: n ? rnd(price[L]!, 2) : null,
    regime: {
      state: cur,
      since: regime.since,
      allocation: cur ? ALLOCATION[cur] : null,
      riskOff: rnd(at(regime.riskOff, L), 3),
      momentum: rnd(at(regime.momentum, L), 1),
      flows: rnd(n ? regime.flows[L] : null, 2),
      htfNote: htfNote(cur, n ? d.htf[L]!.phase : null),
      conditions: regime.conditions,
    },
    flips: regime.flips.map((f) => ({ ...f, price: rnd(f.price, 2)! })),
    history: spine.map((t, i) => ({
      t,
      price: rnd(price[i]!, 2)!,
      state: regime.state[i]!,
      riskOff: rnd(regime.riskOff[i], 3),
      momentum: rnd(regime.momentum[i], 1),
    })),
    compass: {
      headline: {
        score: rnd(at(headline, L), 1),
        band: bandOf(at(headline, L), HEADLINE_BANDS),
        d7: rnd(delta(headline, L, 7), 1),
        d30: rnd(delta(headline, L, 30), 1),
      },
      lenses: lensOut,
      history:
        firstCompass < 0
          ? []
          : spine.slice(firstCompass).map((t, k) => {
              const i = k + firstCompass;
              return {
                t,
                headline: rnd(headline[i], 1),
                macro: lensAt("macro", i),
                flows: lensAt("flows", i),
                behaviour: lensAt("behaviour", i),
                fundamentals: lensAt("fundamentals", i),
                cycle: lensAt("cycle", i),
                derivatives: lensAt("derivatives", i),
                rotation: lensAt("rotation", i),
              };
            }),
    },
    levels,
    wocPhase: n ? wocPhase(price[L]!, regime.sth[L]!, regime.tmm[L]!) : null,
    brief: buildBrief(ctx, regime, levels, lenses, headline),
    gauges: {
      risk: gauge(pct(regime.riskOff), 0, 100),
      momentum: gauge(regime.momentum, -100, 100),
      fundamentals: gauge(lensByKey.fundamentals!.score, 0, 100),
      flows: gauge(lensByKey.flows!.score, 0, 100),
    },
    macro: macroStrip(ctx, lenses),
    sources: d.sources,
  };
}
