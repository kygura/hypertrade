# Tasks

Current and open work only. Completed phases are summarised below; their full task
lists live in git history (see History).

## Open

Narrowing to three jobs, phase 1 (2026-11-11): nav and landing only, nothing deleted. The shell has three
cells: QUEUE (what deserves a look today, the landing `/queue`; MOVES is its second tab), RESEARCH (is there an
edge), TRADE (what did I do and was I right); the contract is docs/RESEARCH.md "Nav". Every route below still works
by URL.

- [x] Stage 2 (2026-11-11): the attention queue as home. `GET /api/queue` merges moves triage, ready opportunities and
  radar calls under `MOVES_TRIAGE_DAILY`; dismissals in migration 025; `/coin/:coin` is the decide page and
  `/markets/:coin` redirects to it; ASK is a drawer that carries the coin and queue item. Contract: docs/SPEC.md
  § Queue; screens: docs/design/README.md §10.14 to §10.16.
- [x] Approval on the coin page (2026-11-12): the SETUP block carries APPROVE and REJECT with the feed's gates and
  `TicketDialog`, so `/feed` no longer blocks the 11-18 review. The liquidation map left the coin page (the crawler
  holds no positions without an always-on process); moves print as ordinary percent, not log-%.
- [ ] Queue sources not yet in (docs/SPEC.md § Queue Q0), each with its blocker: board definitions, rules and novelty
  (answer "is there an edge", heavy to load, no per-item state, dozens a day would fill the cap); Intel alerts (the
  asset can be a narrative id: needs an asset-to-perp mapping and a rule for alerts Telegram already pushed);
  Terminal changes (one brief, not per coin, an LLM run per open); Desk alerts (free text, no coin field).
- [ ] Queue slots are strongest first (item score, then agreeing sources). Open: a separate `QUEUE_DAILY` so triage does
  not use the whole `MOVES_TRIAGE_DAILY` budget, and cross-source score weights (an opportunity's own `score` is raw,
  not normalised to its bar, so the queue still scores a ready setup and a radar call as 1).
- [ ] `src/ui/pages/moves/Moves.tsx` still polls `/api/moves/triage` every 60 s, now only for `agentBlockedReason`
  (the unrendered `TriagePanel` was deleted); drop the poll or fetch the reason another way.
- [ ] Telegram review links (`intel/mapper.ts`, `intel/terminal.ts`) still open `/terminal?review=1`, a hidden screen;
  retarget them before `/terminal` is deleted.

- [ ] 2026-11-18: delete the screens hidden from nav, with their server code, if none was missed for a week:
  - TRADE: FEED (`/feed`), CHANGES (`/terminal`, `/asset/:coin`), WATCH (`/watch`), THESES (`/theses`),
    QUERY (`/query`).
  - MOVES: MARKETS (`/markets`), STATE (`/state`), SECTORS (`/sectors`), CYCLES (`/cycles`).
  - ENGINE: strategies, decisions, governor (`/strategies`, `/decisions`, `/governor`); no entry point.
  - Lab SEARCH, RUNS and PULSE (`/lab/search`, `/lab/runs`, `/lab/pulse`) are folded behind RULES: off the
    tab row, SEARCH and RUNS linked from the RULES page; `/lab/pulse` is unlinked.
  - Kept, explicitly: BRANCHES and the portfolio simulation (`/analyst` SIMULATE, the top bar's ASK drawer).
  - Before deleting: the coin page links to `/feed?id=` (approve) and queue opportunity parts drill to `/feed?id=`;
    the queue's moves parts drill to `/moves?coin=`; Telegram links still target `/terminal?review=1`.

UI consolidation, per `docs/CONSOLIDATION.md` (one cell per operator job, one home per
object; 6 shell cells today against a ceiling of 9, target 5):

- [x] PR 1: visible bugs, one kill switch, docs made true (sticky offsets per theme,
  coin cross-links, `useDeskKill` and `KillSwitchDialog`, same APPROVE dialog on Desk
  and Cockpit, stale comments, docs).
- [x] PR 2: code dedupe, no IA change (one `format.ts`, shared transport helpers, one
  SSE reader, shared state ladders and desk types).
- [x] PR 3: MARKET and RESEARCH families on `SectionTabs` (10 cells to 6; `/overview`
  redirects to `/markets`; `/sectors` gets one selection).
- [x] PR 4: one TRADE front (6 cells to 5, tab order Intel to Act), ENGINE on
  `SectionTabs`, `useApi`/`usePoll` fixed and `AsyncBody` ladders, agents get intel and
  platform read tools. Type-scale codemod and `check:type-scale` done. Deferred: the
  `runToolLoop` extraction (see `docs/CONSOLIDATION.md`).

MOVES (`/moves`, first MARKET tab; attribution, positioning, triage, agent records), deferred past v1:

- [x] Make MOVES the landing (2026-11-11): `rootRedirect` (`src/ui/lib/research.ts`) and the Login default;
  the board moved to `/board`. Superseded the same day by stage 2: the landing is `/queue`.
- [ ] Approve or any order action on MOVES (links only in v1).
- [ ] HIP-3 dexes and non-crypto coins (main-dex crypto only); agents watching HIP-3.
- [ ] Microstructure as an attributed layer (spread and depth stay in the Cockpit cost model).
- [ ] OKX hourly OI as a fallback when no scanner runs; a liquidation-volume feed.
- [ ] Intercept (alpha) reporting; per-window beta re-estimation for 4h windows (or 4h returns over 30 days).
- [ ] Elfa trend history.
- [ ] Multi-step agent tool loops (the analyst loop with moves read tools; an ASK read tool `moves_records`).
- [ ] Telegram push of triage items (through `routeFor` / materiality, rare).
- [ ] Graded agent records as a fourth evidence kind on the board; agents proposing Lab definitions from
  repeated layers.
- [ ] A replay or event study of the ENTER/FADE checklists: news is not a Lab metric, so ENTER stays untested.
- [ ] Combined Hyperliquid weight budget: MOVES (400), the replay (600), the crawler (500) and the scanner add up to
  more than the guard's 1000. Each job now counts only its own calls (`createHlShare`), so none is locked out, but
  with all of them busy the guard makes them queue and the crawler, which yields first, polls less.
- [ ] Without a database the OI history is boot-local, so the flow layer is `partial` for the first 48 h, and
  agent records and triage are lost on restart.
- [x] "no news in window" without a news feed (2026-11-11): the news layer is known only while the feed is being
  ingested (a feed event in the last 24 h); otherwise news is unknown everywhere it is derived and no auto-investigation
  runs on it (docs/SPEC.md § Moves M0, M3, M4). The queue's moves-run age reads two columns, not the run's body.
- [ ] Production's Intel ingest has never run (`intel_events` empty): until `POST /cron/intel/ingest` runs,
  every moves row reads `news unknown` and auto-investigation is off (INVESTIGATE and the routine still work).
- [ ] News feed evidence is a 24 h recency check, not window coverage: a feed that started ingesting an hour ago makes
  the 72h window's earlier hours read as "no news". A recorded ingest run (start time) would close this.
- [ ] Cross-link leftovers: Desk alerts carry free text and no coin field, so their coins stay plain text;
  the three `fmtSigned` implementations (`components/intel/format.ts`, `lib/lab.ts`, `lib/format.ts`) differ in
  signature (suffix vs unit argument, default decimals 1 / 2 / 0), so they were not unified.

Research terminal follow-ups (docs/RESEARCH.md; each changes live scanner output, applied migrations
or study semantics, so each needs its own change):

- [ ] Scanner funding windows. Event studies run 2026-11-10 (8 majors, 2025-06-29 to 2026-11-09, 3-day
  hold, 1.5/3 ATR, net of fees and funding; six rules tested, so read each as one of six):
  fading high funding is flat on every window (z7 >= 1.5: +0.04R, 63 events, 4 of 8 coins loaded;
  z14 >= 2: 0.00R, 70 events; z30 >= 2: +0.09R, 55 events, 19 weeks, insufficient). Longs after low
  funding: z7 < -1.5 +0.06R (267 events), z14 < -2 +0.02R (161), z30 < -2 +0.18R (138 events, 46 weeks,
  holdout +0.18R on 37 events). Nothing here supports a 7 d / 14 d funding feature in the scanner, so
  the stored `funding` table is not loaded into the tick. The 30-day low-funding long is the one
  result worth re-testing on more coins before it is used; it is a daily condition (novelty / Lab
  catalogue), not an intraday one.
- [ ] Event studies without a database fetch about 500 days of hourly funding per coin from HL and the
  weight guard allows about one coin a minute, so a multi-coin study cannot finish inside the 50 s
  tool deadline. With `DATABASE_URL` the stored tables are used. Partly addressed (2026-11-11): the ht
  provider keeps each coin's live settlements in process and later fetches only what it lacks, so a
  second study (or the scan) in the same process is fast; the first one per coin is not, and nothing
  survives a restart. `bun run signals:study` runs without the deadline.

Signals v2 follow-ups (docs/RESEARCH.md "Signals v2"):

- [x] Short breakouts have no daily definition: `range_breakdown` (2026-11-11); a short `vol_expansion_breakout`
  opportunity carries it.
- [x] The live definition scan needs a database: without `DATABASE_URL` it runs in the background on live
  Hyperliquid and OKX data (2026-11-11); `bun run signals:scan` runs it once.
- [x] Definitions thin (two conditions): up to four conditions and `vchg` restore the price and funding parts of
  B.4 (2026-11-11). Still dropped: the 4 h triggers, liquidation z, ATR-scaled distance to the 20-day mean.
- [x] OI definitions could not be studied (`ht:oi` is weeks deep): they read `okx:oi` (2026-11-11).
- [x] A partial day of funding is not detected by the scan: the ht provider leaves out a last day without its
  23:00 UTC settlement (2026-11-11).
- [ ] `okx:oi` is OKX's book, not Hyperliquid's. Replace it with `ht:oi` once the collector holds a year of daily
  OI for the universe (needs ≥ 30 event-weeks per definition), or compare the two over the overlap first.
- [ ] Event-study results of the definitions (`bun run signals:study`) are not yet read into thresholds; they stay
  starting points until a decision is made on the numbers. First run (2026-11-11, no database, 17 of the top 20
  coins): without a database live funding stops at 500 days (`LIVE_FUNDING_PAGES`), so the period is 2025-06-30 →
  2026-11-10 and the OI and funding definitions are `insufficient` (< 30 event-weeks; `funding_fade` 6 events).
  Re-run with `DATABASE_URL` (funding from 2023, OKX OI from Feb 2024) before reading anything into them.
- [x] Intraday replay (RESEARCH.md S5, backend shipped 2026-11-11): the UI (shipped). Render
  `GET /api/research/setups/replay` on `/lab/study` under the DEFINITIONS picker (states `pending`, `unavailable`
  with reason, `ok`; not-evaluable rows with their reason, never as 0).
- [ ] `crowded_long`, `negative_funding_squeeze` and `deleveraging_washout` read `oiChg1hZ` and stay unreplayable
  until intraday OI is stored at a 15-min or finer cadence: HL serves no OI history, and production `scan_snapshots`
  hold about 4 ticks a day (scanner run from a cron). An always-on scanner writes 288 a day; with
  `PLATFORM_SCAN_RETENTION_DAYS` (30) the `snapshots` replay then covers them after a few weeks.
- [ ] Production scanner cadence: the intraday setups cannot fire at about 4 ticks a day (the features need 96); the
  board's `opportunity` source says so. Run the always-on server (`bun start`) or tick at least every 15 min.
- [ ] The candle replay charges no slippage (no historical book) and reads funding up to an hour late; per-coin
  slippage from the live cost model's typical `l2Book` walk would tighten the net numbers.
- [x] Review fixes to Signals v2 / S5 (2026-11-11): snapshot replay grades jittered timestamps (exit tolerance one
  persist step plus a minute); the replay yields to the event loop, the snapshot source is capped (top N, 14 days)
  and signed-in only; a candle replay whose fetches failed is a failed run, not zeros; replay and the no-database
  scan answer `unavailable` on Vercel; the scan's retry window runs from completion, unlisted coins are dropped for
  the day and scans never overlap at 00:00 UTC; `okx:oi` is collected and read stored; a deadline-cut study is not
  cached; live funding's left extension is capped to the cold span.
- [ ] Hyperliquid weight contention: the replay's own fetches stay under 600 of the guard's 1000 per minute
  (`REPLAY_HL_BUDGET`, `createHlShare`), but the no-database definition scan (and Lab studies) still share the full
  budget with the live scanner, so a cold scan can delay a scanner tick by up to a minute on the guard. A per-caller
  share for the scan needs a seam through the Lab loader (`HtDeps.liveFunding` / `liveCandles`) that only the scan
  uses; not done.
- [ ] A study retried after a deadline cut (not cached, by design) counts another Lab trial: the Lab records one per
  `lab_event_study` call. With `okx:oi` collected the cut is rare; counting at most one trial per study key and day
  would need the study key passed into the Lab tool.
- [ ] Live, an idea the scanner does not cost (beyond `PLATFORM_COST_TOP_N`, or no book) stays `new`, never expires
  and blocks re-fires of its key; the replay assumes every idea costed (a test shows the divergence). Expiring or
  costing such ideas is a scanner change, not made here.

Radar routine (2026-11-02): the 4 h setup board is retired (24 setups, all low conviction, −1.77R; it
never saw news, sectors or HIP-3). `ROUTINE.md` became a twice-daily radar (the runbook was removed on 2026-11-14): `bun run radar` scans every
dex, the session researches catalysts and lands at most 3 graded calls in `data/radar/`.

- [ ] After 2 weeks of radar notes: delete the board pipeline (`tripwires.ts`, `gate.ts`, `scan.ts`,
  `htf.ts`, the scan prompts, `review.ts` and their scripts). Keep `routine/ledger.ts` (used by
  `src/server/setups/store.ts`), `routine/llm.ts` (used by `platform/universe.ts`, `lab/service.ts`) and
  `runDate` (used by `scripts/radar.ts`).
- [ ] After 4 weeks: read `bun run radar score`. If rides and fades do not beat a plain 7d-momentum pick,
  tighten §3 of the runbook or cut the session to the catalyst sweep only. Review the macro bar (§3
  condition 5, `MACRO` in `src/server/radar/macro.ts`): compare calls landed with >= 3 risk-off tells or an
  FOMC/CPI/NFP inside their window against the rest.
- [ ] `collectors/cryptoContext.ts` computes the Deribit DVOL window at module load, so a warm process asks for
  a stale window.
- [ ] Collect Data: alarm on consecutive spilled runs instead of spill age (`routes/cron.ts` SPILL_ALARM_MS);
  GitHub runs the */15 schedule every 3–7 h, so wall-clock age fires on a scheduler gap.

Routine redesign (2026-10-23, `docs/fallback-routine.md`, superseded by the radar above): the 4 h routine is a board scan of the
top-30 perps on 4h/1d/1w with tripwires (the commonplace setups as thresholds), a level menu, and the
model as the interpretation layer that names imbalances and writes setups by level key; code resolves
prices, R, alignment and expiry, then gates. MarketState/Sectors daily, Lab search weekly. It ships the
scan-side parts of phases 1–3 below from HL directly instead of stored tables, and departs from § B.8:
the model creates setups, from code-built levels only.

- [ ] Grade the tripwire thresholds: an event study per template on the board's own features
  (needs the board history to accumulate, or a replay from stored candles and funding).
- [ ] Per-template outcome stats in the ledger brief (`setup_id`, `timeframe` now ride on every setup).

Candidate pipeline, per `docs/research/candidates-redesign.md` § B.12. Swing-only
setups, candidate universe = top 30 by 24 h notional plus "my markets".

- [x] Phase 0: one setup shape (`src/shared/setups.ts`: `setup_id`, `levels_source`,
  swing-only), setups store with memory and pg twins (migration 021,
  `src/server/setups/store.ts`), `bun run setups:export` to `data/setups/ledger.json`,
  gate expiry cap 10 days.
- [ ] Phase 1: daily/4 h feature frame from stored tables, with parity against novelty
  `funding_z90` and Lab `ht:funding`. Partly shipped by Signals v2 (docs/RESEARCH.md S2,
  2026-11-10): the daily frame is the Lab's own features (`ht:*` through the Lab dataset
  loader), so `ht:funding` parity holds by construction. Volatility-scaled returns ship as the Lab
  transform `vchg` (2026-11-11; w-day sigmas, not ATR). Not shipped: the 4 h frame, liquidation and
  sector features, and the novelty `funding_z90` parity test.
- [ ] Phase 2: catalogue definitions as data plus level builder, each with a Lab rule
  twin; scanner hits equal event-study entries. Partly shipped by Signals v2 (S1–S3): six
  definitions as Lab rules (`src/server/signals/definitions.ts`), the live scan with the
  replay parity test, the board's `definition` source. Not shipped: the level builder, 4 h
  triggers and entry zones, `sector_continuation` (needs sector features the Lab lacks), and
  the B.4 conditions a Lab rule still cannot say (listed in docs/RESEARCH.md S1; rules hold four
  conditions since 2026-11-11). The UI (S4) shipped 2026-11-10.
- [ ] Phase 3: `bun run candidates` and `candidates:advance`, budget gate, one LLM
  narration call, routine writes through the setups store.
- [ ] Phase 4: workflows, the routine runbook as a thin wrapper (the runbook was removed on 2026-11-14), narrative job split out,
  duplicate collectors removed.
- [ ] Phase 5: weekly review job: event-study refresh, demotion to watch-only, edge
  facts on candidates.

## Completed

**Phase 9, signal evidence (`docs/FEATURES.md` §§ 1–7), PS1–PS7 and PS-B1..B5.** Lab rule
authoring from intent with a global, append-only trial counter (`lab_author_rule`,
migration 014); clustered ledger stats (`clusters`, t-interval on cluster means, null
below 5 clusters); a Lab event-study screen with replay parity test
(`src/server/lab/engine/eventStudy.ts`); a facts-only evidence line on platform alerts;
a novelty detector with journal and cooldown (migration 015); thesis watch with
transitions and a "no longer holds" alert; an ntfy channel and macro label tag. Backlog
items B1..B5 shipped too: platform setups as `SetupSchema` data
(`src/server/platform/setups.ts`), near-miss "why not" (`GET /api/platform/near-miss`),
the condition funnel in `lab_event_study`, stop/target/invalidation expressions and
categorical regime conditions on Lab rules, and universe filters (top-N liquidity,
sector, "my markets"). Rule throughout: signals carry facts (n, clusters, interval, trial
count), never a verdict; nothing nags.

Earlier phases (v1 app, v2 semantic simulation chat, platform P1–P4, Intel, Flow, Scout)
are done and recorded in the contracts: `docs/SPEC.md` and `docs/design/`.

## History

`TASKS.v1.md`, `TASKS.v2.md`, `TASKS.platform.md` and the earlier root `TASKS.md` (Intel,
Flow, Scout, the full phase 9 task list) were deleted in `8858b3a`. Show one with
`git show 8858b3a^:TASKS.v1.md`; the history of this file is `git log --follow docs/TASKS.md`.
