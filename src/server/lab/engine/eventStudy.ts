import { DAY_MS, RuleSchema, type EventVerdict, type LabDataset, type Level, type Rule } from "../types.js";
import { makeCtx } from "./context.js";
import { funnel, inZoneDays, type FunnelStep } from "./evaluate.js";
import { parseFeatureId } from "./features.js";
import { exitText, ruleText } from "./rules.js";
import { isoDate } from "./util.js";

// Event-study screen (docs/FEATURES.md § 2). Replays a Lab rule per coin on daily
// candles + funding through the same in-zone path as live evaluation
// (inZoneDays → conditionSignal, the ruleFiresAt predicate), plays each event
// out to stop / target / horizon, scores it in R net of fees, slippage and
// funding, clusters events by ISO week and only ever rejects. Informational:
// it gates nothing and places nothing.

export const OPEN = "ht:open";
export const HIGH = "ht:high";
export const LOW = "ht:low";
export const FUNDING = "ht:funding";
/** Metrics every coin's dataset needs besides the rule's own (close is dataset.price, ht:price). */
export const STUDY_METRICS = [OPEN, HIGH, LOW, FUNDING];

export const FEE_ROUND_TRIP_PCT = 0.09;
export const DEFAULT_SLIPPAGE_BPS = 5; // per side
export const ATR_WINDOW = 14;
/** A coin needs this many bars with a close and funding to be studied. */
export const MIN_BARS = 365;
export const MIN_WEEKS = 30;
export const HOLDOUT_SHARE = 0.3;
export const SURVIVORSHIP_NOTE =
  "Survivorship: the replay uses today's listed coins, so delisted losers are missing and the past looks better than it was.";

export interface EventStudyOptions {
  /** Defaults: a rule's own stop / target take precedence. */
  stopAtr: number;
  targetAtr: number;
  /** Slippage per side, basis points; default 5. */
  slippageBps?: number;
  /** Bars a coin needs; default MIN_BARS. */
  minBars?: number;
}

export interface StudyEvent {
  coin: string;
  date: string; // signal bar, YYYY-MM-DD
  exit: "stop" | "target" | "invalidation" | "horizon";
  exitDate: string;
  r: number;
  fundingR: number; // funding part of r (negative = paid)
  ambiguous: boolean; // stop and target in one bar: scored as stop
}

export interface CoinStudy {
  coin: string;
  bars: number; // bars with a close and funding
  from: string | null;
  to: string | null;
  events: number;
  status: "ok" | "insufficient";
  reason?: string;
}

export interface Screen {
  events: number;
  weeks: number;
  expectancy: number | null; // mean over weeks of the week's mean R
  upper95: number | null; // expectancy + t(0.95, weeks−1) · sd / √weeks
}

export interface EventStudyResult {
  /** The rule, then its own exits when it has any ("… | stop low(7) − 0.25 ATR; …"). */
  text: string;
  direction: Rule["direction"];
  horizonDays: number;
  stopAtr: number;
  targetAtr: number;
  slippageBps: number;
  feeRoundTripPct: number;
  period: { from: string; to: string; holdoutFrom: string } | null;
  /** Pooled over all coins; the only verdict. */
  screen: Screen;
  verdict: EventVerdict;
  /** Facts, not a second verdict: the same screen on events before / from holdoutFrom (last 30% of the period by time). */
  train: Screen;
  holdout: Screen;
  /** Informational: where the rule's coin-days die, over the studied coins. */
  funnel: { steps: FunnelStep[]; bottleneck: number };
  coins: CoinStudy[];
  eventList: StudyEvent[];
  survivorship: string;
}

/** One-sided 95% Student t quantiles, df 1..30; Cornish-Fisher above (error < 1e-3). */
const T95_ONE_SIDED = [
  6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.74, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714,
  1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697,
];
export function t95(df: number): number {
  if (df < 1) return NaN;
  if (df <= 30) return T95_ONE_SIDED[df - 1]!;
  const z = 1.6448536269514722;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

/** Monday (UTC) of the ISO week containing the day: the cluster key. */
export function isoWeek(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return isoDate(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
}

const fin = (x: number) => (Number.isFinite(x) ? x : null);

/** Week-clustered screen numbers over a set of events. */
export function screenOf(events: StudyEvent[]): Screen {
  const weeks = new Map<string, number[]>();
  for (const e of events) {
    const k = isoWeek(e.date);
    weeks.set(k, [...(weeks.get(k) ?? []), e.r]);
  }
  const ms = [...weeks.values()].map((rs) => rs.reduce((a, b) => a + b, 0) / rs.length);
  const w = ms.length;
  const mean = w ? ms.reduce((a, b) => a + b, 0) / w : NaN;
  const sd = Math.sqrt(ms.reduce((a, x) => a + (x - mean) ** 2, 0) / (w - 1));
  return { events: events.length, weeks: w, expectancy: fin(mean), upper95: fin(mean + (t95(w - 1) * sd) / Math.sqrt(w)) };
}

export function verdictOfScreen(s: Screen): EventVerdict {
  if (s.weeks < MIN_WEEKS) return "insufficient";
  return s.upper95 != null && s.upper95 < 0 ? "rejected" : "clear";
}

/**
 * Events of one coin. A day is an event when the rule is in zone at its close
 * and the previous event's signal bar is at least horizonDays back (cooldown =
 * horizon, so holds never overlap). Entry at the signal close; stop/target =
 * entry ∓/± stopAtr/targetAtr × ATR(14) at the signal bar, or the rule's own
 * stop/target levels (fixed at the signal bar); stop fills at the worse of
 * stop and open, wins a bar that hits both; when the rule's invalidation holds
 * at a bar's close before the horizon bar, exit at the next bar's open;
 * otherwise exit at the horizon close. A firing day whose trade cannot be
 * scored (no ATR or level yet, a stop/target on the wrong side of entry, a
 * missing bar or funding inside the hold, data ends first) is no event.
 */
export function replayCoin(rule: Rule, data: LabDataset, opts: EventStudyOptions): StudyEvent[] {
  const { price: c, t } = data;
  const o = data.metrics[OPEN]!;
  const h = data.metrics[HIGH]!;
  const l = data.metrics[LOW]!;
  const f = data.metrics[FUNDING]!;
  const n = t.length;
  const H = rule.horizonDays;
  const dir = rule.direction === "long" ? 1 : -1;
  const slipPct = (opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS) / 100;
  const fires = inZoneDays(rule, data);
  const invalid = rule.invalidation ? makeCtx(data).signal(rule.invalidation) : null;

  const atrAt = (j: number): number => {
    if (j < ATR_WINDOW) return NaN;
    let s = 0;
    for (let i = j - ATR_WINDOW + 1; i <= j; i++) s += Math.max(h[i]! - l[i]!, Math.abs(h[i]! - c[i - 1]!), Math.abs(l[i]! - c[i - 1]!));
    return s / ATR_WINDOW; // NaN when any input is
  };

  /** NaN when any bar it reads is missing. */
  const levelAt = (e: Level, j: number): number => {
    let v = c[j]!;
    if (e.ref !== "entry") {
      const w = e.n!;
      if (j + 1 < w) return NaN;
      const xs = (e.ref === "low" ? l : e.ref === "high" ? h : c).slice(j - w + 1, j + 1);
      v = e.ref === "low" ? Math.min(...xs) : e.ref === "high" ? Math.max(...xs) : xs.reduce((a, b) => a + b, 0) / w;
    }
    return e.atr ? v + e.atr * atrAt(j) : v;
  };

  const playOut = (j: number): StudyEvent | null => {
    const entry = c[j]!;
    let risk: number; // |entry − stop|
    let stop: number;
    if (rule.stop) (stop = levelAt(rule.stop, j)), (risk = dir * (entry - stop));
    else (risk = opts.stopAtr * atrAt(j)), (stop = entry - dir * risk);
    if (!(risk > 0) || !(entry > 0)) return null;
    const target = rule.target ? levelAt(rule.target, j) : entry + dir * opts.targetAtr * atrAt(j);
    // The default target reads ATR, NaN before ATR_WINDOW bars: no event and no cooldown, not a trade without a target.
    if (!Number.isFinite(stop) || !Number.isFinite(target)) return null;
    if (rule.target && !(dir * (target - entry) > 0)) return null;
    const stopPct = (risk / entry) * 100;
    let funding = 0; // fraction of price paid over the hold
    const scored = (exit: StudyEvent["exit"], px: number, i: number, ambiguous: boolean): StudyEvent => {
      const fundingR = -(funding * 100) / stopPct;
      const r = (dir * (px - entry)) / risk - (FEE_ROUND_TRIP_PCT + 2 * slipPct) / stopPct + fundingR;
      return { coin: data.asset, date: isoDate(t[j]!), exit, exitDate: isoDate(t[i]!), r, fundingR, ambiguous };
    };
    for (let k = 1; k <= H; k++) {
      const i = j + k;
      // Invalidated at the previous close (inside the hold): out at this open, no funding for this day.
      if (invalid?.[i - 1] && k > 1) return i < n && Number.isFinite(o[i]) ? scored("invalidation", o[i]!, i, false) : null;
      if (i >= n || ![o[i], h[i], l[i], c[i], f[i]].every((x) => Number.isFinite(x))) return null;
      funding += dir * f[i]!; // ht:funding is the day's summed hourly rate; a long pays positive funding
      const stopHit = dir > 0 ? l[i]! <= stop : h[i]! >= stop;
      const tgtHit = dir > 0 ? h[i]! >= target : l[i]! <= target;
      let exit: StudyEvent["exit"] | null = null;
      let px = c[i]!;
      if (stopHit) (exit = "stop"), (px = dir > 0 ? Math.min(stop, o[i]!) : Math.max(stop, o[i]!));
      else if (tgtHit) (exit = "target"), (px = target);
      else if (k === H) exit = "horizon";
      if (!exit) continue;
      return scored(exit, px, i, stopHit && tgtHit);
    }
    return null;
  };

  const out: StudyEvent[] = [];
  let next = 0;
  for (let j = 0; j < n; j++) {
    if (j < next || !fires[j]) continue;
    const ev = playOut(j);
    if (!ev) continue;
    out.push(ev);
    next = j + H;
  }
  return out;
}

/** Pools the rule's events over every coin dataset (each: price = ht close, metrics incl. STUDY_METRICS) and screens them. */
export function eventStudy(input: Rule, data: LabDataset[], opts: EventStudyOptions): EventStudyResult {
  const rule = RuleSchema.parse(input);
  if (!(opts.stopAtr > 0) || !(opts.targetAtr > 0)) throw new Error("stopAtr and targetAtr must be > 0");
  const minBars = opts.minBars ?? MIN_BARS;
  const coins: CoinStudy[] = [];
  const events: StudyEvent[] = [];
  const studied: LabDataset[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  const needed = [...new Set([...STUDY_METRICS, ...[...rule.conditions, ...(rule.invalidation ?? [])].map((c) => parseFeatureId(c.feature).metric)])];
  for (const d of data) {
    const missing = needed.filter((m) => !d.metrics[m]);
    const funded = missing.length ? [] : d.t.filter((_, i) => Number.isFinite(d.price[i]) && Number.isFinite(d.metrics[FUNDING]![i]));
    const base = { coin: d.asset, bars: funded.length, from: funded.length ? isoDate(funded[0]!) : null, to: funded.length ? isoDate(funded.at(-1)!) : null };
    if (missing.length) {
      coins.push({ ...base, events: 0, status: "insufficient", reason: `no ${missing.join(", ")}` });
      continue;
    }
    if (funded.length < minBars) {
      coins.push({ ...base, events: 0, status: "insufficient", reason: `${funded.length} bars with funding < ${minBars}` });
      continue;
    }
    const evs = replayCoin(rule, d, opts);
    events.push(...evs);
    studied.push(d);
    coins.push({ ...base, events: evs.length, status: "ok" });
    lo = Math.min(lo, funded[0]!);
    hi = Math.max(hi, funded.at(-1)!);
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.coin < b.coin ? -1 : 1));
  const period = Number.isFinite(lo)
    ? { from: isoDate(lo), to: isoDate(hi), holdoutFrom: isoDate(lo + Math.round(((hi - lo) / DAY_MS) * (1 - HOLDOUT_SHARE)) * DAY_MS) }
    : null;
  const screen = screenOf(events);
  return {
    text: [ruleText(rule), exitText(rule)].filter(Boolean).join(" | "),
    direction: rule.direction,
    horizonDays: rule.horizonDays,
    stopAtr: opts.stopAtr,
    targetAtr: opts.targetAtr,
    slippageBps: opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    feeRoundTripPct: FEE_ROUND_TRIP_PCT,
    period,
    screen,
    verdict: verdictOfScreen(screen),
    train: screenOf(period ? events.filter((e) => e.date < period.holdoutFrom) : []),
    holdout: screenOf(period ? events.filter((e) => e.date >= period.holdoutFrom) : []),
    funnel: funnel(rule, studied),
    coins,
    eventList: events,
    survivorship: SURVIVORSHIP_NOTE,
  };
}
