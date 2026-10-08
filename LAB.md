# LAB — heuristic research engine (Alpha Lab equivalent)

Hypertrade's answer to Glassnode Alpha Lab (research.glassnode.com/glassnode-alpha-lab,
Sep 2026): search a metric universe for **simple, human-readable trading
heuristics** ("when feature A < x and feature B ≥ y, go long BTC"), score them as
strategies net of slippage, validate them out of sample, keep the good ones in
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
   data ≤ t. Each metric carries `lagDays` (publication lag; on-chain data
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
   class 1 is a rule of one or two conditions. A path's single-condition
   prefixes are kept as rules too, so a pair can be read whole or split into
   single-metric rules. Each rule is judged on **precision** (share of in-zone
   days labelled good) and **support** (in-zone days); rules below `minSupport`
   are dropped and duplicates merged. A candidate must also trade: in the
   market on `minExposure`–`maxExposure` of the training days (default
   5–95%) and entering at least max(3, `minTradesPerYear` × years) trades
   (default 0.5 a year); otherwise it is not scored.
6. **Strategy scoring.** A rule is a daily signal: in zone at the close of day
   t means position +1 (long) or −1 (short) over day t+1, else flat. Cost =
   `slippageBps` × |position change|. Reported per window: total return,
   CAGR, Sharpe (daily mean / stdev × √365), max drawdown, hit rate (share of
   closed trades, i.e. contiguous in-zone episodes, with positive net
   return), trades per year, exposure (share of days in market), and an equity
   curve on request. A buy-and-hold benchmark (or short-and-hold for short)
   is reported for the same windows. All numbers are net of slippage. A
   window with no trade is flagged `untested` (its Sharpe 0 is not a result).
7. **Validation, three stages.**
   - *Holdout:* the most recent 20% of history is cut off before the search
     and used only to evaluate final rules. Never used for ranking.
   - *Walk-forward:* the search region (first 80%) is split chronologically
     into `folds + 1` blocks; fold i trains on blocks 0..i and tests on block
     i+1. Training sets are **purged** of their last `horizonDays` days, whose
     labels look into the test block. Trials are scored on concatenated test
     blocks. For each final rule the walk-forward stat refits the rule per
     fold by **quantile matching**: same features and operators, threshold =
     the same train-set quantile the final threshold sits at. This is a
     *threshold refit*: the rule's structure (features, operators) was chosen
     on the whole search region, so a final rule's walk-forward stat is not
     fully out of sample. The trial score, which regrows forests per fold, is.
   - *Live:* once catalogued, a rule is evaluated on data after `savedAt`,
     which could not have influenced its selection.
   Final rules are ranked by walk-forward objective (support-filtered), never by
   holdout. Each also reports `walkForwardFolds` (the Sharpe of every test
   block, never ranked on) and `deflatedSharpe` (Bailey & López de Prado):
   the probability that the concatenated walk-forward returns' daily Sharpe,
   corrected for their skew and kurtosis, beats the expected best of N noise
   strategies, with the null variance of a Sharpe 1/(T − 1). N is
   `effectiveTrials`, not the raw `variantsScored` (see *Effective trials*
   below). It is a reported field, an optional filter (`minDeflatedSharpe`)
   and part of the verdict. An explicit rule (`lab_evaluate_rule`) gets the
   same walk-forward, refitting its thresholds per fold by quantile matching
   (its own thresholds stay canonical, so its id does not change), with
   N = `trials` (default 1: not deflated for any search; pass the run's
   `effectiveTrials`).
   The final list keeps one rule per family: best walk-forward first, a rule
   whose in-zone days over the search region overlap a kept rule's with
   Jaccard ≥ 0.8 is dropped, and no single condition anchors more than two
   rules. Holdout days never enter this comparison.

   *Effective trials.* A search scores thousands of distinct rule variants
   (`variantsScored`, 2,100–5,000 at 16 trials on the synthetic tests,
   4,100–11,600 at 40), but most are threshold neighbours and family members
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
   `effectiveTrials`: 92–181 at 16 trials, 132–234 at 40. A participation
   ratio (Σλ)²/Σλ² was tried and rejected: cluster sizes are heavy-tailed
   (one family often holds a third of all variants), and the ratio, in effect
   a Simpson index of cluster shares, came out at 6–7 for searches with
   100+ distinct clusters. Above 20,000 variants a seeded sample of 20,000 is
   clustered and the count scaled by N / 20,000.

   *Verdict.* Every evaluation carries `verdict { level, reasons }`; the
   first failing check sets the level, `reasons` names every failed check
   with its numbers (e.g. "deflated Sharpe 0.71 < 0.9"):
   `fails_holdout` (holdout missing, untested or Sharpe ≤ 0) → `weak`
   (walk-forward missing or Sharpe ≤ 1) → `fragile` (stability < 0.5, when a
   sensitivity grid is attached) → `candidate` (deflated Sharpe missing or
   < 0.9) → `robust`. **The save bar is `robust`.** A `candidate` may be
   saved only with a note explaining why. The search can return only rules at
   or above `minVerdict`; it filters the selected top K after the fact and
   never reaches deeper candidates, so the holdout still selects nothing.
   Catalogue entries and runs stored before verdicts existed get one
   computed on read (their stored deflated Sharpe used raw N, so they lean
   `candidate`). A catalogue save with a `runId` keeps the run's walk-forward,
   `walkForwardFolds` and deflated Sharpe (the numbers the rule was selected
   on, deflated by the run's `effectiveTrials`), evaluates the rest fresh with
   N = the run's `effectiveTrials`, and recomputes the verdict.

   *Calibration* (`engine/calibrate.ts`; `bun src/server/lab/engine/calibrate.ts
   [trials]` reprints it). Synthetic data, 2,500 days: 40 pure-noise seeds
   and 20 planted seeds at each of two strengths (next-day drift 0.012 and
   0.008 while z(a, 30) < −1 and b ≥ 0, daily noise 0.02). For each
   deflated-Sharpe cut-off, the full bar is applied to the top 10 rules;
   "planted rule robust" counts searches whose top 10 holds the planted rule
   and it is `robust` ("found" = in the top 10 at all).

   16 trials (the test configuration):

   | DSR ≥ | noise: any top-10 robust | noise: top-1 robust | drift 0.012: planted rule robust | drift 0.012: any top-10 robust | drift 0.008: planted rule robust | drift 0.008: any top-10 robust |
   |---|---|---|---|---|---|---|
   | (none) | 14/40 | 5/40 | 17/20 (found 17) | 20/20 | 12/20 (found 12) | 20/20 |
   | 0.50 | 3/40 | 2/40 | 17/20 (found 17) | 20/20 | 10/20 (found 12) | 19/20 |
   | 0.80 | 1/40 | 0/40 | 17/20 (found 17) | 20/20 | 10/20 (found 12) | 15/20 |
   | **0.90** | **1/40** | **0/40** | **17/20 (found 17)** | **20/20** | **10/20 (found 12)** | **15/20** |
   | 0.95 | 0/40 | 0/40 | 16/20 (found 17) | 19/20 | 9/20 (found 12) | 13/20 |

   40 trials (the tool default):

   | DSR ≥ | noise: any top-10 robust | noise: top-1 robust | drift 0.012: planted rule robust | drift 0.012: any top-10 robust | drift 0.008: planted rule robust | drift 0.008: any top-10 robust |
   |---|---|---|---|---|---|---|
   | (none) | 13/40 | 7/40 | 17/20 (found 17) | 20/20 | 11/20 (found 11) | 20/20 |
   | 0.50 | 3/40 | 2/40 | 17/20 (found 17) | 20/20 | 10/20 (found 11) | 19/20 |
   | 0.80 | 1/40 | 0/40 | 17/20 (found 17) | 20/20 | 9/20 (found 11) | 14/20 |
   | **0.90** | **0/40** | **0/40** | **17/20 (found 17)** | **20/20** | **8/20 (found 11)** | **13/20** |
   | 0.95 | 0/40 | 0/40 | 17/20 (found 17) | 20/20 | 5/20 (found 11) | 11/20 |

   Rule: the cut-off keeps noise searches with any robust top-10 rule at
   ≤ 1 in 20 and, among those that do, keeps the most planted rules robust
   (ties to the stricter). At 16 trials 0.8 and 0.9 tie and 0.9 is chosen;
   at 40 trials the rule alone would pick 0.8, by one weak-drift seed in 20.
   **`MIN_DEFLATED_SHARPE` = 0.9** (`engine/verdict.ts`): it meets the noise
   limit at both budgets (1/40 and 0/40, against 1/40 and 1/40 for 0.8) and
   keeps every found strong planted rule. 0.95 gives up more weak planted rules
   for no measurable noise gain. Without the deflated Sharpe the rest of the
   bar passes some top-10 rule in a third of noise searches. Every found
   planted rule passes the rest of the bar; the ones lost at 0.9 (2 of 12 at
   0.008 drift and 16 trials, 3 of 11 at 40) fail only the deflated Sharpe: a
   0.008 edge over 2,500 days is near what the bar can tell from the best of
   ~150 noise clusters. The engine test re-runs this on 20
   noise and 12 planted seeds per strength and asserts the rule still picks
   `MIN_DEFLATED_SHARPE`.

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
| `ht` | hypertrade Postgres (`candles`, `funding`, `observations`) with live Hyperliquid fallback for price/funding when the DB is absent | `price`, `volume`, `range` (h−l)/c, `funding` (daily sum of hourly rates), `premium` (daily mean), `oi` (`hl.oi.<COIN>`, last per day) per asset; stored globals `fng`, `btc_dominance`, `total_mcap`, `stablecoin_cap`, `dvol`, every `fred.*` series present; `elfa_mentions`, `elfa_share` per asset | stored series only go back to when collection started |
| `cm` | Coin Metrics community API (keyless) `community-api.coinmetrics.io/v4/timeseries/asset-metrics` | `PriceUSD`, `CapMrktCurUSD`, `CapMVRVCur`, `AdrActCnt`, `TxCnt`, `TxTfrCnt`, `HashRate`, `FeeTotNtv`, `SplyCur`, `IssTotNtv`, `NVTAdj`, `TxTfrValAdjUSD` per asset (btc, eth, …); `lagDays` 1 | the stand-in for Glassnode on-chain data. A metric the community tier refuses is dropped with a warning |
| `fng` | alternative.me `/fng/?limit=0` (keyless, 2018→) | `value` (global) | |
| `llama` | DefiLlama keyless: `stablecoins.llama.fi/stablecoincharts/all`, `api.llama.fi/v2/historicalChainTvl` | `stablecoin_cap`, `defi_tvl` (global) | |

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
| `lab_catalogue_save` | `{ rule: Rule, name, note?, runId?, origin? = "user" }` | `CatalogueEntry` |
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
- **UI**: `/lab` (DESIGN.md §10.9): search form → signal cards, rule detail
  with equity curve and sensitivity, catalogue with health flags, Market Pulse.

**Auth.** `/api/lab/*` and `/api/mcp` accept the session cookie *or*
`Authorization: Bearer <token>` where the token is one of the comma-separated
`LAB_API_TOKEN` values (constant-time compare). The bearer token grants
nothing outside those two paths.

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
  asserted in the test) with a `robust` verdict, while on pure-noise data
  the save bar (`robust`: walk-forward Sharpe > 1, holdout Sharpe > 0 and
  tested, stability ≥ 0.5, deflatedSharpe ≥ 0.9 against `effectiveTrials`)
  passes some top-10 rule in at most 1 of 20 seeds (the calibration test);
  and replacing the holdout with noise leaves the rules and every
  search-region number, `effectiveTrials` included, unchanged.
- `bun run typecheck` and `bun run build` green.
- `POST /api/mcp` answers `initialize`, `tools/list` and `tools/call` per the
  MCP 2025-06-18 schema. `bun run lab tools` and
  `bun run lab lab_list_metrics` work locally.
- `/lab` renders every state in DESIGN.md §6 (loading, empty, error, stale).
