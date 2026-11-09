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
reason, studies run on demand inside the 50 s tool deadline, and approve is disabled with
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
`rule: null` (intraday setups have no Lab twin; that is stated in the UI, not hidden).

Routes (all zod-parsed in and out):

- `GET /api/research/board` → `{ asOf, signals: ResearchSignal[], sources: Record<source,
  {state: 'ok'|'unavailable', reason?: one of a fixed set, count, dropped}>,
  pulse: {assets, firing} | null }`. Each source is loaded independently; one failing
  source never empties the board. For a PUBLIC_MODE guest the radar source is
  `unavailable` ("sign in required") and contributes no signals, as `/api/radar` does.
- `POST /api/research/study` `{ rule, coin?, stopAtr, targetAtr }` →
  `{ studyId, cached, summary: StudySummary, study }`. The board sends `boardStudy(signal)`
  (`src/shared/research.ts`: `coin` only for `coin` scope, the default 1.5 / 3 ATR exits),
  the same body the board looks its evidence up under. Runs `lab_event_study` through the
  existing Lab tool and counts as a trial exactly as a direct tool call does. Results are
  cached in process by rule, scope and UTC day.
- `GET /api/radar` → `{ state, latestNote: {date, markdown, truncated}|null, calls,
  scorecard }` read from `data/radar/` with the existing schemas (at most 50 calls). Needs a
  signed-in session (not guest-readable in PUBLIC_MODE). If the files are absent (Vercel
  bundle), `state: 'unavailable'` with the reason.

Studies run on request only: evidence is on the board once someone ran that study today
(in-process cache), and every run counts as a trial. Nothing pre-computes them.

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
  - no rule: muted `no Lab twin` with a title explaining why.
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
Without a rule: a short empty state linking to SEARCH and CATALOGUE. The board's canonical
studies (this coin, or the default top-20 universe, default exits) run through
`POST /api/research/study` (`studyRoute`, `src/ui/lib/study.ts`), so opening a row with
evidence reuses the cached study instead of logging a new trial, and a run here shows on the
board. Other universes (another top N, my markets) call `lab_event_study` directly.

Output, in this order: rule text; verdict with the screen line (events, weeks,
expectancy, upper95); train vs holdout; the condition funnel; per-coin table (`DataTable`);
event list (first 200 of `eventListTotal`); survivorship note; `idea n of N`.
Actions: OPEN RULE (rule drill with equity and sensitivity), SAVE (existing catalogue
form; the save-bar verdict still applies).

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
