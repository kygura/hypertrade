# Research terminal — contract

Status: done (2026-11-09). This file is the contract for the research-terminal
refactor. `docs/SPEC.md` wins on data and API shape for everything not named here;
`docs/design/README.md` wins on tokens, states and primitives.

## Goal

Hypertrade is a **research terminal** for Hyperliquid perps. Its one job: when something
is happening on a market now, show what happened historically when the same condition
fired, with honest statistics, in one click. The trading surface (feed, order, desk) stays
and stays thin; it is no longer the landing.

Every live signal is shown as a fact with its evidence (n, clusters, interval, verdict),
never as a verdict of its own. Nothing nags.

## What changes

1. The landing `/` is the **Research board**: live signals, each with a Lab rule and its
   event-study evidence. The old Cockpit feed moves to `/feed` (TRADE family, tab FEED).
2. The Lab gains an **event study view** (`/lab/study`) that any signal can open prefilled.
   Until now `lab_event_study` had no UI.
3. Live signals from four sources are normalised into one shape with a Lab rule attached
   where one exists.
4. Signal arithmetic that was copied across subsystems lives in one shared module.
5. The radar's notes, calls and scorecard become readable in the app.
6. The Cockpit stops offering an APPROVE that cannot succeed.

## Runtime

Built for the always-on server (`bun start`, `WORKER_LOOPS=all`). On Vercel (tick mode)
the board still renders: sources that need a loop or Postgres report `unavailable` with a
reason, studies run on demand inside the 50 s tool deadline (without a database only a one- or
two-coin study fits: funding history is rate-limited to about one coin a minute), and approve is disabled with
the reason shown before the dialog opens. The `definition` source runs without a database too, in the background
(S2 below); on Vercel a function instance rarely lives long enough to finish it.

## Backend

### B1. `src/shared/signalMath.ts`

Dependency-free. Holds the one implementation of: `atr` (simple mean of true range),
`fundingAprPct(hourly)` and `fundingAprFrac(hourly)`, `median`, `mad`, `quantile`, and the
z-score variants as **named** functions (`zSample`, `zSampleExcludingLast`, `zPopulation`,
`zRobust`). Call sites move to it. **No numeric behaviour changes**: each call site keeps
the variant it uses today, and every existing test stays green without edits to expected
values. A table-driven test pins each function.

The z variants are not merged. They answer different questions on different windows; the
module makes the choice visible at the call site instead of hiding it in a local helper.

### B2. Signals and studies — `src/shared/research.ts`, `src/server/research/`

`ResearchSignal` (zod):

```
id          stable string: `${source}:${coin}:${key}`
source      'novelty' | 'rule' | 'opportunity' | 'radar'
coin        string
direction   'long' | 'short' | null
headline    string, facts only (e.g. "funding z90 +2.4, 7d ret -12%")
at          ms epoch
rule        Lab Rule | null     the condition as a Lab rule, when one maps
ruleText    string | null
href        string | null       drill-in for the source's own object
tested      'long' | 'short' | null   the side the rule tests (novelty: its fade side;
                                      a fact about the study, never a recommendation)
scope       'coin' | 'universe'   the study runs on this coin, or on the Lab's top-N
evidence    StudySummary | null cached study, when present
```

`StudySummary`: `{ verdict: 'clear'|'rejected'|'insufficient', events, weeks, expectancy,
upper95, holdoutExpectancy|null, idea: {n, of}|null, asOf }` — a projection of the
`lab_event_study` result, no new statistics.

Mapping (pure, tested): a catalogue rule firing now carries its own rule; a novelty item
maps through a fixed table (`funding_z90` → `ht:funding|z|90`, 7 d return →
`ht:price|roc|7`, volume multiple → `ht:volume|ma_ratio|20`) using the item's observed
value sign and a rounded threshold; platform opportunities and radar calls carry
`rule: null` (superseded by Signals v2 S3 below: an opportunity now carries the daily definition of its setup kind
when one matches its side, with its ledger record as evidence; a radar call stays rule-less and carries its
scorecard row).

Routes (all zod-parsed in and out):

- `GET /api/research/board` → `{ asOf, signals: ResearchSignal[], sources: Record<source,
  {state: 'ok'|'unavailable', reason?: one of a fixed set, count, dropped}>,
  pulse: {assets, firing} | null }`. Each source is loaded independently; one failing
  source never empties the board. For a PUBLIC_MODE guest the radar source is
  `unavailable` ("sign in required") and contributes no signals, as `/api/radar` does.
- `POST /api/research/study` `{ rule, coin?, stopAtr, targetAtr }` →
  `{ studyId, cached, summary: StudySummary, study, catalogueId }`. The board sends `boardStudy(signal)`
  (`src/shared/research.ts`: `coin` only for `coin` scope, the default 1.5 / 3 ATR exits),
  the same body the board looks its evidence up under. Runs `lab_event_study` through the
  existing Lab tool and counts as a trial exactly as a direct tool call does. Results are
  cached by rule, scope, exits (to 0.1 ATR) and UTC day: an in-process map (200 entries) in
  front of the Lab store's `research_studies` rows (memory, Postgres or the JSON file, pruned
  after 2 days: only today's are ever read), so a restart keeps today's evidence and does not
  log a second trial. Store reads wait at most 3 s (`STUDY_STORE_TIMEOUT_MS`), then count as a
  miss; the write runs in the background after the answer. A slow or failing store falls back
  to the in-process map and never holds a study. A study the deadline cut short (a coin's reason
  "not loaded before the deadline") is answered but neither cached nor stored: it is not the day's
  study, so the next ask runs it again, and that run is a trial too (the Lab records one per
  `lab_event_study` call; with OI collected these cuts are rare). `catalogueId` is the rule's catalogue id when
  it is saved (looked up on every answer, never cached, null after the same 3 s), else null;
  `lab_event_study` returns it too.
- `GET /api/radar` → `{ state, latestNote: {date, markdown, truncated}|null, calls,
  scorecard }` read from `data/radar/` with the existing schemas (at most 50 calls). Needs a
  signed-in session (not guest-readable in PUBLIC_MODE). If the files are absent (Vercel
  bundle), `state: 'unavailable'` with the reason.

Studies run on request only: evidence is on the board once someone ran that study today
(cached, and kept across restarts in the Lab store), and every run counts as a trial. The
board reads the store once per build for all its signals, never once per signal, after the
sources and bounded by the same 3 s, so a stalled store adds at most that to a build. Nothing
pre-computes them.

### B3. Approve honesty

`GET /api/platform/opportunities/:id` (the detail the Cockpit already polls) exposes
`canApprove: boolean` and `approveBlockedReason: string | null`: the P0.15 freshness gate
(the server's own mid age and scan age) evaluated now by `approveBlock` in
`src/server/platform/context.ts`, the same function that makes approve answer 409
`stale_feed`, so the two cannot drift. The Cockpit disables APPROVE from that, with the
reason shown before any dialog opens, and also while the browser's own live price is
stale (the StaleStrip).

### B4. Dead code and gates

CI runs `check:type-scale`. The board pipeline deletion stays on its date in
`docs/TASKS.md`. `lab/engine/calibrate.ts` and `scripts/desk-worker.ts` were audited as
dead and are not: the first calibrates the save-bar cut-off (`docs/LAB.md`), the second
builds the desk service for `scripts/server.ts`. Both stay.

Not changed here, recorded in `docs/TASKS.md`: scanner funding windows (24 h in code,
7 d/14 d in SPEC P0.9), the desk regime classifier used on a 1 h return, the five
"my coins" lists, the duplicate migration number 022. Each alters live scanner output or
applied migrations and needs its own event-study-backed change.

## UI — design brief

Tokens, themes, primitives and state ladders are unchanged (`docs/design/README.md` §2,
§6, §11). Only layout and information architecture change.

### Nav

Five cells, RESEARCH first: **RESEARCH** (landing) · TRADE · MARKET · ASK · ENGINE.
RESEARCH tabs, in workflow order: BOARD `/` · STUDY `/lab/study` · SEARCH · RUNS ·
CATALOGUE · PULSE · BRANCHES. TRADE tabs keep their order with FEED at `/feed`.
`/?review=1` keeps redirecting to `/terminal?review=1`; any old `/?…` opportunity query
redirects to `/feed` with the query intact.

### Board (`/`)

One question per region, top to bottom on mobile, two columns from `lg`:

- **Header line**: `asOf`, one chip per source with its count or `unavailable` (title =
  reason). No KILL button here.
- **Signals (main column)**: a dense list, newest first, grouped by coin when a coin has
  more than one signal. Each row: coin, source badge, direction, headline facts, age, and
  the **evidence cell**. The evidence cell is the hierarchy anchor of the screen:
  - cached study (someone ran it today): verdict badge + `tested <side> · <this coin |
    top-20 universe> · n events · weeks · expectancy (≤ upper95)`; the tested side is a
    fact about the study, never advice, and a universe study never reads as the coin's
    own history. The row also shows the rule text;
  - rule but no study yet: a `STUDY` button that runs it in place (row shows progress,
    then the result; failure shows the error in the cell, row stays). It runs a trial,
    and says so in its title. A guest (PUBLIC_MODE) gets `LOGIN TO STUDY` instead of a
    POST that would bounce off a 401;
  - no rule: what backs the row instead (Signals v2 S3/S4): an opportunity's ledger record
    (`live record · n · clusters · mean net % [lo, hi] · 24h`), a radar call's scorecard row
    (`graded forward · n calls · mean vs BTC · hit %`), or, with neither yet, a muted factual
    line (`no record yet`, `no graded calls yet`).
  Row click or Enter opens `/lab/study?rule=…&coin=…` (`coin` only for `coin` scope; a
  `universe` signal opens the study's default top-N universe). `?coin=X` filters the list. Secondary links on the row: source
  drill (`href`), `/asset/:coin`. Keyboard: j/k move, Enter open, s study in place.
- **Source note**: an `ok` source's `note` (e.g. why the scanner is silent) is a visible line under the chips
  (`SETUP: …`, with a `*` on the chip and the note in its title), never hover-only.
- **Side column**: PULSE summary (assets with rules firing, link to `/lab/pulse`), then
  RADAR (latest note date, calls with stance and kill price, scorecard n/mean/hit per
  horizon, link to the full note in a dialog as preformatted text). The radar needs a
  session: a guest sees the sign-in affordance. The board renders the Lab tab row without
  the Lab data provider, so the landing starts no catalogue or pulse load; the PULSE dot
  reads the board's own counts.
- States: `AsyncBody` ladder per region. Empty board copy states which sources are on and
  that no condition is firing; it is not an error.

Verdict colours reuse existing semantic tokens: clear = positive, rejected = negative,
insufficient = muted. Verdict is always text plus colour, never colour alone.

### Study (`/lab/study`)

Input: `?rule=` (URL-encoded JSON, zod-parsed; a bad value shows an error block and the
empty form) and optional `?coin=`; universe control (this coin · top N · my markets).
Without a rule: a short empty state linking to SEARCH and CATALOGUE. Exits: STOP and TARGET in
ATR (step 0.1, the route's bounds), in the URL as `?stop=&target=` (omitted at the 1.5 / 3
defaults) so a study link reproduces it. Editing them never runs a study: RUN does (each run is
a trial); a first load with a rule runs as before. The board keeps the defaults. The canonical
universes (this coin, or the default top 20) run through `POST /api/research/study`
(`studyRoute`, `src/ui/lib/study.ts`) with any exits, so opening a row with evidence reuses the
cached study instead of logging a new trial, and a default-exit run here shows on the board.
Other universes (another top N, my markets) call `lab_event_study` directly.

Under the DEFINITIONS picker (and below the study when a rule is open) sits **INTRADAY SETUPS · REPLAY**
(`GET /api/research/setups/replay?source=candles`, loaded only on this page, polled every 25 s while `pending`):
rows kind × side at a horizon toggle (default 24h) with entries, n, clusters, mean net with its interval and hit
rate; an unevaluable row is dimmed with its reason, a null number is an em dash with why; a link to the daily
definition on the same side; a footnote with window, coins, grid and (collapsible) assumptions. Facts only, labelled
as a replay of fixed predicates, not a trial.

Output, in this order: rule text; verdict with the screen line (events, weeks,
expectancy, upper95); train vs holdout; the condition funnel; per-coin table (`DataTable`);
event list (first 200 of `eventListTotal`); survivorship note; `idea n of N`.
Actions: OPEN RULE (rule drill with equity and sensitivity), SAVE (existing catalogue
form; the save-bar verdict still applies). A rule already in the catalogue (the study's
`catalogueId`) shows `IN CATALOGUE →` to `/lab/rules/:id` instead of SAVE; so does the ad-hoc
rule drill (`/lab/rules/study?rule=…`), matching its evaluation id against the catalogue.

### Other surfaces

- `/lab/rules/:id` gets a STUDY link.
- Lab search form ships with a default metric preset so RUN works without picking metrics.
- The Lab data provider stops loading the pulse on every Lab route; PULSE and the tab dot
  load it lazily.
- Cockpit detail and `/asset/:coin` link to the board filtered by coin (`/?coin=X`).

## Done

`bun run typecheck`, `bun test ./src`, `bun run check:api`, `bun run check:type-scale`,
`bun run build` green. `GET /api/research/board` and `GET /api/radar` answer on a server
with no `DATABASE_URL`. The board renders at 320 px and 1440 px with no horizontal scroll,
and a rule-bearing signal opens a prefilled study.

## Signals v2 — one definition, two evaluators

Status: done (2026-11-10): S1–S4 shipped, review fixes applied. Follow-ups shipped 2026-11-11: rules up to four
conditions, the `vchg` transform, `okx:oi`, the dropped thesis parts restored where the Lab can say them,
`range_breakdown`, the scan without a database, partial funding days, `bun run signals:scan` / `signals:study`, and S5 (intraday setup replay).
Phases 1–2 of the candidate pipeline (`docs/research/candidates-redesign.md` § B.3, B.4), cut to what the Lab can
replay today.

Problem: four engines each defined "signal" their own way (scanner setups, novelty, Lab rules,
radar calls), and only Lab rules could be replayed. Rows on the board said `no Lab twin`.

Rule: **a signal is a Lab `Rule` written as data.** The same rule object is evaluated live (is
it in zone on the latest daily bar?) and historically (`lab_event_study`), through the same
engine functions. Nothing else is called a signal definition.

### S1. Definitions — `src/server/signals/definitions.ts`

A code-shipped list of `SignalDefinition`: `{ id, name, thesis (one line, facts), rule:
Omit<Rule, 'asset'>, intradayKinds: string[] }`. Each `rule` parses with the Lab `RuleSchema`
once an asset is filled in, reads `ht:price`, `ht:volume` and `ht:funding` (every perp has them) and, for OI,
`okx:oi` (below: Hyperliquid has no OI history), plus the regime condition and `stop`/`target`/`invalidation` levels, and its
thresholds are starting points for the event study, not claims. v1 set, from § B.4 where the
features exist: `funding_fade` (short), `negative_funding_build` (long), `washout_reclaim`
(long), `trend_pullback` (long in an up-trend; short twin in a down-trend if the Rule shape
needs two entries), `range_breakout`. A definition whose predicate the Lab cannot express is
left out and listed in `docs/TASKS.md`, not approximated silently.

Shipped (thresholds are starting points; each rule's comment in the file names what B.4 asked that it drops). A rule
holds up to four conditions (`MAX_CONDITIONS`; the search still produces at most two). `vchg(w)` is the w-day log
change in w-day sigmas of the coin's own daily volatility (docs/LAB.md), standing in for B.4's ATR-scaled returns: a
w-day sigma is not ATR(14), so "1 ATR" in B.4 and "1 sigma" here are different cuts.

| id | side, hold | rule | dropped from B.4 |
|---|---|---|---|
| `funding_fade` | short 7d | `ht:funding z(90) ≥ 2 AND okx:oi pctile(30) ≥ 0.95 AND ht:price vchg(3)` in [−1, 1) | the 4 h trigger; `\|ret_3d\| < 1 ATR` is read in 3-day sigmas |
| `negative_funding_build` | long 7d | `ht:funding z(90) < −1.5 AND okx:oi roc(7) ≥ 0.1 AND ht:price vchg(7) ≥ −1` | the 4 h trigger; `ret_7d ≥ −1 ATR` is read in 7-day sigmas |
| `washout_reclaim` | long 7d, stop 2-bar low | `ht:price roc(3) < −0.08 AND okx:oi roc(3) < −0.1 AND ht:funding raw < 0` | the 4 h reclaim trigger, liquidation z (no metric); a 1-day return needs roc(1), below the minimum window, so the drop is 3 days in percent; OI from its 20-day peak is a 3-day change |
| `trend_pullback_long` / `_short` ("Trend at its 20-day mean") | long / short 10d | `ht:price ma_ratio(20)` in [−0.02, 0.02) `AND ht:funding z(90)` in [−1, 1) `AND trend ∈ {up}` / `{down}`: price at its 20-day mean in a trend, above it included, so not strictly a pullback (the id keeps the B.4 name) | distance in %, not ATR (no feature scales a distance to a mean by volatility) |
| `range_breakout` | long 7d | `ht:price pctile(20) ≥ 1 AND ht:volume ma_ratio(20) ≥ 0.5`; the 20-day mean includes the day, so volume ≥ about 1.54× the prior 19-day mean | breakout on closes, not highs (no rolling-max feature) |
| `range_breakdown` | short 7d | `ht:price pctile(20) < 0.01 AND ht:volume ma_ratio(20) ≥ 0.5`: pctile is 0 only below every other close in the window and its smallest other value is ½/19 ≈ 0.026 (½/9 at the fewest closes it accepts), so < 0.01 is exactly "below all 19 prior closes" | as `range_breakout` |

OI is `okx:oi`, the coin's OKX USDT-swap open interest, standing in for market positioning: Hyperliquid publishes no
OI history and `ht:oi` (collector snapshots) covers about six weeks for about 20 coins, too short for the study's 30
event-weeks. `ht:oi` can replace it once the collector has enough history. A coin OKX does not list has no OI
definitions. `okx:oi` is matched by ticker (docs/LAB.md): a different token trading under the same ticker on OKX would
read that token's OI. With a database `okx:oi` is collected daily (`lab-collect`, `lab.okx.oi.<coin>` for the scan's
coins: the Lab's default universe plus the watchlist), so the scan and universe studies read it stored and top up only a
stale tail live; without one it is fetched live. Stop/target levels are left to the study's exits except the washout's structural stop.
A definition's `rule` carries `asset: UNIVERSE_ASSET` (`"UNIVERSE"`, `src/shared/research.ts`), not a ticker: it is
studied over the universe without a `coin`, so every coin in zone shares one study, one cache key and one trial.

`intradayKinds` names the platform setup kinds (`src/server/platform/setups.ts`) that share the
thesis on the definition's side: `crowded_long → funding_fade`, `negative_funding_squeeze → negative_funding_build`,
`deleveraging_washout → washout_reclaim`, `vol_expansion_breakout` long → `range_breakout`, short →
`range_breakdown`. `definitionForKind(kind, side)` picks by side. A test asserts every platform setup kind is named by
exactly one definition per side it can take, and by none on a side it cannot.

### S2. Live evaluation — `src/server/signals/scan.ts`

Pure core: `(definition, LabDataset) → in zone on the last bar?`, built on the Lab engine's
own feature and zone code (`inZoneNow` calls `ruleFiresAt`: `makeCtx` → `zoneConditions` →
`conditionSignal`, the path `replayCoin` reads through `inZoneDays`), no second
predicate. A dataset without one of the definition's metrics is not evaluable (null), not out of zone. **Parity
test** (`scan.test.ts`): on a fixture coin, for every definition, the event study's entry days are exactly the days k
with `ATR_WINDOW ≤ k < n − horizon` on which the scan of the data truncated at k says in zone and the replay is flat
(k ≥ previous entry + horizon).

Service: evaluates every definition over the Lab's default universe (top 20) plus the UI
watchlist. It shares the Lab service's dataset loader (and the registry's per-metric fetch cache) but
loads its own 200-day window, so it does not share study cache entries; refreshed at most once per
closed daily bar; a coin whose data fails is dropped and counted, never fatal. Evaluating a
definition live is **not** a trial (no study runs).

Concrete: `createDefinitionScanner` loads per coin 200 days of price (`SCAN_LOOKBACK_DAYS`: the regime's 50-day mean
and its persistence) and of each condition metric only what its features read on the bar (`metricLookbackDays`:
`featureLookback` + 7 days for the registry's forward fill; about 100 days for funding z(90), 37 for OKX OI), through
the Lab service's `loadDataset` (registry cache), memoises one complete scan per UTC day (callers in flight share it;
a scan that dropped anything a later scan may evaluate is kept only 15 min after it finished, `SCAN_RETRY_MS`, so a
scan run before data reaches the bar is retried; drops a retry cannot change keep the scan for the day; a scan that
fails as a whole is forgotten; scans never overlap: one still running at 00:00 UTC finishes before the new day's
starts), drops for the day a coin Hyperliquid does not list (its universe, read once a scan: HL answers an unknown coin
with a 500, which would read as an outage), and drops a coin that fails, is not
loaded within the deadline (120 s, `SCAN_DEADLINE_MS`, with a database; 45 min without) or whose price does not reach
yesterday's bar. A definition is evaluated on a coin only when every metric its conditions read has a raw, not
forward-filled, value on the bar (the loader's `lastRaw`; the registry forward-fills up to 3 days); otherwise that
coin × definition is dropped with the metric's last complete day as the reason. A metric that loaded but has nothing
for the coin (`noData`: OKX answered 51001, it does not list the coin) drops its definitions without a retry; an OKX
outage (a non-200, or a code-0 answer with no rows) is a failed fetch, retried. Funding: the daily value
is the sum of the day's hourly settlements; the ht provider leaves out a last day without its 23:00 UTC settlement, so
a day still settling (or not yet stored) never reaches a rule as a sum: lastRaw ends the day before and the scan
drops and retries that coin × definition. History and event studies read every earlier day as before. Each drop
(coin, definition, reason, retry) is in the scan's `drops`; the board counts them in the source's `dropped`. A test
checks that the window (200 days of price, each metric from its own lookback) answers as the full history does for
every definition on the fixture. Watchlist = `watchedAssets` (intel_watchlist, else DESK_WATCHLIST).

With `DATABASE_URL` the board awaits the day's scan and bounds the wait with its source timeout, as every source. The
scan then reads stored history only (candles with the candle sync's short backfill, funding, collected `okx:oi`), so it
runs inline on Vercel too; a test runs it from stored-data deps with no live request. Until the collectors have stored
the bar (the collect workflow every 15 min, `okx:oi` refetched as soon as its stored series lacks yesterday; Vercel
Cron's daily 06:00 / 06:30 UTC runs are the fallback) the stored series end the day before it: those coin ×
definitions are dropped and retried, not read stale. Without a database on a serverless runtime (`VERCEL` set) the
source is `unavailable` ("needs a database or the always-on server; or run `bun run signals:scan`") and no scan is
started: a live scan outlasts the function, so every poll would start another. Without it the data is fetched live (price and volume: one Hyperliquid candle request a coin; funding: Hyperliquid's
hourly settlements under the weight guard, about five pages a coin on the first scan; OI: OKX, requests 450 ms apart),
which takes minutes, so the scan runs in the background (`boardDefinitionScan`, `src/server/signals/runtime.ts`): the
board never waits for it, reports `unavailable` "first scan in progress" until the first finishes, then serves the last
finished scan (its `bar` says which day) while a newer one runs. The ht provider keeps each coin's live settlements in
process, so later scans fetch only the settlements since the last one held.

`bun run signals:scan` runs the scan once with no deadline against whatever is configured and prints the bar, the coins
scanned, every drop with its reason and every hit with its feature values. `bun run signals:study [id…]` runs each
definition's `lab_event_study` over the default universe (the tool the study route runs, without its 50 s deadline,
recorded as a trial) and prints verdict, events, weeks, expectancy, upper95, train vs holdout and coins used/dropped.

### S3. Board

- New source `definition`. A firing definition is a `ResearchSignal` with its rule, `scope:
  'universe'` (the definition is studied over the universe; one coin rarely has 30
  event-weeks), `tested` = the rule's side, headline = the observed feature values as facts.
- `evidence` becomes a discriminated union on `kind`:
  - `study` — the existing `StudySummary` (replay of the rule).
  - `ledger` — for `opportunity`: realised outcomes of that setup kind from the platform
    ledger (`setupLedgerStats`, platform/stats.ts: the 24 h group over current-score-version outcomes, the
    record the alert line and the opportunity detail quote too): `n`, `clusters`, mean and interval, horizon.
    Null fields stay null under 5 clusters, as the ledger already does.
  - `scorecard` — for `radar`: the radar scorecard row for the call's horizon (`n`, mean
    relative return, hit rate).
  Every source therefore shows what backs it; `no Lab twin` is deleted from the UI and docs.
- An `opportunity` signal also carries `definitionId` (its daily definition, from
  `intradayKinds`) and that definition's `rule` with `scope: 'universe'`, so the row offers the
  study of the **daily version** of the same thesis. The UI labels it as the daily version,
  never as a test of the intraday setup itself. Radar calls stay rule-less: an LLM thesis about
  a dated catalyst is graded forward by the scorecard, not replayed.
- Novelty is unchanged (its rule is built from the observed extreme).

Shape as built (`src/shared/research.ts`):

- `evidence: { kind: 'study', …StudySummary } | { kind: 'ledger', setupKind, horizon: '24h', n, clusters, meanNet,
  ci95, hitRate } | { kind: 'scorecard', stance, horizonDays: 7, n, meanPct, hitRate } | null`. The study cache keeps
  plain `StudySummary` rows (no `kind`); the board adds `kind` when it attaches one, so rows stored before this change
  load unchanged. Ledger: `setupLedgerStats` per setup kind on the board (one filtered read per kind, bounded by
  `STUDY_STORE_TIMEOUT_MS`); an empty ledger is `n 0` with null numbers, an unreadable or slow one leaves `evidence`
  null. Scorecard: the call's stance at the
  7-day row (the longest graded horizon); null before any call is graded there.
- `dailyStudy: StudySummary | null`: opportunity only, today's cached study of its `rule` (the daily definition,
  universe scope). Study evidence never replaces the ledger evidence.
- `definitionId: string | null`: the definition in zone, or an opportunity's daily definition. An opportunity gets
  the definition named for its setup kind on its side (`definitionForKind(kind, side)`: a short
  `vol_expansion_breakout` gets `range_breakdown`, a long one `range_breakout`), else `rule: null`.
- `GET /api/research/definitions` → `{ definitions: [{ id, name, thesis, rule, ruleText, intradayKinds }] }`, zod-parsed,
  read like the board (guest-readable in PUBLIC_MODE). Each `rule` is a valid `POST /research/study` body without
  `coin` (universe scope).

### S4. UI

Evidence cell renders by `kind`: study as today; ledger `live record · n · clusters · mean
net return in % [lo, hi] · 24h` (per outcome; interval over cluster means); scorecard `graded forward · n calls · mean vs BTC · hit %`. Source chip and
filter for `definition`. Opportunity rows: ledger evidence plus `STUDY DAILY VERSION`; the daily rule text
under the headline is prefixed `daily version: `.
`/lab/study` gets a DEFINITIONS picker (the shipped definitions, prefilled, universe scope) so
its empty state is no longer a dead end.

### S5. Intraday replay — `src/server/platform/replay.ts`, `replaySource.ts`

The intraday setups (`platform/setups.ts`) are now replayed over history. The predicates are unchanged; the replay
tests them as shipped. It is a replay of fixed predicates, not a Lab trial: nothing is searched or tuned, and it adds
nothing to the trial count.

What it tests: the setup predicate and the scanner's repeat handling. `evaluateTick` (setups.ts) is the one path from
"24 h ring + tick inputs" to "setups that fire" (`computeFeatures` → `liquidityTiers` over the step's volumes →
`setupsFor`); the live scanner tick and the replay both call it. At each grid step the replay builds each coin's ring
from points with `ts ≤ step` only (no look-ahead), then applies the scanner's dedupe, ready TTL and cooldown as they
play out when every candidate is costed and nobody decides: a fired key is created, goes `ready` the same tick, stays
live (a re-fire only refreshes it) until the first step ≥ `PLATFORM_READY_TTL_MIN` (60) after creation, expires there,
and is not created again until `PLATFORM_COOLDOWN_MIN` (240) has passed since the expiry.

What it does not test: the score (it orders candidates and picks the costed top `PLATFORM_COST_TOP_N`; it never gates
creation, so the replay ignores it), operator decisions, book-based costs, and any feature whose input the stream
lacks. Such a feature is null, as the scanner treats an unknown feature (it fails every condition), and a setup that
reads one is reported `evaluable: false` with the reason, never as 0 events.

Grading: each entry is marked at the outcome loop's horizons (`PLATFORM_OUTCOME_HORIZONS`, default 1h, 4h, 24h, 72h)
at the stream's mark at the first point in [entry + horizon, entry + horizon + tolerance] (an entry with no point there
is not graded at that horizon). Candles sit on the 15-min grid: tolerance 0, the exit is exactly at the horizon.
Snapshots carry the scanner's wall clock (ms-jittered, so no point sits exactly at entry + horizon): tolerance one
persist step plus a minute (6 min). The exit is never before the horizon; the tolerance is the only look-ahead past it. Exits use
the ledger's own `netReturn` and costs: taker fee `DEFAULT_TAKER_FEE_BPS` (4.5 bps) each way, slippage 0 (no
historical book: understated for thin coins), funding = the hourly rate at entry × horizon hours, signed for the side
(the ledger's creation funding scaled to the horizon). Per kind × side × horizon the graded outcomes go through
`groupStats`, so the numbers mean what the ledger's mean: n per outcome, clusters (signal-time buckets of
max(1 day, horizon)), mean net over cluster means, 95% interval null under 5 clusters, hit rate; n 0 has null
numbers. `entries` counts ideas created, graded or not.

Sources:

- `candles` (default, no database needed): the top `PLATFORM_REPLAY_TOP` (20) HL perps by 24 h volume now, the latest
  5000 15-min candles each (about 52 days), one ring point per closed candle at its close: mark = close, 24 h volume =
  trailing 24 h sum of volume × close, funding = the latest hourly settlement at or before the point (stored `funding`
  rows when a database has 95% of the span, else HL `fundingHistory`). No OI, book or liquidation data, so
  `crowded_long`, `negative_funding_squeeze` and `deleveraging_washout` (all read `oiChg1hZ`) are not evaluable; only
  `vol_expansion_breakout` is. Known differences from the live scanner, listed in `assumptions`: funding lags the live
  predicted rate by up to an hour; the 1 h realized vol rests on 4 returns, not 60; tiers rank the step's volume
  against every other live coin's volume now (their history is not fetched); the universe is today's survivors.
  Candles and funding are memoised in process (a later run fetches only new bars). About 230 HL weight per coin, so
  20 coins take about 5 minutes under the weight guard; the replay's own requests stay under 600 of the guard's
  1000 per minute (`REPLAY_HL_BUDGET`), so the live scanner in the same process keeps a share. A run that loaded no
  coin, or fewer than half of them, fails (and is retried after 15 min) instead of answering zero entries.
- `snapshots`: stored `scan_snapshots` (mark, OI, funding, 24 h volume), every setup evaluable, when dense enough;
  the top `PLATFORM_REPLAY_TOP` coins by their latest stored 24 h volume, over at most 14 days
  (`SNAPSHOT_REPLAY_MAX_DAYS`), so the read stays bounded whatever the retention keeps (the other stored coins rank in
  the tiers). The replay's ring has a point per 5 min where the live ring has one per minute (stated in `assumptions`). The
  features need `FEATURE_MIN_TICKS_24H` = 96 ring points a day (one per 15 min: a 15-min change reads a point within
  20 min of each window end, and the funding z needs 48 points). The check is the median count of distinct snapshot
  timestamps per whole 24 h window; below 96 the answer is `unavailable` with the numbers, e.g. "too sparse: median 4
  scanner ticks per 24 h over 13 day(s) of scan_snapshots; the features need 96 (one per 15 min)". A scanner run from
  a cron a few times a day is that case. The always-on server persists one row per coin every 5 minutes (288 a day),
  and `PLATFORM_SCAN_RETENTION_DAYS` (30) keeps them longer than the other history for this replay.

Route: `GET /api/research/setups/replay?source=candles|snapshots` (default candles) →
`{ state: 'ok'|'pending'|'unavailable', reason?, asOf, source, window: {from, to} | null, coins, grid: '15m',
horizons, assumptions: string[], setups: [{ kind, side, horizon, evaluable, reason?, entries, n, clusters, meanNet,
ci95, hitRate }] }`, zod-parsed (`SetupReplayResponseSchema`, `src/shared/research.ts`), read like the board
(`candles` guest-readable in PUBLIC_MODE; `snapshots` needs a signed-in reader, a guest gets `unavailable` "sign in
required"). Computed in the background, one run per source at a time, memoised 6 h (a stale result is served while the
next runs); a request waits at most 2 s, then answers `pending` (ask again). The replay loop hands the event loop back
every 20 ms of work, so the process keeps serving while it runs. A failed run answers `unavailable` ("replay failed
(see server log)") and is retried after 15 min; `snapshots` without a worker or database is `unavailable` ("needs a
database"). On a serverless runtime (`VERCEL` set) both sources answer `unavailable` ("needs the always-on server; or
run `bun run signals:replay`") and nothing is started: a 4–5 min run outlasts the function.

CLI: `bun run signals:replay [--top N] [--source candles|snapshots]` runs once without a request timeout and prints
the window, coins, the per-setup table, the not-evaluable list and the assumptions.

Parity test (`replay.test.ts`): a fixture of six coins on a 15-min grid with OI, fed tick by tick through the real
scanner `tick()` (injected `info` and clock, memory store; every candidate costed so ideas go ready and expire as the
replay models) produces exactly the replay's entries (coin, kind, side, time, entry price), for three kinds, with and
without the cooldown. The replay's assumption that every candidate is costed is not how live always runs: a candidate
beyond `PLATFORM_COST_TOP_N` by score, or with no book, gets no costs, stays `new`, never expires and blocks its key
from firing again, so live can fire fewer re-entries than the replay counts. A second test runs the scanner with no
candidate costed and shows that divergence; `assumptions` says it in words.

The board's `opportunity` source now carries a `note` when the scanner stored fewer than 96 ticks in the last 24 h
(`scanTickCount` over `scan_snapshots`), with the count and the need: "scanner has 95 ticks stored in the last 24 h; the
setup features need one per 15 min (96 a day; the always-on server scans every minute)". Only under half the need (the
24 h funding features need 48 points) does it add ": too few for any setup to fire"; one missed run near the need
claims nothing.

### Not in this change

The three OI setups stay unreplayable until intraday OI is stored at a 15-min or finer cadence (an always-on
scanner writing `scan_snapshots`); 4 h triggers, entry zones and the level builder of § B.4; phases 3–5.
