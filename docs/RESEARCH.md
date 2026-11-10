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
the reason shown before the dialog opens.

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
  to the in-process map and never holds a study. `catalogueId` is the rule's catalogue id when
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

Status: done (2026-11-10): S1–S4 shipped, review fixes applied. Phases 1–2 of the candidate pipeline
(`docs/research/candidates-redesign.md` § B.3, B.4), cut to what the Lab can replay today.

Problem: four engines each defined "signal" their own way (scanner setups, novelty, Lab rules,
radar calls), and only Lab rules could be replayed. Rows on the board said `no Lab twin`.

Rule: **a signal is a Lab `Rule` written as data.** The same rule object is evaluated live (is
it in zone on the latest daily bar?) and historically (`lab_event_study`), through the same
engine functions. Nothing else is called a signal definition.

### S1. Definitions — `src/server/signals/definitions.ts`

A code-shipped list of `SignalDefinition`: `{ id, name, thesis (one line, facts), rule:
Omit<Rule, 'asset'>, intradayKinds: string[] }`. Each `rule` parses with the Lab `RuleSchema`
once an asset is filled in, uses only `ht:*` metrics every perp has (`price`, `volume`,
`funding`, `oi`, plus the regime condition and `stop`/`target`/`invalidation` levels), and its
thresholds are starting points for the event study, not claims. v1 set, from § B.4 where the
features exist: `funding_fade` (short), `negative_funding_build` (long), `washout_reclaim`
(long), `trend_pullback` (long in an up-trend; short twin in a down-trend if the Rule shape
needs two entries), `range_breakout`. A definition whose predicate the Lab cannot express is
left out and listed in `docs/TASKS.md`, not approximated silently.

Shipped (thresholds are starting points; each rule's comment in the file names what B.4 asked that it drops):

| id | side, hold | rule | dropped from B.4 |
|---|---|---|---|
| `funding_fade` | short 7d | `ht:funding z(90) ≥ 2 AND ht:oi pctile(30) ≥ 0.95` | `\|ret_3d\| < 1 ATR` (third condition, ATR-scaled) |
| `negative_funding_build` | long 7d | `ht:funding z(90) < −1.5 AND ht:oi roc(7) ≥ 0.1` | `ret_7d ≥ −1 ATR` |
| `washout_reclaim` | long 7d, stop 2-bar low | `ht:price roc(3) < −0.08 AND ht:oi roc(3) < −0.1` | the 4 h reclaim trigger, funding < 0, liquidation z (no metric); a 1-day return needs roc(1), below the minimum window |
| `trend_pullback_long` / `_short` ("Trend at its 20-day mean") | long / short 10d | `ht:price ma_ratio(20)` in [−0.02, 0.02) `AND trend ∈ {up}` / `{down}`: price at its 20-day mean in a trend, above it included, so not strictly a pullback (the id keeps the B.4 name) | distance in %, not ATR; funding-not-crowded |
| `range_breakout` | long 7d | `ht:price pctile(20) ≥ 1 AND ht:volume ma_ratio(20) ≥ 0.5`; the 20-day mean includes the day, so volume ≥ about 1.54× the prior 19-day mean | breakout on closes, not highs (no rolling-max feature) |

Nothing was left out. `ht:oi` is collector snapshots (stored history only), so the three OI definitions are in zone
only where OI is collected. Stop/target levels are left to the study's exits except the washout's structural stop.
A definition's `rule` carries `asset: UNIVERSE_ASSET` (`"UNIVERSE"`, `src/shared/research.ts`), not a ticker: it is
studied over the universe without a `coin`, so every coin in zone shares one study, one cache key and one trial.

`intradayKinds` names the platform setup kinds (`src/server/platform/setups.ts`) that share the
thesis: `crowded_long → funding_fade`, `negative_funding_squeeze → negative_funding_build`,
`deleveraging_washout → washout_reclaim`, `vol_expansion_breakout → range_breakout`. A test
asserts every platform setup kind is named by exactly one definition.

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

Concrete: `createDefinitionScanner` loads 200 days per coin (`SCAN_LOOKBACK_DAYS`: the 90-day window plus the
regime's 50-day mean) through the Lab service's `loadDataset` (registry cache), memoises one complete scan per UTC
day (callers in flight share it; a scan that dropped anything is kept only 15 min, `SCAN_RETRY_MS`, so a scan run
before stored data reaches the bar is retried; a scan that fails as a whole is forgotten), and drops a coin that
fails, is not loaded within 120 s (`SCAN_DEADLINE_MS`) or whose price does not reach yesterday's bar. A definition is
evaluated on a coin only when every metric its conditions read has a raw, not forward-filled, value on the bar (the
loader's `lastRaw`; the registry forward-fills funding and OI up to 3 days); otherwise that coin × definition is
dropped. A partial day of funding (the day's hourly settlements not all stored yet) is not detected: the loader
returns only the daily sum. Dropped coins and coin × definitions are added to the source's `dropped`. A test checks
that the 200-bar window answers as the full history does for every definition on the fixture. The board bounds the wait with its source timeout like every source. Watchlist = `watchedAssets`
(intel_watchlist, else DESK_WATCHLIST). Without `DATABASE_URL` the source is `unavailable` ("needs a database"):
every coin's funding would be fetched live at about a coin a minute (Runtime above), and OI is stored-only.

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
  the definition only when the definition's side matches (a short `vol_expansion_breakout` has none: `range_breakout`
  is long-only), else `rule: null`.
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

### Not in this change

The intraday scanner's predicates stay as they are (no stored intraday history to replay them
from); 4 h triggers, entry zones and the level builder of § B.4; phases 3–5.
