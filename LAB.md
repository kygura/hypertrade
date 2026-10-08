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
   good = forward return ≥ the `labelQuantile` upper quantile of the search
   region *and* > 0. Short: ≤ the lower quantile *and* < 0. Default quantile
   0.3. `customZones` (date ranges) replace this: days inside a zone are 1.
3. **Feature expansion.** Each metric is expanded into transformed versions:
   `raw`, `z` (rolling z-score), `rsi`, `ma_ratio` (value / SMA − 1), `roc`
   (rate of change), `vol` (rolling stdev of log changes), `pctile` (rolling
   percentile rank 0–1), each at every window in `windows` (default
   `[7, 30, 90]`; `raw` has no window). Every transform at day t uses only
   data ≤ t. Each metric carries `lagDays` (publication lag; on-chain data
   lands a day late) and is shifted by it before anything else happens.
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
   are dropped and duplicates merged.
6. **Strategy scoring.** A rule is a daily signal: in zone at the close of day
   t means position +1 (long) or −1 (short) over day t+1, else flat. Cost =
   `slippageBps` × |position change|. Reported per window: total return,
   CAGR, Sharpe (daily mean / stdev × √365), max drawdown, hit rate (share of
   closed trades, i.e. contiguous in-zone episodes, with positive net
   return), trades per year, exposure (share of days in market), and an equity
   curve on request. A buy-and-hold benchmark (or short-and-hold for short)
   is reported for the same windows. All numbers are net of slippage.
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
   holdout.
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
| `lab_evaluate_rule` | `{ rule: Rule, from?, to?, slippageBps? = 10, includeEquity? = false, sensitivity? = false, windows? }` | `RuleEvaluation` |
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
  features, thresholds within tolerance) with positive holdout Sharpe, while
  pure-noise data yields no rule that passes `minSupport` and positive
  walk-forward plus holdout Sharpe in more than a small share of seeds.
- `bun run typecheck` and `bun run build` green.
- `POST /api/mcp` answers `initialize`, `tools/list` and `tools/call` per the
  MCP 2025-06-18 schema. `bun run lab tools` and
  `bun run lab lab_list_metrics` work locally.
- `/lab` renders every state in DESIGN.md §6 (loading, empty, error, stale).
