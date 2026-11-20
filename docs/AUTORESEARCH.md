# AUTORESEARCH — the fitness function, the loop, stance and projection

An extension of the Lab (docs/LAB.md). It answers one question per asset: **on the
signals we have, in the regime we are in, does it pay to be long or short?**
The method is Karpathy's autoresearch (github.com/karpathy/autoresearch) moved
from model training to rule research: agents propose, one fixed evaluator
scores, a candidate is kept only when it beats the best so far, and everything
tried is logged.

| autoresearch | here |
|---|---|
| `prepare.py`: pinned data and the metric, read-only | `src/server/lab/autoresearch.ts` + `bun run autoresearch prepare`: a pinned dataset per asset and the fitness function |
| `train.py`: the one file the agent edits | a rule (JSON): 1–4 conditions on Lab features, a side, an optional trend-regime gate |
| `val_bpb`, lower is better | `fitness`, higher is better |
| 5-minute run | one evaluation, under a second |
| `results.tsv`: commit, metric, status, description | `results.tsv`: rule id, slot, fitness, Sharpe, drawdown, vol, status, rule, description |
| keep the commit or `git reset` | `keep` or `discard` per slot |
| `program.md` | this file |

## Fitness (`engine/fitness.ts`)

One number per rule, read from its **walk-forward returns only** (docs/LAB.md §7:
fixed thresholds on each test block of the first 80% of history, net of 10 bps
slippage per position change):

```
fitness = Sharpe
        − max(0, |max drawdown| − 0.20) / 0.20      drawdown over a 20% budget
        − max(0, annualised vol − 0.50) / 0.50      the rule's own volatility over 50%
        − 0.25 × max(0, −worst regime Sharpe)       floored at −4; regimes with 30+ days in market
```

Sharpe is daily mean / stdev × √365. A rule that is flat most days has low
volatility by construction, so the volatility term only bites a rule that is
in a violent market most of the time. Implied volatility is not in the
function; it is a feature a rule can condition on (`deribit:btc_dvol`,
`deribit:eth_dvol`). A rule that never trades in the walk-forward is
`untested`, not zero. Every `RuleEvaluation` carries `fitness` with its parts.

**Regimes.** The Lab's daily trend (`trendSeries`: `up`, `range`, `down`; close
vs MA50, MA20 vs MA50, 20-day rate of change, three days to commit). A day's
return is filed under the regime known when the position was taken. `fitness.regimes`
holds, per regime, the in-market days, net mean daily return, Sharpe and hit
rate.

## The loop

```bash
bun run autoresearch prepare --asset BTC        # pin the data (once per run)
bun run autoresearch metrics --asset BTC        # what a rule may read, and since when
bun run autoresearch eval --domain onchain --desc "why this should work" --rule '{...}'
bun run autoresearch board                      # each slot's champion
bun run autoresearch report --asset BTC         # the end: holdout, stance, projection
```

Files go to `AUTORESEARCH_DIR` (default `.autoresearch/`, untracked).

- **Slot** = asset / side / domain (`BTC/long/onchain`). Domains keep the
  champions from being five versions of one idea: `onchain`, `derivatives`,
  `flows` (sentiment and liquidity), `price`.
- **Keep** when the candidate trades at least once a year in the walk-forward,
  its fitness is above 0, and it beats the slot's best by more than 0.05.
  Otherwise `discard`; a rule that cannot be scored is `invalid`. The same
  rule in the same slot twice is a discard.
- **The agent never sees the holdout.** `eval` prints walk-forward numbers
  only. The last 20% of history is read once, by `report`, after the loop
  stops; its deflated Sharpe uses N = every experiment logged for the asset.
  A champion still has to clear the Lab's save bar (`lab_catalogue_save`)
  before it is tracked.
- **Simpler wins ties.** One condition over two, a round threshold over a
  tuned one. A candidate that needs a threshold to the third decimal is a
  fit to the past.

### Instructions for a research agent

You own one domain. Read `metrics`, then run experiments with `eval`, one rule
at a time, until your budget is spent. Each experiment starts from a reason
(what the metric measures and why the market should move after it), written in
`--desc` before you see the score. After each result, read the regime table: a
rule that makes its money in one regime and loses it in another wants a
`regime` gate, not a tighter threshold. Do not edit any file, do not run
`report`, do not read `results.tsv` rows of other domains. Do not stop to ask
whether to continue.

## Stance (`engine/stance.ts`, tool `lab_stance`)

Reads a set of rules (the catalogue's for the asset, or `rules` passed in) and
today's trend regime. A rule counts for its side when it **fires on the latest
bar**, its fitness is above 0, and it has 30+ in-market walk-forward days in
today's regime. A side's edge is the days-weighted net mean daily return those
rules earned in this regime. The side with a positive edge is the answer; with
both positive the larger is taken and the reasons say they disagree; with
neither, `flat`. `flat` means no firing rule has an edge here, not a bearish
read.

## Projection (`engine/project.ts`, tool `lab_project`)

Hypothetical price paths from today and how likely each kind is. A block
bootstrap of the asset's own daily returns: a path starts on a past day that
was in today's regime and replays the days that followed; each next block
starts on a day in the regime the last block ended in, so regimes change at the
rate they changed in history. Returned: the fan (p10, p25, p50, p75, p90 per
day, as multiples of today's price), five timelines (`sharp drop`, `drift
lower`, `sideways`, `drift higher`, `sharp rally`; band edges at ±⅓ and ±1
sigma of the horizon move) each with its likelihood and median path, `pUp`,
the median return and the median drawdown along a path. Under 20 past days in
today's regime the draw is unconditional and `conditioned` is false. It replays
history: it cannot show a move the asset never made, and it knows nothing
about a rule's signal.

## Done means

`bun test ./src` green, including `fitness.test.ts` (each penalty, the regime a
return is filed under), `project.test.ts` (seeded; a path started in an up
state projects up and one in a down state down), `stance.test.ts` and
`autoresearch.test.ts` (keep margin, the log round-trip, and that an
experiment's output holds no holdout number).
