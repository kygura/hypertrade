# Tasks — Intel (LLM trading tools)

Harness: Claude Code (remote). Planner: claude-opus-5-5. Evidence: ~/.agentic-build/evidence.md (DeepSWE v1.1: Opus 5 74 / $11.84, Fable 5 70 / $13.41, Sonnet 5 54 / $26.40; Haiku no row).
Roster: fable, opus, sonnet, haiku — all Anthropic, native Agent tool, no bridges. Provider diversity impossible; reviewer = different family from implementer.

| Role | Model | Effort | Note |
|---|---|---|---|
| planner | opus (self) | — | fixed |
| discussion | fable | default | different family from planner |
| designer | opus | default | degraded: no visual-lane evidence |
| heavy | opus | default | top logic score, cheapest within 4 pts |
| worker | opus | default | cheapest within 4 pts of best (sonnet dominated: lower score, higher cost) |
| ui-impl | opus | default | same family as designer |
| grunt | haiku | default | unverified, bounded tasks only |
| reviewer | fable (opus work) / opus (haiku work) | default | different family |
| drift-check | haiku | low | no visual evidence anywhere |

Destination: `/` becomes the Intel Terminal (SPEC.md § Intel): all eight modules of the LLM trading tools brief, wired end to end, tested, typecheck/build green.

## Tasks
- [x] P0 Plan — SPEC.md § Intel, src/shared/claims.ts, TASKS.v2.md archived — opus (planner) + fable second opinion
- [ ] D1 Design pass → DESIGN-terminal.md — opus — frontier
- [ ] T1 Contract: 007_intel.sql, src/shared/intel.ts (all API types), IntelStore (Pg + Memory), positions.ts — opus — frontier
- [ ] T2 LLM: completeStructured + cache + trace + cap, provider web-search opt-out, claims validator — opus — frontier
- [ ] T3 Governor refactor: evaluateRisk + DeskService.submitOperatorOrder — opus (heavy) — frontier
- [ ] T4 Snapshot store + normalize/diff + terminal brief + collect/backfill hooks — opus — deps T1, T2
- [ ] T5 Graph + cluster + ingest adapters + calendar — opus — deps T1, T2
- [ ] T6 Mapper + priced-in + catalysts + feedback + notify — opus — deps T4, T5
- [ ] T7 Journal — opus — deps T1, T2
- [ ] T8 Theses + screener — opus — deps T4
- [ ] T9 Copilot — opus — deps T1, T2, T3
- [ ] T10 Docwatch — opus — deps T6
- [ ] T11 Routes + cron wiring + workflow + api mount + auth READ_PATH — opus — deps T4–T10
- [ ] U1 UI shell: routes, nav, TerminalTabs, lib/intel.ts — opus (ui-impl) — deps D1, T1
- [ ] U2 Terminal page — opus (ui-impl) — deps U1
- [ ] U3 Journal + Theses + Query pages — opus (ui-impl) — deps U1
- [ ] U4 Order + Watch pages — opus (ui-impl) — deps U1
- [ ] T12 README + DESIGN.md §5/§10.2/§13 touch-ups — haiku — deps U2–U4
- [ ] V1 Verification gate — reviewers (fable), drift (haiku), tests/typecheck/build/check:api

## Decisions so far
- P0: baseline 769 pass, typecheck green. Workers do not commit; planner commits per task with explicit paths. Native Claude workers only.
- P0 (fable second opinion adopted): snapshot written inside /cron/collect; metric-specific normalization (price/OI hourly-σ scaled, funding/premium level z, volume/depth log-ratio); separate leased cron routes gated by INTEL_ENABLED; reuse DESK_WATCH_ADDRESS + Desk model resolution; static macro calendar; only UI open logs a review; governor refactored into evaluateRisk, copilot via submitOperatorOrder (always confirm); DSL-only screener; real routes for sub-tabs.
