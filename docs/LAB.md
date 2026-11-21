# LAB — heuristic research engine (Alpha Lab equivalent)

Hypertrade's answer to Glassnode Alpha Lab (research.glassnode.com/glassnode-alpha-lab,
Sep 2026): search a metric universe for **simple, human-readable trading
heuristics** ("when feature A < x and feature B ≥ y, go long BTC"), score them as
strategies net of fee, slippage and funding, validate them out of sample and
against simply holding the asset, keep the good ones in
a catalogue that is re-evaluated on new data, and expose all of it as one tool
set that every client calls the same way: REST, MCP (HTTP and stdio), a CLI,
and a `/lab` page.

Glassnode's own Alpha Lab MCP is a closed beta for selected clients, with no
published tool list, and it searches only Glassnode data, which needs a paid
key. This is a rebuild of the published methodology over data we can reach
without buying a key.

## Methodology (what the engine does)

1. **Question.** Asset, direction (`long` | `short`), the metrics to scan,
   horizon in days, objective (`sharpe` | `return`), and the search budget
   (number of trials).
2. **Labels define truth.** Each day in the history is marked good (1) or not
   (0) by what the price did next: forward return over `horizonDays`. Long:
   good = forward return ≥ the `labelQuantile` upper quantile *and* > 0.
   Short: ≤ the lower quantile *and* < 0. Default quantile 0.3. The quantile
   is read only from the rows being trained on: each walk-forward fold labels
   with its own training region (forward windows ending at its test block),
   the final refit with the whole search region, so no fold's labels see the
   return distribution of a later test block. `customZones` (date ranges)
   replace this: days inside a zone are 1.
3. **Feature expansion.** Each metric is expanded into transformed versions:
   `raw`, `z` (rolling z-score), `rsi`, `ma_ratio` (value / SMA − 1), `roc`
   (rate of change), `vol` (rolling stdev of log changes), `pctile` (rolling
   percentile rank 0–1), each at every window in `windows` (default
   `[7, 30, 90]`; `raw` has no window). Every transform at day t uses only
   data ≤ t. One more transform, `vchg` (volatility-scaled change), is only
   computed when a search lists it or a rule names it: the w-day log change
   divided by the sample stdev of the 30 daily log changes ending at t times
   √w, i.e. the w-day move in w-day sigmas of the series' own volatility, so
   "moved less than one sigma over 3 days" is one threshold on BTC and on a
   memecoin. Positive series only; NaN until 15 of the 30 daily changes exist. Each metric carries `lagDays` (publication lag; on-chain data
   lands a day late) and is shifted by it before anything else happens.
   Metrics flagged `stationary: false` (trending levels: price, market cap,
   supply) get no `raw` feature, since an absolute threshold on a level that
   drifts across years is a date filter, not a condition.
4. **Search.** A random forest of depth-2 CART trees (gini, quantile-binned
   thresholds, bootstrap rows, feature subsampling) is grown per trial. A
   seeded optimizer runs a fixed budget of `trials`: the first half samples
   hyperparameters at random (feature fraction, min leaf size, bootstrap
   fraction, trees), the second half perturbs the best so far. Each trial is
   scored by walk-forward strategy performance under the objective, not by
   classification accuracy.
5. **Rules, not predictions.** Every root-to-leaf path whose leaf is majority
   class 1 is a rule of one or two conditions (a searched rule never holds
   more; a rule written by hand, e.g. a signal definition or an authored
   rule, holds up to four, `MAX_CONDITIONS`). A path's single-condition
   prefixes are kept as rules too, so a pair can be read whole or split into
   single-metric rules. Each rule is judged on **precision** (share of in-zone
   days labelled good) and **support** (in-zone days); rules below `minSupport`
   are dropped and duplicates merged. A candidate must also trade: in the
   market on `minExposure`–`maxExposure` of the training days (default
   5–95%) and entering at least max(3, `minTradesPerYear` × years) trades
   (default 0.5 a year); otherwise it is not scored.
6. **Strategy scoring.** A rule is a daily signal: in zone at the close of day
   t means position +1 (long) or −1 (short) over day t+1, else flat. Costs,
   the same three the event study charges per trade (`engine/backtest.ts`,
   shared constants): (`slippageBps` + the 4.5 bps taker fee,
   `TAKER_FEE_BPS`) × |position change|, and funding on held exposure: a day
   in the market pays that day's `ht:funding` (the day's summed hourly rate; a
   short receives it). Every search, evaluation and catalogue re-run loads
   `ht:funding` beside its own metrics. A day without a rate (an asset with no
   Hyperliquid perp, the years before it listed, a collection gap) is charged
   no funding; `costs { slippageBps, feeBps, fundingDays, days }` on every
   evaluation says how many return days of the range carried a rate
   (`fundingDays` 0 = none charged). The event study drops a trade whose hold
   lacks a funding bar; a daily track cannot drop a day without inventing a
   flat one, so it charges fee and slippage there and reports the coverage.
   The two differ in their defaults only: slippage 10 bps a side here, 5 in
   the event study (each is an argument). Reported per window: total return,
   CAGR, Sharpe (daily mean / stdev × √365), max drawdown, hit rate (share of
   closed trades, i.e. contiguous in-zone episodes, with positive net
   return), trades per year, exposure (share of days in market), and an equity
   curve on request. A buy-and-hold benchmark (or short-and-hold for short)
   is reported for the same windows, under the same costs. All numbers are
   net of fee, slippage and funding (evaluations stored without `costs` are
   net of slippage only). A window with no trade is flagged `untested` (its
   Sharpe 0 is not a result).

   *Excess over the benchmark.* Each window also reports `excessSharpe`: the
   Sharpe of the rule's daily returns minus e × the benchmark's return that
   day, where e is the share of the window's days the rule is in the market
   (per walk-forward block for the walk-forward). It is the exposure-matched
   excess: a rule that only holds the asset has e = 1 and an excess of 0
   every day, and a rule in the market on days chosen at random earns e × the
   asset's drift and has exactly that taken back. What is left is what the
   choice of days added. (Subtracting the benchmark's return only on the days
   the rule is in would cancel the rule's own return; the benchmark's Sharpe
   as a hurdle would reject a real edge on a strongly trending asset and
   leave the deflated Sharpe's null at zero drift.) The verdict, the deflated
   Sharpe and the final ranking read this excess, so beta earns nothing.
7. **Validation, three stages.**
   - *Holdout:* the most recent 20% of history is cut off before the search
     and used only to evaluate final rules. Never used for ranking.
   - *Walk-forward:* the search region (first 80%) is split chronologically
     into `folds + 1` blocks; fold i trains on blocks 0..i and tests on block
     i+1. Training sets are **purged** of their last `horizonDays` days, whose
     labels look into the test block. Trials are scored on concatenated test
     blocks. **Search rules: threshold-refit per fold.** For each final rule
     of a search the walk-forward stat refits the rule per fold by **quantile
     matching**: same features and operators, threshold = the same train-set
     quantile the final threshold sits at. The rule's structure (features,
     operators) was chosen on the whole search region, so a final rule's
     walk-forward stat is not fully out of sample. The trial score, which
     regrows forests per fold, is. **Explicit rules: fixed thresholds per
     fold.** `lab_evaluate_rule` applies the rule's absolute thresholds as
     given in every fold's test block; nothing is fitted to any fold's
     training rows, since the rule is an input, not a search result.
   - *Live:* once catalogued, a rule is evaluated on data after `savedAt`,
     which could not have influenced its selection.
   Final rules are ranked by the walk-forward objective of their excess over
   the exposure-matched benchmark (§6; support-filtered), never by holdout:
   on a drifting asset the raw objective ranks by time in the market and
   crowds a real rule out of the top K. Trials are still scored on raw
   walk-forward performance. Each also reports `walkForwardFolds` (the Sharpe of every test
   block, never ranked on; `null` for a block with no trade: untested, not a
   Sharpe of 0) and `deflatedSharpe` (Bailey & López de Prado):
   the probability that the daily Sharpe of the concatenated walk-forward
   excess returns (§6: its null is zero mean, which is true of noise only
   once the asset's drift is taken out),
   corrected for their skew and kurtosis, beats the expected best of N noise
   strategies, with the null variance of a Sharpe 1/(T − 1). N is
   `effectiveTrials`, not the raw `variantsScored` (see *Effective trials*
   below). It is `null` when undefined: at extreme skew/kurtosis the
   Sharpe's standard error term 1 − skew·SR + (kurt − 1)/4·SR² is ≤ 0. It is
   a reported field, an optional filter (`minDeflatedSharpe`) and part of the
   verdict. An explicit rule (`lab_evaluate_rule`) gets the same folds with
   its thresholds fixed (above), with N = `trials` (default 1: not deflated
   for any search; pass the run's `effectiveTrials`).
   The final list keeps one rule per family: best walk-forward first, a rule
   whose in-zone days over the search region overlap a kept rule's with
   Jaccard ≥ 0.8 is dropped, and no single condition anchors more than two
   rules. Holdout days never enter this comparison.

   *Effective trials.* A search scores thousands of distinct rule variants
   (`variantsScored`, 2,000–5,600 at 16 trials on the synthetic tests,
   4,000–11,900 at 40), but most are threshold neighbours and family members
   whose return tracks are nearly identical, so counting each as an
   independent trial over-deflates: with raw N the planted rule's deflated
   Sharpe was 0.39–0.89 and a 0.95 bar rejected it. Following López de
   Prado, N is the number of correlation clusters among the variants:
   greedy, in scoring order, a variant joins the largest cluster whose
   representative's search-region return track it correlates with at ≥ 0.5,
   else starts a new one. For tracks r = s·x (s the in-zone flag, x the
   day's return, mean ≈ 0) that correlation is the overlap of in-zone days
   |A ∩ B| / √(|A|·|B|), computed by popcount on bitsets packed once when a
   variant is first scored: N_eff matched exact return-correlation
   clustering within ±8%, and the whole step costs 1–4% of a search's time.
   Only search-region days count (the holdout never moves N). Typical
   `effectiveTrials`: 92–181 at 16 trials, 118–243 at 40. A participation
   ratio (Σλ)²/Σλ² was tried and rejected: cluster sizes are heavy-tailed
   (one family often holds a third of all variants), and the ratio, in effect
   a Simpson index of cluster shares, came out at 6–7 for searches with
   100+ distinct clusters. Above 20,000 variants a seeded sample of 20,000 is
   clustered and the count scaled by N / 20,000.

   *Verdict.* Every evaluation carries `verdict { level, reasons }`; the
   first failing check sets the level, `reasons` names every failed check
   with its numbers (e.g. "deflated Sharpe 0.71 < 0.9"):
   `fails_holdout` (holdout missing, untested, Sharpe ≤ 0 or excess Sharpe
   ≤ 0) → `weak` (walk-forward missing, Sharpe ≤ 1 or excess Sharpe ≤ 1) →
   `fragile` (stability < 0.5, when a sensitivity grid is attached) →
   `candidate` (deflated Sharpe missing, undefined — reason "deflated Sharpe
   undefined (extreme skew/kurtosis)" — or < 0.9; or stats that carry no
   excess, reason "excess over the benchmark not measured") → `robust`. Each
   window must clear its bar twice: on its own Sharpe (the rule made money)
   and on its excess over the exposure-matched benchmark (it made more than
   holding the asset for the same share of days would have). **The save bar is `robust`.** A `candidate` may be
   saved only with a note explaining why. `catalogueSave` enforces both: a
   verdict below `candidate` is refused, and so is a `candidate` without a
   note. An agent or MCP save also needs a `runId`, so the deflated Sharpe
   uses that run's trial count; for a rule no run returned (for example from
   `lab_author_rule`), pass a `lab_search` run on the same asset. The search can return only rules at
   or above `minVerdict`; it filters the selected top K after the fact and
   never reaches deeper candidates, so the holdout still selects nothing.
   Catalogue entries and runs stored before verdicts existed get one
   computed on read (their stored deflated Sharpe used raw N, so they lean
   `candidate`). So does an entry or run whose evaluation has no `costs`
   field: it was judged on the earlier bar (raw Sharpe only, no benchmark,
   deflated Sharpe on raw returns, backtest net of slippage alone), so its
   stored verdict is not shown. The verdict is recomputed on read from the
   stored stats, which carry no excess, and is therefore at most `candidate`
   with the reason "excess over the benchmark not measured … re-evaluate";
   a re-save of such an entry needs a note like any candidate. **Nothing
   stored is rewritten**: the recompute happens in the service, the same for
   the Postgres, file and memory stores, and old files load as before.
   Re-evaluate the rule (`lab_evaluate_rule`) for a verdict on this bar. An
   evaluation that has `costs` keeps its stored verdict. A verdict computed now over stats without
   `excessSharpe` (a save that takes its walk-forward from an old run) is at
   most `candidate`. A catalogue save with a `runId` keeps the run's walk-forward,
   `walkForwardFolds` and deflated Sharpe (the numbers the rule was selected
   on, deflated by the run's `effectiveTrials`), evaluates the rest fresh with
   N = the run's `effectiveTrials` over the run's `from`/`to` and slippage
   (so the fresh holdout is the run's, never inside its search region; the
   entry's PerfStats `from`/`to` show the range), and recomputes the verdict.

   *Calibration* (`engine/calibrate.ts`; `bun src/server/lab/engine/calibrate.ts
   [trials]` reprints it). Synthetic data, 2,500 days: 40 pure-noise seeds
   and 20 planted seeds at each of two strengths (next-day drift 0.012 and
   0.008 while z(a, 30) < −1 and b ≥ 0, daily noise 0.02), each searched at
   three buy-and-hold Sharpe levels: 0, ≈ 1 and ≈ 2 (a drift added to every
   day's return whatever the metrics say, `testkit.ts` `trend`; the metrics
   still predict nothing). For each deflated-Sharpe cut-off, the full bar is
   applied to the top 10 rules; "planted rule robust" counts searches whose
   top 10 holds the planted rule and it is `robust` ("found" = in the top 10
   at all). A planted series has a buy-and-hold Sharpe of its own (about 1.4
   at drift 0.012 and 1.0 at 0.008, averaged over the seeds: the edge is in
   the price), so its first column is not a flat asset.

   16 trials (the test configuration):

   | DSR ≥ | noise: any top-10 robust | noise: top-1 robust | noise, B&H Sharpe ≈ 1: any top-10 robust | noise, B&H Sharpe ≈ 1: top-1 robust | noise, B&H Sharpe ≈ 2: any top-10 robust | noise, B&H Sharpe ≈ 2: top-1 robust |
   |---|---|---|---|---|---|---|
   | 0.00 | 4/40 | 2/40 | 13/40 | 7/40 | 10/40 | 6/40 |
   | 0.50 | 2/40 | 1/40 | 2/40 | 2/40 | 2/40 | 2/40 |
   | 0.80 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 |
   | **0.90** | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 |
   | 0.95 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 |

   | DSR ≥ | drift 0.012: planted rule robust | drift 0.012: any top-10 robust | drift 0.012, B&H Sharpe ≈ 1: planted rule robust | drift 0.012, B&H Sharpe ≈ 1: any top-10 robust | drift 0.012, B&H Sharpe ≈ 2: planted rule robust | drift 0.012, B&H Sharpe ≈ 2: any top-10 robust | drift 0.008: planted rule robust | drift 0.008: any top-10 robust | drift 0.008, B&H Sharpe ≈ 1: planted rule robust | drift 0.008, B&H Sharpe ≈ 1: any top-10 robust | drift 0.008, B&H Sharpe ≈ 2: planted rule robust | drift 0.008, B&H Sharpe ≈ 2: any top-10 robust |
   |---|---|---|---|---|---|---|---|---|---|---|---|---|
   | 0.00 | 18/20 (found 18) | 20/20 | 19/20 (found 19) | 20/20 | 16/20 (found 16) | 20/20 | 8/20 (found 11) | 19/20 | 8/20 (found 11) | 18/20 | 9/20 (found 10) | 19/20 |
   | 0.50 | 18/20 (found 18) | 20/20 | 18/20 (found 19) | 20/20 | 15/20 (found 16) | 20/20 | 8/20 (found 11) | 16/20 | 7/20 (found 11) | 14/20 | 7/20 (found 10) | 15/20 |
   | 0.80 | 18/20 (found 18) | 19/20 | 16/20 (found 19) | 19/20 | 13/20 (found 16) | 18/20 | 5/20 (found 11) | 10/20 | 5/20 (found 11) | 10/20 | 5/20 (found 10) | 9/20 |
   | **0.90** | 15/20 (found 18) | 18/20 | 16/20 (found 19) | 17/20 | 13/20 (found 16) | 17/20 | 4/20 (found 11) | 7/20 | 5/20 (found 11) | 9/20 | 4/20 (found 10) | 8/20 |
   | 0.95 | 15/20 (found 18) | 16/20 | 15/20 (found 19) | 16/20 | 13/20 (found 16) | 16/20 | 4/20 (found 11) | 6/20 | 4/20 (found 11) | 7/20 | 4/20 (found 10) | 7/20 |

   40 trials (the tool default):

   | DSR ≥ | noise: any top-10 robust | noise: top-1 robust | noise, B&H Sharpe ≈ 1: any top-10 robust | noise, B&H Sharpe ≈ 1: top-1 robust | noise, B&H Sharpe ≈ 2: any top-10 robust | noise, B&H Sharpe ≈ 2: top-1 robust |
   |---|---|---|---|---|---|---|
   | 0.00 | 7/40 | 4/40 | 8/40 | 4/40 | 8/40 | 4/40 |
   | 0.50 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 |
   | 0.80 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 |
   | **0.90** | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 |
   | 0.95 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 | 0/40 |

   | DSR ≥ | drift 0.012: planted rule robust | drift 0.012: any top-10 robust | drift 0.012, B&H Sharpe ≈ 1: planted rule robust | drift 0.012, B&H Sharpe ≈ 1: any top-10 robust | drift 0.012, B&H Sharpe ≈ 2: planted rule robust | drift 0.012, B&H Sharpe ≈ 2: any top-10 robust | drift 0.008: planted rule robust | drift 0.008: any top-10 robust | drift 0.008, B&H Sharpe ≈ 1: planted rule robust | drift 0.008, B&H Sharpe ≈ 1: any top-10 robust | drift 0.008, B&H Sharpe ≈ 2: planted rule robust | drift 0.008, B&H Sharpe ≈ 2: any top-10 robust |
   |---|---|---|---|---|---|---|---|---|---|---|---|---|
   | 0.00 | 15/20 (found 15) | 20/20 | 17/20 (found 17) | 20/20 | 15/20 (found 15) | 20/20 | 10/20 (found 13) | 18/20 | 9/20 (found 10) | 17/20 | 11/20 (found 11) | 19/20 |
   | 0.50 | 15/20 (found 15) | 20/20 | 17/20 (found 17) | 20/20 | 14/20 (found 15) | 20/20 | 10/20 (found 13) | 14/20 | 8/20 (found 10) | 15/20 | 8/20 (found 11) | 15/20 |
   | 0.80 | 15/20 (found 15) | 18/20 | 17/20 (found 17) | 20/20 | 13/20 (found 15) | 18/20 | 6/20 (found 13) | 10/20 | 5/20 (found 10) | 11/20 | 7/20 (found 11) | 11/20 |
   | **0.90** | 13/20 (found 15) | 17/20 | 15/20 (found 17) | 17/20 | 12/20 (found 15) | 18/20 | 5/20 (found 13) | 8/20 | 5/20 (found 10) | 10/20 | 6/20 (found 11) | 8/20 |
   | 0.95 | 12/20 (found 15) | 16/20 | 14/20 (found 17) | 17/20 | 11/20 (found 15) | 15/20 | 4/20 (found 13) | 6/20 | 3/20 (found 10) | 7/20 | 3/20 (found 11) | 7/20 |

   Why the drift columns exist: the bar before the benchmark gate (raw
   walk-forward Sharpe > 1, raw holdout Sharpe > 0, deflated Sharpe of raw
   returns ≥ 0.9, backtest net of slippage only), on the same seeds at 16
   trials, passed some top-10 rule in 1/40 noise searches at buy-and-hold
   Sharpe 0, 4/40 at ≈ 1 and 33/40 at ≈ 2: a long rule on a rising asset was
   `robust` for being long. With the excess gates and the deflated Sharpe on
   the excess track it is 0/40 at all three levels and both budgets. The
   excess gates alone do not do it (the 0.00 row: up to 13/40); the deflated
   Sharpe on excess returns does.

   Rule: the cut-off keeps noise searches with any robust top-10 rule at
   ≤ 1 in 20 at every buy-and-hold Sharpe and, among those that do, keeps the
   most planted rules robust (ties to the stricter). On these tables the
   rule alone picks 0.5 (2/40 at each level at 16 trials, 0/40 at 40).
   **`MIN_DEFLATED_SHARPE` stays 0.9** (`engine/verdict.ts`): it was not
   lowered in the change that redefined what it is taken on. At 0.9 no noise
   search passes at any level or budget (0/240), and the planted rule is
   robust in 15 of the 18 searches that find it at drift 0.012 and 16 trials
   (16 of 19 and 13 of 16 on the drifting price), 13 of 15 at 40 trials. The
   price of the stricter statistic is the weak edge: at drift 0.008, 4 of the
   11 found are robust (it was 10 of 12 on the earlier bar), the rest stop at
   `candidate` on the deflated Sharpe. Two things lower it: the excess track
   gives up about √(1 − e) of the Sharpe (the benchmark holds a share e of the
   planted edge), and the planted zone trades nearly every in-zone day, so
   the taker fee takes 9 bps a round trip from an 80 bps edge. Recalibrating
   to 0.8 would keep noise at 0/240 and return 18 of 18 strong planted rules
   at 16 trials (5 of 11 weak); that is a separate decision.

   *How sure is the noise rate?* 0 noise searches in 40 passing bounds the
   false-positive rate below about 9% (exact Clopper–Pearson 95%) at each
   level and budget; pooled over the three levels and two budgets, 0 in 240
   bounds it below about 1.5%, though the levels share seeds and are not
   independent. More seeds would narrow this.

   The suite does not re-run the calibration (it takes ~2 min and tests the
   seeds the threshold was chosen on). Instead `search.test.ts` validates
   `MIN_DEFLATED_SHARPE` out of sample on disjoint seeds at 16 trials:
   noise seeds 3000–3009 at buy-and-hold Sharpe 0, ≈ 1 and ≈ 2, at most 1 of
   10 with any robust top-10 rule at each level, and planted seeds 4000–4005
   at drift 0.012, at least 4 of 6 with the planted rule robust on the flat
   price and at least 3 of 6 on the drifting one (buy-and-hold Sharpe ≈ 2).
   `evaluate.test.ts` holds the direct cases: always long on a drifting
   noise series is not robust, a coin flip of the days is not, the planted
   rule still is.

8. **Sensitivity.** Each condition's threshold is shifted to quantiles
   q ± 0.05 and q ± 0.10, and its window is swapped for neighbouring windows in
   the config. `stability` = share of perturbations whose search-region Sharpe
   keeps the base sign and is at least half the base. A rule that only works
   at one exact threshold is flagged.
9. **Catalogue.** Saved rules carry their evaluation at save time. The
   catalogue health check flags:
   - *decay*: at least 30 live days and live Sharpe < max(0, 0.25 × holdout
     Sharpe);
   - *overlap*: pairs whose in-zone day sets have Jaccard ≥ 0.6 over their
     shared history;
   - *gaps*: asset × direction combinations with no active rule.
10. **Market Pulse.** For each catalogued rule, is it firing on the latest
    data? Aggregated per asset as `longActive / longTotal`, `shortActive /
    shortTotal`, and `lean = (longActive − shortActive) / (longTotal +
    shortTotal)`, with the individual rules listed.

Determinism: one seeded PRNG (`seed`, default 42) drives everything, so the
same config on the same data returns the same rules.

## Data providers (pluggable, keyless by default)

`src/server/lab/providers/`. Each provider implements `LabProvider`
(`types.ts`): a static metric catalogue and `fetch(key, asset, fromMs, toMs)`
returning a UTC-daily series. Metric ids are `<provider>:<key>`. A provider
whose source is unreachable reports that in `warnings`; it never fails the
whole search.

| provider | source | metrics (scope) | notes |
|---|---|---|---|
| `ht` | hypertrade Postgres (`candles`, `funding`, `observations`) with live Hyperliquid fallback for price/funding when the DB is absent | `price`, `volume`, `range` (h−l)/c, `funding` (daily sum of hourly rates), `premium` (daily mean), `oi` (`hl.oi.<COIN>`, last per day) per asset; stored globals `fng`, `btc_dominance`, `total_mcap`, `stablecoin_cap`, `dvol`, every `fred.*` series present; `elfa_mentions`, `elfa_share` per asset | stored series only go back to when collection started. A last day of funding/premium without its 23:00 UTC settlement is left out (a partial day's sum is not the day's funding); earlier days are untouched. Without a database the provider keeps each coin's live settlements in process (60 coins) and later fetches only what it lacks |
| `cm` | Coin Metrics community API (keyless) `community-api.coinmetrics.io/v4/timeseries/asset-metrics` | `PriceUSD`, `CapMrktCurUSD`, `CapMVRVCur`, `AdrActCnt`, `TxCnt`, `TxTfrCnt`, `HashRate`, `FeeTotNtv`, `SplyCur`, `IssTotNtv`, `NVTAdj`, `TxTfrValAdjUSD` per asset (btc, eth, …); `lagDays` 1 | the stand-in for Glassnode on-chain data. A metric the community tier refuses is dropped with a warning |
| `fng` | alternative.me `/fng/?limit=0` (keyless, 2018→) | `value` (global) | |
| `llama` | DefiLlama keyless: `stablecoins.llama.fi/stablecoincharts/all`, `api.llama.fi/v2/historicalChainTvl` | `stablecoin_cap`, `defi_tvl` (global) | |
| `okx` | OKX keyless `rubik/stat/contracts/open-interest-history`, `period=1Dutc` | `oi` (asset): USD open interest of `<COIN>-USDT-SWAP`, Feb 2024 → | OKX's market, standing in for positioning (Hyperliquid has no public OI history; `ht:oi` is the collector's snapshots). The bar stamped day D holds D's last 5-minute snapshot, so `lagDays` 0; the running day is left out. 100 bars a request, 450 ms apart. `kPEPE`-style coins map to the token's swap (USD OI does not depend on the unit); `kNEIRO` and 1000-prefixed names are not mapped; a coin OKX does not list (its `51001`) is an empty series; an empty code-0 answer or a non-200 is an outage (an error, retried), never "no data". Matched by ticker: a different token trading under the same ticker on OKX would read that token's OI, and nothing here can tell. Collected (`lab-collect`, `lab.okx.oi.<coin>`) for the definition scan's coins (the Lab's default universe plus the watchlist): pages oldest first in 100-day windows from Feb 2024 (a budget cut resumes), and refetched as soon as the stored series lacks yesterday (`dailyClose`), so with a database the scan and universe studies read it stored and top up only a stale tail; without a database it is fetched live. Base URL: `OKX_API_URL` (default `https://www.okx.com`). `stationary: false` |

**Price for labels** comes from `config.price` (default `ht:price`, falling
back to `cm:PriceUSD` if `ht` has no history for the asset).

A Glassnode adapter is deliberately not shipped (operator decision: no paid
key). The interface takes one in one file if that changes.

## Surfaces (one tool set, many clients)

All surfaces call the same tool registry (`src/server/lab/tools.ts`), so a
tool is defined once with one JSON schema and one handler.

| tool | does |
|---|---|
| `lab_list_providers` | providers, reachability notes |
| `lab_list_metrics` | metric catalogue (filter by provider, category, asset) |
| `lab_search` | run a heuristic search → run id + ranked rules |
| `lab_get_run` / `lab_list_runs` | stored runs |
| `lab_evaluate_rule` | score an explicit rule (any window, optional equity curve) |
| `lab_sensitivity` | parameter-sensitivity grid for a rule |
| `lab_catalogue_list` / `lab_catalogue_save` / `lab_catalogue_remove` | My Catalogue |
| `lab_catalogue_health` | decay, overlap, gaps |
| `lab_market_pulse` | which catalogued rules fire now, per-asset lean |

**Tool contract** (args → result; shapes from `src/server/lab/types.ts` and
`src/server/lab/store.ts`). Every client, including the UI, depends on this.

| tool | args | result |
|---|---|---|
| `lab_list_providers` | `{}` | `{ providers: [{ id, name, notes, metrics: number }] }` |
| `lab_list_metrics` | `{ provider?, category?, asset? }` | `{ metrics: MetricDef[] }` |
| `lab_search` | `SearchConfigInput` | `{ runId: string \| null, result: SearchResult }` |
| `lab_get_run` | `{ id }` | `StoredRun` |
| `lab_list_runs` | `{ limit? = 20 }` | `{ runs: RunSummary[] }` |
| `lab_evaluate_rule` | `{ rule: Rule, from?, to?, slippageBps? = 10, includeEquity? = false, sensitivity? = false, windows?, trials? = 1 }` | `RuleEvaluation` |
| `lab_sensitivity` | `{ rule: Rule, windows?, slippageBps? }` | `Sensitivity` |
| `lab_catalogue_list` | `{ asset?, direction?, live? = true }` | `{ entries: Array<CatalogueEntry & { live: PerfStats \| null; flags: Array<"decayed" \| "overlap"> }> }` |
| `lab_catalogue_save` | `{ rule: Rule, name, note?, runId?, origin? = "user" }` (`runId` required for origin `"agent"` and over MCP) | `CatalogueEntry` |
| `lab_catalogue_remove` | `{ id }` | `{ removed: boolean }` |
| `lab_catalogue_health` | `{}` | `CatalogueHealth` |
| `lab_market_pulse` | `{ asset? }` | `MarketPulse` |

The rule id is `RuleEvaluation.id` (a stable hash of the rule), so the same rule
has the same id in a run, in the catalogue and in a URL.

- **REST**: `GET /api/lab/tools` (definitions), `POST /api/lab/tools/:name`
  (JSON args → `{ ok: true, result }` or `{ ok: false, error, field? }`, 400 on
  bad args or a refused search, 502 when upstream data is unavailable).
- **MCP over HTTP**: `POST /api/mcp`, stateless Streamable HTTP (JSON
  responses, no SSE; `GET` → 405). Methods: `initialize` (with `instructions`
  describing the research loop), `ping`, `tools/list`, `tools/call`,
  `prompts/list`, `prompts/get` (prompt `autoresearch`), and notifications
  (202). Hand-rolled JSON-RPC: no SDK dependency for four methods. Batches
  are refused for clients declaring `MCP-Protocol-Version` 2025-06-18+ (which
  removed them); older clients may send up to 8, run one at a time. A browser
  `Origin` must be `APP_URL`, one of `LAB_ALLOWED_ORIGINS` or localhost;
  requests without one (non-browser clients) pass. Unexpected tool failures
  reach the model as "Internal error" and are logged.
- **MCP over stdio**: `bun run lab:mcp`. With `LAB_URL` set, it proxies to a
  deployed instance. Without it, the engine runs in-process against local env
  (DB if `DATABASE_URL` is set, otherwise keyless providers plus live
  Hyperliquid, and a JSON-file store at `~/.hypertrade/lab.json`).
- **CLI**: `bun run lab <tool> [--arg value ...] [--json '{...}']`, with
  `bun run lab tools` to list. Same remote/local switch as stdio.
- **UI**: `/lab` (docs/design/README.md §10.9): search form → signal cards, rule detail
  with equity curve and sensitivity, catalogue with health flags, Market Pulse.

**Auth.** `/api/lab/*` and `/api/mcp` accept the session cookie *or*
`Authorization: Bearer <token>` where the token is one of the comma-separated
`LAB_API_TOKEN` values (constant-time compare), any HTTP method. The same
bearer also opens `GET /api/metrics/*`, `GET /api/sectors` and
`GET /api/marketstate*` (read-only; a write to any of those still needs the
session cookie). It grants nothing on any other path.

**Bounds.** A search on Vercel runs under a deadline (`LAB_SEARCH_DEADLINE_MS`,
default 50 000, inside the function's `maxDuration` of 60 s) and returns what
it has, with `trialsRun < trials` and a warning. Trials stop 5 s before the
deadline to leave room for the refit, and the ht candle backfill is capped at
4 s. Hard caps: `trials` ≤ 200, metrics ≤ 40, features ≤ 600, history ≥ 365
days of price, or the search is refused with a clear error (400, not stored
as a run). Locally (CLI or stdio) there is no deadline unless one is set.

## Persistence

`db/migrations/004_lab.sql`: `lab_runs` (config, result, status, source,
duration) and `lab_rules` (the catalogue: rule json, evaluation at save,
name, note, origin, saved_at, archived_at). `LabStore` has three
implementations: Postgres (deployed), in-memory (no DB), and JSON file
(local CLI/stdio).

## Done means

- `bun test src` green, including planted-signal tests: synthetic data where a
  known two-condition rule drives returns, and the search recovers it (same
  features, thresholds within tolerance; a's pctile(30) counts as the same
  zone only when its in-zone days overlap z(30) < −1 with Jaccard ≥ 0.7,
  asserted in the test) with a `robust` verdict, while on pure-noise data,
  on a flat price and on one drifting at a buy-and-hold Sharpe of ≈ 1 and
  ≈ 2, the save bar (`robust`: walk-forward Sharpe > 1 and holdout Sharpe
  > 0 and tested, both also in excess of the exposure-matched benchmark,
  stability ≥ 0.5, deflatedSharpe ≥ 0.9 against `effectiveTrials`)
  passes some top-10 rule in at most 1 of 10 fresh seeds (the validation
  tests; the calibration itself is `bun src/server/lab/engine/calibrate.ts`);
  and replacing the holdout with noise leaves the rules and every
  search-region number, `effectiveTrials` included, unchanged.
- `bun run typecheck` and `bun run build` green.
- `POST /api/mcp` answers `initialize`, `tools/list` and `tools/call` per the
  MCP 2025-06-18 schema. `bun run lab tools` and
  `bun run lab lab_list_metrics` work locally.
- `/lab` renders every state in docs/design/README.md §6 (loading, empty, error, stale).
