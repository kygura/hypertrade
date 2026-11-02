# Tasks

Current and open work only. Completed phases are summarised below; their full task
lists live in git history (see History).

## Open

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

Radar routine (2026-11-02): the 4 h setup board is retired (24 setups, all low conviction, −1.77R; it
never saw news, sectors or HIP-3). `ROUTINE.md` is now a twice-daily radar: `bun run radar` scans every
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
  `funding_z90` and Lab `ht:funding`.
- [ ] Phase 2: catalogue definitions as data plus level builder, each with a Lab rule
  twin; scanner hits equal event-study entries.
- [ ] Phase 3: `bun run candidates` and `candidates:advance`, budget gate, one LLM
  narration call, routine writes through the setups store.
- [ ] Phase 4: workflows, ROUTINE.md as a thin wrapper, narrative job split out,
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
