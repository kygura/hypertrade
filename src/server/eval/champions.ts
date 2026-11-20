// The specs the eval page tracks on fresh data every day (docs/EVAL.md §5). Each came out of a research run
// (docs/eval/program.md); `why` says what it won on, so a later run can replace it with something that beats it on
// the same terms. Params only: no data, no levels, no positions.
import type { StrategySpec } from "./strategies.js";

export interface Champion {
  name: string;
  why: string;
  spec: StrategySpec;
  /** Limit to these assets (default all). */
  assets?: string[];
}

// First research run (Nov 2026, about 2,750 experiments over BTC, ETH and HYPE, holdout Jul 2025 to Nov 2026): no spec
// beat staying flat on the holdout and no deflated Sharpe came near 0.9, so these are tracked, not trusted. They are the
// ones that lost least on the holdout and kept drawdowns well under buy and hold's.
export const CHAMPIONS: Champion[] = [
  { name: "Buy and hold", why: "Baseline every other spec has to beat. Holdout score -0.56; BTC drawdown 55%.", spec: { family: "hold", params: { volTarget: 0, maxLev: 1 } } },
  {
    name: "Hold in bull and capitulation",
    why: "Long only when the regime is bull or capitulation, 15% vol target. Holdout -0.51; beat plain hold on BTC and ETH, lost on HYPE.",
    spec: { family: "hold", params: { volTarget: 15, maxLev: 1 }, regimes: ["bull", "capitulation"] },
  },
  {
    name: "Breakout 86/44",
    why: "86-day high entry, 44-day low exit, outside bear and range, 40% vol target. Search 0.35, holdout -0.34 (ETH Sharpe 0.66; BTC and HYPE negative).",
    spec: { family: "breakout", params: { entry: 86, exit: 44, volTarget: 40, maxLev: 1 }, regimes: ["capitulation", "bull", "euphoria"] },
  },
  {
    name: "Deep capitulation (BTC)",
    why: "Buys 21% under the short-term holder cost basis with fear at or under 40, exits 35% above it or after 85 days. Search 0.32, holdout -0.29 (Sharpe 0.11). Few trades: a knife-edge fit.",
    spec: { family: "capitulation", params: { gap: 0.2083, fng: 40, exitGap: 0.3505, maxHold: 85, volTarget: 40, maxLev: 1 }, regimes: ["capitulation", "range"] },
    assets: ["BTC"],
  },
];
