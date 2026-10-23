# Tasks

Current and open work only. Completed phases are summarised below; their full task
lists live in git history (see History).

## Open

Routine redesign (2026-10-23, `docs/fallback-routine.md`): the 4 h routine is a board scan of the
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
count), never a verdict; nothing places orders, gates the operator or nags.

Earlier phases (v1 app, v2 semantic simulation chat, platform P1–P4, Intel, Flow, Scout)
are done and recorded in the contracts: `docs/SPEC.md` and `docs/design/`.

## History

Deleted task files, recoverable at the last commit that touched them:

| File | Last commit |
|---|---|
| `TASKS.v1.md` | `13f699d` |
| `TASKS.v2.md` | `848b291` |
| `TASKS.platform.md` | `c307e82` |
| earlier phases of this file (Intel, Flow, Scout, full phase 9 task list) | `git log --follow docs/TASKS.md` |

Show one with `git show <sha>:TASKS.v1.md`.
