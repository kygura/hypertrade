# program.md: the eval lab's research loop

This is the agent's brief, after `program.md` in karpathy/autoresearch. There, an agent edits `train.py`, trains for
five minutes, and keeps the change only if `val_bpb` improved. Here the agent proposes a strategy spec, the harness
scores it, and it is kept only if it beats its family's best score.

## Fixed (do not edit while running the loop)

- The data: `bun run eval snapshot --out .eval/snapshot.json` once, then pass `--data .eval/snapshot.json` to every
  command, so every experiment sees the same days.
- The harness: `src/server/eval/objective.ts` (score, costs, folds, holdout), `regimes.ts`, `panel.ts`. Changing the
  objective mid-run makes earlier rows incomparable. A change to the harness is a separate, reviewed commit.
- The holdout: the last 20% of each asset's history. The search never reads it. Look at it once, at the end
  (`bun run eval finalize`).

## What you change

Only the spec: a family from `FAMILIES` in `strategies.ts`, its params (ranges in `PARAM_SPACE`, overlays in
`OVERLAY_SPACE`), an optional regime gate (`regimes`), and `short` for perps.

```json
{ "family": "trend", "params": { "fast": 20, "slow": 120, "volTarget": 35, "maxLev": 1 }, "regimes": ["bull", "range"] }
```

## The loop

1. Read `.eval/<run>/results.tsv` and `best.json`: what was tried, what was kept.
2. Form one hypothesis (one line, it becomes the row's description): "trend works only outside capitulation",
   "a 40% vol target cuts the 2022 drawdown".
3. `bun run eval try --data .eval/snapshot.json --dir .eval/<run> --spec '<json>' --description "<hypothesis>"`
4. Kept: build on it. Discarded: note why and move on. Never re-run the same spec.
5. Every ~20 tries, `bun run eval search --data ... --dir .eval/<run> --families <f> --max 200 --seed <new>` lets the
   mutator explore around your best. It prints search scores only.
6. Stop after your budget. Then `bun run eval finalize` and report the holdout numbers, not the search score.

## What the score rewards

`score = Sharpe − MaxDD@20%vol − 0.25·CVaR95@20%vol − IVcarry + 0.15·worst-regime Sharpe − turnover`, averaged over
four walk-forward folds minus half their spread, then averaged over the assets in the run weighted by √(scored days).
Drawdown, tail and turnover are measured at 20% vol, so the size of a position does not change the score: shrinking
`volTarget` is not an improvement. Folds where the spec's input is missing (funding before the perp listed) are left
out. So: steady over time, no blow-ups, not concentrated in high-IV stretches, not reliant on a single regime, not
churning.

## Honesty rules

- Check that a kept spec is not a lone peak: move each parameter a step either way. If the score collapses, say so.
- A spec that wins the search and loses the holdout is overfit: say so.
- The deflated Sharpe in `finalize` accounts for every row in results.tsv. Below 0.9 means the edge is not
  distinguishable from luck at that number of trials.
- Report what a spec does today (its position on the last day) only as information, never as an order.
