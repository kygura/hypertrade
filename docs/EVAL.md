# Eval lab

A research harness for BTC, ETH and HYPE after [karpathy/autoresearch](https://github.com/karpathy/autoresearch): a
fixed dataset, a fixed objective and a fixed walk-forward split, with only the strategy spec changing between
experiments. Every experiment is one row of `results.tsv`, kept only if it beats the best so far. On top of that, a path
simulator gives the odds of touching the levels the operator watches over the next weeks, conditioned on today's
regime and implied vol.

Code: `src/server/eval/`. CLI: `bun run eval`. Agent brief: [eval/program.md](eval/program.md). Page: `/eval`.

## 1. What it answers

- Which simple strategy families (trend, breakout, mean reversion, capitulation buying, funding fades, regime-gated
  holding) would have held up across regimes, scored on risk-adjusted terms rather than raw return.
- Whether a winner is real: the last 20% of history is never seen by the search and is read once.
- From today's state, how likely each level is to be touched within the horizon, and which of two levels is likely to
  come first.

It places no orders and changes no settings. A spec's position on the last day is shown as information only.

## 2. Data

One panel per asset on a daily UTC calendar (`panel.ts`), loaded from the Lab provider registry (`load.ts`). The
daily `/cron/lab-collect` keeps that history fresh, so the eval needs no collector of its own; `LAB_ASSETS` must
include HYPE.

| Series | BTC | ETH | HYPE | Source |
|---|---|---|---|---|
| Close | yes | yes | yes | Lab price history |
| Implied vol | DVOL | DVOL | stand-in | Deribit |
| Funding | yes | yes | yes | Hyperliquid, daily sum of hourly rates |
| Fear and Greed | market-wide | | | alternative.me |
| MVRV | yes | yes | none | Coin Metrics community |
| STH cost basis | stored + stand-in | stand-in | stand-in | bitcoin-data.com (BTC, recent only) |

### Gaps and their stand-ins

What Glassnode measures that no free API serves as history, and what the panel uses instead:

- **STH realized price** needs UTXO ages. The stand-in is a 155-day trailing mean of price (155 days is Glassnode's
  short-term holder cut-off), scaled by the median stored/stand-in ratio where both exist, so it continues the stored
  series at its level. The panel's `sthSource` says which was used (`stored`, `mixed`, `proxy`).
- **HYPE implied vol**: HYPE has no listed options. The stand-in is 30-day realized vol times BTC's implied-over-realized
  ratio (the variance premium). `ivSource` says `dvol`, `mixed` or `realized`.
- **DVOL before 2021**: the same realized-vol stand-in with the asset's own measured ratio.
- Not covered at all: exchange flows, LTH/STH supply, entity-adjusted metrics, options skew and the funding of venues
  other than Hyperliquid. They are left out rather than guessed.

## 3. Regimes

`regimes.ts` labels each day capitulation, bear, range, bull or euphoria from what was known that day:

- **capitulation**: more than 10% under the STH cost basis with Fear and Greed at or under 20, or more than 55% under
  the 365-day high
- **euphoria**: MVRV above 3, or more than 40% over the cost basis with greed at 75 or more
- **bull / bear**: above / below the 200-day mean with the 50-day mean rising / falling
- **range**: everything else

A label changes only after the raw label has held 5 days in a row (causal hysteresis), so one noisy day does not flip
it and the transition matrix measures real regime changes.

## 4. Objective

`objective.ts`. One number per spec:

```
score = Sharpe − MaxDD@20%vol − 0.25·CVaR95@20%vol − IVcarry + 0.15·worst-regime Sharpe − 0.002·turnover@20%vol
```

- Returns are after a 5 bps fee per unit of position change and perp funding (a long pays positive funding). A position
  decided at the close of day i earns day i+1.
- Drawdown, tail and turnover are measured with returns rescaled to 20% annualized vol, so trading smaller does not
  lower them: the score judges timing, not size.
- **IVcarry** is the implied vol where the strategy holds over the asset's average, minus 1. Above 0 means it sits in
  the market when options price more risk than usual. This is the "least implied volatility" term; it penalises
  capitulation buying by construction, since fear and high implied vol arrive together.
- A spec that holds less than 5% of days has its positive score scaled down by its exposure.
- **Walk-forward**: the search sees four consecutive in-sample folds and scores mean − 0.5 × spread. Folds where the
  spec's own input is missing (funding before the perp listed) are left out rather than scored as flat. Assets are
  weighted by √(scored days), so HYPE's short history counts without setting the ranking alone.
- **Holdout**: the last 20% of each asset's history, read only by `finalize`, which also reports the deflated Sharpe
  (Bailey and López de Prado) for the number of experiments tried. Below 0.9, an edge is not distinguishable from luck.

## 5. The research loop

`search.ts` and `scripts/eval-cli.ts`, briefed for an agent in [eval/program.md](eval/program.md):

1. `bun run eval snapshot --out .eval/snapshot.json` freezes the data.
2. An agent proposes one spec per experiment (`bun run eval try --spec …`) with a one-line hypothesis, or the built-in
   mutator explores around a family's best (`bun run eval search`).
3. Every experiment appends a row to `results.tsv`; `best.json` keeps each family's best.
4. `bun run eval finalize` reads the holdout once.

`champions.ts` holds the specs the page tracks, each with what it won on. A later run replaces one only by beating it
on the same terms.

### First run (Nov 2026)

About 2,750 experiments by three agents across all six families. Holdout: July 2025 to November 2026, a falling
market. Re-scored under the final harness:

| Spec | Search | Holdout | Note |
|---|---|---|---|
| Buy and hold | −0.48 | −0.56 | BTC drawdown 55% |
| Hold in bull and capitulation, 15% vol | 0.02 | −0.51 | beat hold on BTC and ETH, lost on HYPE |
| Breakout 86/44, outside bear and range | 0.35 | −0.34 | ETH Sharpe 0.66, BTC and HYPE negative |
| Deep capitulation, BTC only | 0.32 | −0.29 | Sharpe 0.11, few trades |
| Trend 50/60 | 0.51 | −0.57 | isolated peak in parameter space |
| Funding fade 14d / z 1.28 | 0.78 | −1.17 | BTC Sharpe 0.96, HYPE −4.4 |

No spec beat staying flat on the holdout and no deflated Sharpe exceeded 0.01. The search winners sit on narrow peaks:
moving a parameter a step either way drops the score sharply, and shorting made every family worse. What held up is
smaller exposure in this regime: every gated spec lost far less than holding.

## 6. Path fan

`paths.ts`, regime-aware filtered historical simulation:

- Daily shocks are standardized by that day's vol (z = r / vol), so calm and wild stretches can be reused at today's
  level.
- Each path draws 5-day blocks of shocks from history in the regime it is in, and moves between regimes by the
  empirical transition matrix, so a long horizon mixes regimes the way history did.
- Vol starts at a 60/40 blend of implied and realized and decays toward the long-run level with a 30-day half-life.
  Drift is the regime's mean shock, shrunk by half.
- Outputs: percentile bands per day, for each level the odds of touching it and of closing beyond it with the median
  day of first touch, races (which of two levels comes first), and the regime mix the fan assumed.

## 7. Calibration

`calibrate` re-runs the fan from many past days with only the data known then and checks where the realized price
landed. Over 30 days, as of November 2026:

| Asset | Samples | In 50% band | In 90% band |
|---|---|---|---|
| BTC | 135 | 59% | 89% |
| ETH | 135 | 53% | 88% |
| HYPE | 14 | 57% | 79% |

The tails are close to right; the inner band is a little wide for BTC. HYPE has too little history to judge.

## 8. Live view

`GET /api/eval?horizon=60&levels=BTC:58500,66000;ETH:1500&races=BTC:58500-66000` (`routes/eval.ts`,
`service.ts`) returns, per asset, today's regime, the fan with level odds, and each champion's last year and current
position. Results are cached per UTC day for an hour. The `/eval` page draws it; the levels the operator types are kept
in the browser.
