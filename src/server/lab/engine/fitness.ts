import type { Fitness, RegimeStat, Trend } from "../types.js";
import { concatReturns, sharpeOf, type Segment } from "./backtest.js";
import { meanSd } from "./stats.js";

// The evaluation function (docs/AUTORESEARCH.md "Fitness"): one number per rule,
// read from its walk-forward returns only. Sharpe, less what the track costs in
// drawdown and volatility beyond a budget, less a share of its worst regime.

export const FITNESS = {
  /** Max drawdown (fraction) a rule may run before it costs Sharpe. */
  ddBudget: 0.2,
  /** Annualised volatility of the rule's own returns before it costs Sharpe. */
  volBudget: 0.5,
  ddWeight: 1,
  volWeight: 1,
  /** Share of the worst regime's negative Sharpe taken off the score. */
  regimeWeight: 0.25,
  /** A regime counts (penalty, stance) only with this many days in market. */
  minRegimeDays: 30,
  /** The worst regime's Sharpe is floored here, so 30 bad days cannot swamp the score. */
  regimeFloor: -4,
} as const;

const TREND_ORDER: Trend[] = ["up", "range", "down"];

/** Max drawdown of a daily return track as a fraction ≤ 0. */
export function maxDrawdownOf(ret: ArrayLike<number>): number {
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  for (let i = 0; i < ret.length; i++) {
    eq *= 1 + ret[i]!;
    if (eq > peak) peak = eq;
    mdd = Math.min(mdd, eq / peak - 1);
  }
  return mdd;
}

/**
 * Per-regime stats over the days the rule was in the market. Return day i was
 * earned by the position taken at the close of day i − 1, so it is filed under
 * trend[i − 1]: the regime known when the position was taken.
 */
export function regimeStats(segs: Segment[], trend: ArrayLike<Trend | null>): RegimeStat[] {
  const by = new Map<Trend, number[]>();
  for (const s of segs) {
    for (let k = 0; k < s.ret.length; k++) {
      if (s.held[k] === 0) continue;
      const tr = trend[s.a + k - 1];
      if (!tr) continue;
      let list = by.get(tr);
      if (!list) by.set(tr, (list = []));
      list.push(s.ret[k]!);
    }
  }
  return TREND_ORDER.filter((tr) => by.has(tr)).map((tr) => {
    const r = by.get(tr)!;
    const { m } = meanSd(r);
    return { trend: tr, days: r.length, meanDaily: m, sharpe: sharpeOf(r), hitRate: r.filter((x) => x > 0).length / r.length };
  });
}

/** Fitness of walk-forward (or any) segments. `untested` when the rule never traded in them: its score 0 is not a result. */
export function fitnessOf(segs: Segment[], trend: ArrayLike<Trend | null>): Fitness {
  const ret = concatReturns(segs);
  const traded = segs.some((s) => s.held.some((h) => h !== 0));
  const sharpe = sharpeOf(ret);
  const maxDrawdown = maxDrawdownOf(ret);
  const sd = ret.length > 1 ? meanSd(ret).sd : 0;
  const vol = sd * Math.sqrt(365);
  const regimes = regimeStats(segs, trend);
  const counted = regimes.filter((r) => r.days >= FITNESS.minRegimeDays);
  const worst = counted.length ? Math.min(...counted.map((r) => r.sharpe)) : 0;
  const penalties = {
    drawdown: (FITNESS.ddWeight * Math.max(0, -maxDrawdown - FITNESS.ddBudget)) / FITNESS.ddBudget,
    vol: (FITNESS.volWeight * Math.max(0, vol - FITNESS.volBudget)) / FITNESS.volBudget,
    regime: FITNESS.regimeWeight * Math.max(0, -Math.max(worst, FITNESS.regimeFloor)),
  };
  const score = traded ? sharpe - penalties.drawdown - penalties.vol - penalties.regime : 0;
  return { score, sharpe, maxDrawdown, vol, penalties, days: ret.length, regimes, ...(traded ? {} : { untested: true }) };
}
