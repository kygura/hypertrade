# Tasks

Current and open work only. Completed phases are summarised below; their full task
lists live in git history (see History).

## Open

Carried from the v1 task list; `docs/PROP.md` references them as T13–T15. Status as
last recorded there: open.

- [ ] T13 Journal DB + routes (trades, sessions, accounts per `docs/PROP.md` §(e)), CRUD + `/stats`, tests.
- [ ] T14 Journal UI: daily check-in, plan-before-trigger form, sizing calculator (`docs/PROP.md` §(b)), setup picker limited to the §(c) ledger, server-computed lockout banner, venue tag paper/eval/live.
- [ ] T15 Gate page: `docs/PROP.md` §(f) checklist computed from the paper record; stays red until cleared; weekly per-setup expectancy review.

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
