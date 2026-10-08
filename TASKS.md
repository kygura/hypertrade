# Tasks
Destination: Paths — semantic simulation chat in /analyst SIMULATE mode: loose intent → zod SimIntent → runIntent adapter → extended branch engine → PathCards with save-as-branch (SPEC.md § Paths)

## Tasks
- [x] T0 Plan — SPEC.md § Paths, branch feat/semantic-sim-chat, TASKS.v1.md archived — model: opus
- [ ] D1 Design pass → DESIGN-chat.md — model: opus
- [ ] T1 Engine + schema extension: side/leverage perp legs, liquidation on l/h, self-financing DCA — model: opus
- [ ] T2 Intent schema + runIntent adapter + shared runBranchConfig (branches route refactor) — model: sonnet — deps: T1
- [ ] T3 Sim mode on analyst route: runAnalyst overrides, sim prompt, simulate_paths tool, sim_result SSE — model: sonnet — deps: T2
- [ ] T4 /analyst SIMULATE UI: mode toggle, PathCard, save/fork, history trailer — model: sonnet — deps: T3, D1
- [ ] T5 /branches/:id editor shows + preserves side/leverage/DCA — model: sonnet — deps: T1, D1
- [ ] T6 README "Paths" section — model: haiku — deps: T4
- [ ] V1 Verification gate: tests/typecheck/build, review-risk, review-reliability, checker, ponytail-review, drift vs DESIGN-chat.md — model: opus — deps: T1, T2, T3, T4, T5, T6

## Decisions so far
- T0: one engine (additive BranchConfig fields), chat = mode:"sim" on POST /api/analyst/query, UI = toggle inside /analyst (no new page), Desk/paper bridge out of v1, default stack $10k listed in assumptions, MC skipped for perp branches. Second opinion (opus) confirmed; overturned open/close dates (dropped) and /paths page (→ /analyst mode).
- T0: baseline before work: 700 tests pass, typecheck green.
- T0: workers do not commit; planner commits per task with explicit paths. Native Claude workers only (no Codex).
