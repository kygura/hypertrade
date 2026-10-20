# Candidate pipeline: audit and redesign proposal

Scouted 2026-10-20 across the routine, platform, Lab, Intel, desk and every
collector. Part A is what exists and what it actually produces. Part B is the
proposed rewrite: one code-first pipeline that generates daily-to-weekly setup
candidates conditionally, with the LLM narrating and challenging rather than
inventing levels. Nothing here changes the hard rule: output is market
intelligence, every setup is a hypothesis for a human, no sizing, no orders.

---

## A. What the current routines and pipelines expose

### A.1 Six idea generators, no shared setup

| Path | Where | Timeframe | What a "hit" carries | Ledger / outcome | State today |
|---|---|---|---|---|---|
| Routine setups | `src/server/routine/{schema,gate,ledger,htf}.ts`, `data/setups/` | swing ≤14 d, position ≤45 d | entry zone, invalidation + reason, 1–3 targets, R, trigger text, evidence | `ledger.json`, hourly-candle advance, 90 d hit rate / avg R | **0 setups ever.** Gate has never been exercised in production. |
| Platform opportunities | `src/server/platform/{setups,features,score,outcomes}.ts` | 15 min–1 h z on a 24 h ring, TTL 1–2 h | stop = 1–1.5 × hourly sigma, score, cost | Postgres `ledger_entries`, net return at 1/4/24/72 h, no R | Starved: hourly GitHub tick gives one point per coin per hour, most features null outside the top 20. Ready pushes never fire in tick mode. |
| Lab rules | `src/server/lab/**` | daily close, BTC/ETH | direction + "in zone today" | `lab_rules`, walk-forward Sharpe, DSR | 3 catalogued rules, none firing for 10 days, ids churn every run. |
| Desk proposals | `src/server/desk/{agents,governor,service}.ts` | intraday/swing/position (free text) | stop, target, riskPct, invalidation text | `desk_proposals`, paper P&L | Parallel LLM PM; `approval: auto` by default on the paper book; governor defaults disagree with PROP. |
| Intel thesis / copilot | `src/server/intel/thesis.ts` | none | operator-typed claims with code-checked `price_vs_level`, `funding_sign`, `oi_change` | `intel_theses` | Works, read by the routine only as "broken premises". |
| TUI tickets | `tui/src/core/ticket.ts` | none | order ticket | exchange | Out of scope here. |

The fields are spelled differently in each (`invalidation` vs `invalidationPx`
vs `stop`), outcomes are measured in four different units (R to first target,
bps net return, Sharpe, paper P&L), and PROP's three setup ids
(`funding_fade`, `sector_continuation`, `post_liquidation_reclaim`,
`docs/PROP.md` §(d)) appear nowhere in code. The Intel journal's `SETUP_TAGS`
list has eleven entries and shares one with PROP.

### A.2 What one scheduled routine run does

ROUTINE.md is 894 lines of prose a stateless Claude session follows every 4 h.
It shells out to code at four points (`platform:tick`, `routine --collect-only`,
`signals:collect`, `routine --mode pulse --input`), and does everything else by
hand: ~20 curl calls into `/tmp/run`, the positioning matrix, the scorecard,
the marketstate and sectors JSON, the Lab snapshot, two `index.ts` import
lines, the commit, the PR, the ntfy push.

What the committed outputs contain right now:

- `data/setups/ledger.json`: `open: [], closed: []`, stats null. Seed from
  2026-10-18, unchanged since.
- `data/setups/htf.json`: regime `neutral`, stance `range`, four neutral
  biases. Stance `range` permits setups; none were proposed.
- `data/signals/`: two snapshots, both `changed: false`, every platform section
  HTTP 503, Lab trials query timed out. The signals section has never carried
  a signal.
- `data/marketstate/`: 9 real days of narrative. Five runs on 10-20 overwrote
  the same file. Headlines and `risks[]` are checkable numbers, graded next
  run by the LLM, never by code.
- `data/sectors/`: 6 sectors, 2 rotations at confidence 0.15–0.2, rationales
  admitting "not re-pulled this run".
- `data/lab/`: 10 snapshots of 3 rule ids, all `firing: false`.

The gate rules exist three times (ROUTINE.md §4.4, `docs/fallback-routine.md`
step 6, `prompts.ts`) with `gate.ts` as the authority. Collection exists twice
(ROUTINE.md §2.2–2.4 curl vs `routine/collect.ts`) with different FRED and
Yahoo id lists. The fallback `bun run routine` has no scheduler at all; the
`routine.yml` workflow was removed.

Verdict: the only actionable, checkable artefact (a gated setup with R and a
hourly status engine) is the one the LLM has never produced. Everything else
is narrative. The LLM decides whether to propose anything, and "stand aside"
has been its only answer.

### A.3 Platform scanner (always-on design, hourly reality)

Setups-as-data with per-tier thresholds and a parity test is the best-engineered
pattern in the repo (`platform/setups.ts`, `setups.test.ts`). But every
predicate reads 15-min / 1-h z-scores against a 24 h ring, stops are hourly
sigma, TTL is 1–2 h, and funding is charged over a 4 h hold. It is an intraday
scalp finder. Deployed through `platform-tick.yml` once an hour it gets one
`scan_snapshots` point per coin per hour, so `ret15mZ`, `priceAccelZ` and
`rv1h` are null for most coins and nothing fires. Outcomes are measured
(1/4/24/72 h net return) but feed back only into a displayed edge number;
nothing adjusts thresholds, universe or ranking. `investigating` is stubbed
(`researchAllowed: false`).

### A.4 Lab

A real research engine: tree-ensemble candidate rules, purged walk-forward,
untouched 20 % holdout, family dedupe, deflated Sharpe against clustered trial
count, calibration tables. But a rule is `direction + firing on the daily
close`; the backtest is a daily binary hold with 10 bps slippage, no stop,
target or hold length (`horizonDays` only shapes labels). The event study
(`engine/eventStudy.ts`) is the one place a rule gets ATR stop/target, R net of
fees and funding, weekly clustering and a reject-only verdict, and it is wired
only to authored trials, not to the catalogue or to setups. The metric set
the routine searches (MVRV, NVT, funding, OI, premium, F&G, stablecoin cap) on
BTC/ETH makes it a macro/on-chain regime finder with funding as its only
derivatives input. Re-running the same four searches every 4 h on
near-identical data is a multiple-testing layer the DSR does not see.

### A.5 Intel

A reading feed for held/watched exposure: RSS/governance/X/Telegram → cluster
→ cheap-LLM extraction → exposure-graph mapper → materiality-scored alert line.
Three things in it are numeric and conditionable: operator theses with
code-evaluated checks and an invalidation that flips to `triggered`; flow
flags (`crowded_long`, `deleveraging`, `spot_led`, `funding_flip`,
`oi_up_price_down`) with z windows; dated catalysts with an LLM direction
guess that is never evaluated. `pricedIn` (price and OI move since first seen)
is the raw material for a narrative-vs-price divergence and is never
thresholded. None of it reaches a setup.

### A.6 Data sources: provided vs leveraged

| Source | Provides | Leveraged? |
|---|---|---|
| HL `metaAndAssetCtxs` (15 min collect, 60 s scanner) | mark, funding, OI, premium, volume per coin | **Yes.** The only input scanner, novelty and flow detectors compute on. |
| HL `fundingHistory` | hourly funding to listing | **Yes.** Only derivatives series deep enough to backtest crowding (`funding_z90`, Lab `ht:funding`). |
| HL candles + Binance/Bitstamp stitch | 1m–1M OHLCV, BTC daily to 2011 | **Yes.** Lab, cycles, novelty, routine HTF, outcomes. |
| Coinalyze 15-min flow (≤8 coins, 90 d retention) | liquidations, L/S ratio, spot vs perp volume, buy volume | Partly. Three flow detectors; scanner setups never see it. Retention loss is unrecoverable upstream. |
| Coinalyze daily OI backfill | HL OI 1500 d | Narrow. Opens the novelty 365 d gate only. |
| HL `l2Book` | depth, spread | Yes, cost model and liquidity gate for top 25. |
| HL `clearinghouseState` crawler + liqmap | liquidation levels | Only in always-on mode; dead on the tick. |
| FRED (API, 12 series) | rates, liquidity, HY spread, VIX | Display, desk tool, Lab metrics nobody uses in a saved rule. |
| FRED CSV + Yahoo (routine curl) | 7 ids + 10 tickers | Prompt only, never stored, cannot become a feature. |
| Deribit DVOL, Coin Metrics, blockchain.com, DefiLlama, FNG | daily history | Lab inputs. FNG and stablecoin cap are fetched by three separate modules. |
| Elfa | mention counts | Sectors table decoration. Nothing computes on it. |
| hl-cycles (external) | regime, levels | Prose only; routine's HTF refresh trigger. |
| RSS / X / Telegram / websearch | text | Intel alerts. Zero numeric use. |

Five sources carry daily-to-weekly edge-relevant information: HL asset
contexts, HL funding history, stitched candles, Coinalyze flow, daily OI. The
rest is regime context (FRED, MVRV) or decoration (Elfa, Yahoo prose,
CoinGecko snapshots).

### A.7 Deployment reality

README says Vercel + hourly GitHub tick; SPEC §P0.4 says a 60 s always-on
scanner on Railway. The repo is built for the second and runs as the first.
Everything that needs the WebSocket, the crawler, the liqmap or a live mid is
dead in production. The routine's signals section depends on the Vercel
worker and has seen only 503s.

---

## B. Proposal: one candidate pipeline, daily by default

### B.1 Principles

1. **One setup, one ledger, one outcome unit.** The routine's `SetupSchema`
   (entry zone, invalidation + reason, targets, R, horizon, expiry, evidence,
   status machine) is the right shape and the closest to PROP. Promote it to
   `src/shared/setups.ts`, add `setup_id` from a finite catalogue, and give it
   a Postgres store with a memory twin plus a JSON export to `data/setups/`
   for the stateless session. Outcomes are R multiples, clustered by week,
   per `setup_id`. Every other generator either writes into this ledger or is
   parked.
2. **Setups as data, on a daily feature frame.** Port the platform's
   predicate-plus-parity pattern from the 24 h ring to a daily (and 4 h)
   frame computed from stored history. Code builds the predicate, the entry
   zone, the invalidation and the targets. The LLM never sets a level.
3. **Conditional generation.** Candidates are produced only when the regime
   filter, the PROP budget and the setup predicate all hold; otherwise the
   run says why, in code-generated facts. "Stand aside" is a computed state,
   not an LLM mood.
4. **Validated before promoted.** A setup definition enters the catalogue only
   after the Lab event study clears it on ≥2 years of history. A definition
   whose rolling 90 d upper95 expectancy drops below 0 is demoted to
   watch-only automatically. The same engine validates and monitors.
5. **The LLM narrates and challenges.** One structured call per daily run:
   thesis text, evidence lines, what-would-prove-wrong, and an optional
   objection per candidate (conflicting catalyst, broken thesis). It may
   cancel, it cannot create.
6. **Code runs on a scheduler; the Claude session is optional.** A GitHub
   Action runs the pipeline. ROUTINE.md shrinks to "run it, read the output,
   add the narrative sections, push".

### B.2 Pipeline

```
daily 00:45 UTC (after PROP's 00:30 reset)              every 4 h
┌──────────────────────────────────────────────┐  ┌──────────────────────┐
│ 1 collect   stored tables only (no curl)      │  │ advance              │
│ 2 frame     daily + 4h features per coin      │  │  hourly candles →    │
│ 3 regime    HTF view (code) + hl-cycles state │  │  watching/triggered/ │
│ 4 budget    PROP gate: slots, weekly R, blackouts │ invalidated/target │
│ 5 scan      catalogue predicates → hits + near-miss │ R + ledger stats  │
│ 6 levels    entry zone / invalidation / targets │ │  ntfy only on       │
│ 7 gate      existing gate.ts (structure, R, caps) │ status change      │
│ 8 narrate   one LLM call: thesis, evidence, objections, cancels        │
│ 9 persist   setups store → data/setups export → brief → one ntfy push │
└──────────────────────────────────────────────┘  └──────────────────────┘
weekly Sunday: event-study every catalogue entry on fresh history, refresh
               edge numbers, demote/promote, write the review doc
```

Each step is a pure function with injected clock/fetch/store, matching the
repo's existing seam convention.

### B.3 Feature frame (`src/server/candidates/features.ts`)

Computed from `candles` (1d, 4h, 1h), `funding` (hourly), `observations`
(`hl.oi.<COIN>` daily, Coinalyze daily aggregates), `market_sectors`,
`data/sectors/latest.json`. Lookbacks 20 / 30 / 90 / 365 days. All
pure, all from stored rows, so the frame is replayable for the event study.

| Feature | Definition | Source |
|---|---|---|
| `atr14` | ATR over 14 daily bars | candles 1d |
| `ret_1d`, `ret_3d`, `ret_7d` | log returns | candles 1d |
| `range_pos_20` | close position inside 20 d high/low | candles 1d |
| `breakout_20` | close > max(high, 20 d) / < min(low, 20 d) | candles 1d |
| `sma20_dist`, `sma50_dist` | distance to daily SMAs in ATR | candles 1d |
| `funding_1d` | sum of hourly funding | funding |
| `funding_z90` | z of `funding_1d` over 90 d | funding |
| `oi_chg_7d`, `oi_from_peak_20`, `oi_at_high_30` | OI change and peak distance | observations |
| `liq_long_z30`, `liq_short_z30` | daily liquidation z | Coinalyze |
| `spot_perp_ratio_z30` | spot vs perp volume z | Coinalyze |
| `rv_5_to_60` | realised vol ratio | candles 1d |
| `sector_momentum`, `sector_in_rotation_to` | from committed sectors | sectors |
| `catalyst_within_h` | hours to next FOMC/CPI/NFP or dated event | intel calendar / catalysts |
| `htf_trend` | up / down / range from `htf.ts` | existing |

Parity tests: `funding_z90` equals the novelty loop's; daily funding equals
Lab `ht:funding`. Reuse `intel/windows.ts` for robust z.

### B.4 Catalogue v1 (`src/server/candidates/catalogue.ts`)

Five definitions, three of them PROP's, each a data object with a predicate,
a direction, a level builder, a horizon and a regime rule. Thresholds are
starting points for the event study, not claims.

| `setup_id` | Dir | Predicate (daily close) | Trigger (checked on 4 h) | Entry zone | Invalidation | Targets | Horizon |
|---|---|---|---|---|---|---|---|
| `funding_fade` | short | `funding_z90 ≥ 2`, `oi_at_high_30`, `|ret_3d| < 1 atr14` | 4 h close below prior 4 h low | prior day close … prior day high, capped 4 % | `max(20 d high, entry mid + 1.5 atr14)`, reason "crowding resolved higher" | 2R, 3R | swing, 7 d |
| `post_liquidation_reclaim` | long | `ret_1d ≤ −2 atr14` (or ≤ −5 %), `oi_from_peak_20 ≤ −15 %`, `funding_1d < 0`, `liq_long_z30 ≥ 2` | 4 h close back above washout day midpoint | midpoint ± 1 % | washout day low, reason "reclaim failed" | 2R, 3R | swing, 7 d |
| `sector_continuation` | long | `sector_momentum ≥ 0.5` and sector in `rotations[].to`, `breakout_20`, `oi_chg_7d ≥ +10 %`, `funding_z90 < 1.5` | retest of breakout level | breakout level … +1 atr14 × 0.5 | breakout day low, reason "breakout failed" | measured move (20 d range) at ≥2R, else drop | swing, 10 d |
| `negative_funding_build` | long | `funding_z90 ≤ −1.5`, `oi_chg_7d ≥ +10 %`, `ret_7d ≥ −1 atr14` | 4 h close above prior 4 h high | prior day low … close | 20 d low or entry mid − 1.5 atr14 | 2R, 3R | swing, 7 d |
| `htf_pullback` | with `htf_trend` | `htf_trend ∈ {up, down}`, `|sma20_dist| ≤ 0.5 atr14`, funding not crowded in trend direction (`|funding_z90| < 1`) | 4 h close back through SMA20 in trend direction | SMA20 ± 0.5 atr14 | 2 atr14 beyond SMA20 against trend | 2R, 3R | position, 10 d |

Everything is bounded by PROP: max hold 10 days, so `maxDays` becomes
`{ swing: 7, position: 10 }` (today 14 / 45); R ≥ 2 to first target stays;
one target per position (PROP forbids partial take-profit) is expressed as
"first target is the plan, later targets are scale-out alternatives".

Each definition ships with a Lab rule twin using the PS-B4 fields
(`stop`, `target`, `invalidation`, `regime`) so `lab_event_study` can replay
it. A parity test asserts that the candidate scanner's hit days equal the
event study's entry days on the same frame (same contract as
`eventStudy.test.ts`).

### B.5 Conditional gate (`src/server/candidates/budget.ts`)

Code-decided, before any predicate runs; the run output states which of
these held so the brief can explain a quiet day in facts:

- HTF stance `stand_aside` (from the existing `htf.ts` refresh rule) → no new
  candidates, near-miss list only.
- Open slots: PROP `max concurrent 2`, same sector counts as one, `max open
  risk 1 %` expressed as "sum of open setups' planned risk at 0.5 % each".
- Weekly stop: realised R over the trailing 5 trading days ≤ −3R → stand
  aside 5 calendar days.
- Weekly cap: ≤ 6 new setups per ISO week.
- Event blackout: no new candidate whose trigger window overlaps ±30 min of
  CPI/FOMC/NFP; a swing candidate created < 24 h before FOMC is tagged
  `catalyst_risk` and conviction capped at low.
- Catalogue health: a `setup_id` in `watch_only` state produces near-misses,
  never candidates.

These constants live in one `PROP` object beside `GATE`, replacing the desk
governor's conflicting defaults for anything that writes to the ledger.

### B.6 Level construction and existing gate

`levels.ts` builds entry zone, invalidation and targets from the frame per
definition, then the existing `gate.ts` runs unchanged (ordering, zone width
≤ 4 %, invalidation 1–25 %, R ≥ 2, expiry, duplicates, counter-regime
rules). Because levels are code-built the gate becomes a safety net rather
than the thing that silently drops everything. Rejections are persisted as
near-misses with the failing rule, so the brief can say "funding_fade on
HYPE: R 1.7 to first target, below 2".

### B.7 Ledger, outcomes, feedback

- Store: `setups` and `setup_events` tables (memory twin, JSON export). Keep
  `ledger.ts`'s hourly-candle `advanceSetup`, which is correct and tested.
- Outcomes: R at close, plus R at 1 d / 3 d / 7 d marks for the event-study
  comparison. Weekly-clustered stats per `setup_id`: n, expectancy,
  upper95, hit rate (same `stats.ts` shape as the platform ledger).
- Feedback: the weekly job recomputes each definition's live expectancy and
  event-study expectancy. Live upper95 < 0 over 90 d with ≥ 10 clusters →
  `watch_only`. Event study `rejected` on refreshed history → `watch_only`.
  Nothing tunes thresholds automatically; threshold changes are a human
  edit plus a re-run of the event study, logged in the review doc.
- Every candidate carries its definition's current edge facts (`n`, `exp`,
  `upper95`, `basis: event_study | live`) as evidence, the way platform
  opportunities carry `netEdgeBps`.

### B.8 LLM role (one call per daily run)

Input: the frame rows for each candidate, the HTF view, open setups, open
theses and their check status, catalysts in the next 7 days, the previous
brief. Output schema (strict zod, `completeStructured`, fails closed):

```
{ candidates: [{ id, thesis, evidence[], what_proves_wrong[], objection: null | { kind, text } }],
  cancel: [{ id, reason }],
  brief: string }
```

The number validator already drops lines whose numbers are not in the
payload. An `objection` does not remove a candidate; it is recorded and
shown. The marketstate and sectors narratives move to a separate daily
narrative job that reads the same frame; they stop being a prerequisite for
setups.

### B.9 Scheduling and deployment

- `candidates.yml`: daily 00:45 UTC, DB-leased like `platform-tick.yml`,
  runs `bun run candidates`. Secrets: `DATABASE_URL`, `COINALYZE_API_KEY`,
  LLM key, `NTFY_TOPIC`.
- `candidates-advance.yml`: every 4 h, `bun run candidates:advance` (no LLM).
- `candidates-review.yml`: Sunday, event study + demotion + review doc.
- Each job exports `data/setups/{ledger,htf,near-miss}.json` and a dated
  brief, commits under `data/`, and lands through the existing
  `routine-land.yml`.
- ROUTINE.md becomes ~100 lines: pull, run `bun run candidates --dry-run`
  to read the context, write the narrative sections, push. If the session
  does not run, the data still updates.

### B.10 Collection consolidation

One collector set, all into `observations` or `candles`, no prose curl:

- Merge the routine's FRED CSV ids and Yahoo tickers into `collectors/fred.ts`
  and a new `collectors/equities.ts` (keyless chart endpoint), so equity
  dispersion and Brent become stored series and Lab metrics.
- Delete the two extra FNG, DefiLlama and Deribit fetchers; providers read
  stored rows first (they already do).
- Raise the Coinalyze focus set from ≤ 8 to the candidate universe (top 30
  by OI plus `PLATFORM_MY_MARKETS`), add a daily aggregate table so the 90 d
  intraday prune stops destroying the only cross-venue history.
- Universe for candidates: top 30 by 24 h notional plus my markets, with a
  depth floor from the stored `l2Book` snapshot. No scanning of every
  listed coin.

### B.11 What gets parked or demoted

- Platform intraday scanner: keep the code and tests, stop scheduling it
  until an always-on deployment exists. Its near-miss feed is replaced by
  the daily one. Its `setups.ts` pattern is what the new catalogue copies.
- Desk autonomous cycles: `approval: auto` on an LLM proposal path conflicts
  with the repo's hard rule in spirit even on paper. Default to `manual` and
  remove `propose_trade` from the cycle task, or have proposals write to the
  shared ledger as `watching` with `levels_source: model` and conviction
  low. Not a candidate source for v1.
- Lab 4-hourly searches in the routine: move to the weekly job, with a
  fixed metric set and a trial counter that spans runs.
- Elfa, CoinGecko snapshots, blockchain.com, hl-cycles prose: keep as
  context, no pipeline dependency.

### B.12 Phases

| Phase | Deliverable | Check that fails if it breaks |
|---|---|---|
| 0 | `src/shared/setups.ts` (schema + `setup_id` + `levels_source`), pg + memory store, JSON export, `PROP` constants, `GATE.maxDays` to 7/10 | shared store suite runs on both twins; gate tests updated |
| 1 | `candidates/features.ts` daily/4 h frame from stored tables | parity with novelty `funding_z90` and Lab `ht:funding`; frame is deterministic on fixtures |
| 2 | `candidates/catalogue.ts` five definitions + `levels.ts`; Lab rule twins | scanner hits == event-study entries on 20 k synthetic bars (digest fixture) |
| 3 | `bun run candidates` and `candidates:advance`; `budget.ts`; one LLM narration call; ntfy on change only | end-to-end test on fixtures with `--input`; dry-run prints why zero candidates |
| 4 | Workflows; `data/setups` export; ROUTINE.md rewritten as a thin wrapper; narrative job split out; duplicate collectors removed | `check:api`, build, routine-land on a data-only PR |
| 5 | Weekly review job: event-study refresh, demotion, review doc; edge facts on candidates | demotion test: a definition with upper95 < 0 produces near-misses only |

Phase 0–2 are pure and testable without a network. Phase 3 is the first run
that can put a setup in the ledger. Until then the ledger stays empty, which
is the honest state of the record today.

### B.13 Open questions for the operator

- Horizon split: keep `position` at all for the prop account, given the 10
  day hold cap, or run swing-only until the record exists?
- Universe: PROP leverage tiers make BTC/ETH/SOL/HYPE the practical set;
  should the catalogue scan the top 30 or only those plus sector leaders?
- Coinalyze budget: raising the focus set to 30 coins is ~4× the calls;
  within the 40/min key, but worth confirming.
- Thresholds in B.4 are placeholders; the event study decides, and the first
  pass may clear none of the five. That is a result, not a failure.
