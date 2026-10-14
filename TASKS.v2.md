# Tasks
Destination: Paths — semantic simulation chat in /analyst SIMULATE mode: loose intent → zod SimIntent → runIntent adapter → extended branch engine → PathCards with save-as-branch (SPEC.md § Paths)

## Tasks
- [x] T0 Plan — SPEC.md § Paths, branch feat/semantic-sim-chat, TASKS.v1.md archived — model: opus
- [x] D1 Design pass → DESIGN-chat.md — model: opus
- [x] T1 Engine + schema extension: side/leverage perp legs, liquidation on l/h, self-financing DCA — model: opus
- [x] T2 Intent schema + runIntent adapter + shared runBranchConfig (branches route refactor) — model: sonnet — deps: T1
- [x] T3 Sim mode on analyst route: runAnalyst overrides, sim prompt, simulate_paths tool, sim_result SSE — model: sonnet — deps: T2
- [x] T4 /analyst SIMULATE UI: mode toggle, PathCard, save/fork, history trailer — model: sonnet — deps: T3, D1
- [x] T5 /branches/:id editor shows + preserves side/leverage/DCA — model: sonnet — deps: T1, D1
- [x] T6 README "Paths" section — model: haiku — deps: T4
- [x] V1 Verification gate: tests/typecheck/build, review-risk, review-reliability, checker, ponytail-review, drift vs DESIGN-chat.md — model: opus — deps: T1, T2, T3, T4, T5, T6

## Decisions so far
- T0: one engine (additive BranchConfig fields), chat = mode:"sim" on POST /api/analyst/query, UI = toggle inside /analyst (no new page), Desk/paper bridge out of v1, default stack $10k listed in assumptions, MC skipped for perp branches. Second opinion (opus) confirmed; overturned open/close dates (dropped) and /paths page (→ /analyst mode).
- T0: baseline before work: 700 tests pass, typecheck green.
- T0: workers do not commit; planner commits per task with explicit paths. Native Claude workers only (no Codex).
- T1 (opus): stable short/lev check lives on AllocationSchema (BranchConfigSchema stays plain object); liquidation uses same-day l/h only; DCA first buy on first boundary after start, USDC then USDT; DcaSchema exported; 711 tests green.
- D1 (opus): DESIGN-chat.md — ASK|SIMULATE Segmented by title, per-mode sessions (sim keeps 10 turns); PathCard above narration, DataTable compare + selected-branch detail (no multi-line overlay); amber warnings, per-row red errors; SAVE AS BRANCH writes assumptions into description + fires /run; FORK prefills `Fork "<name>": `; editor SIDE/LEV/DCA editable, DCA locks rebalance NONE, perp leg blocks projection; DataTable gets optional isSelected prop. No new tokens.
- T2 (sonnet): runIntent(intent: unknown, deps) → SimRunResult | {error} (never throws, per-branch errors); run.ts runBranchConfig + simulateLoaded; SimIntentSchema strict incl. BranchConfigSchema.strict(); branches route uses runBranchConfig. 722 green.
- T5 (sonnet): BranchDetail SIDE/LEV/DCA editable, DCA locks rebalance NONE, perp+scenario disables RUN/SAVE; hasPerpLeg + allocationSummary in format.ts. Not browser-rendered yet.
- Resume note: network outage mid-run; T2/T5 had actually finished — verified 722 green + typecheck before commit.
- T3 (sonnet): runAnalyst {system, tools, runTool(call)} overrides; sim_result {id=tool call id, intent, branches} before tool_result; 40s deadline; maxLeverage from cached HL universe (getCtxs) w/ fallback; JSON-schema↔zod parity test. History "[paths]" trailer is produced UI-side (T4). 727 green.
- T4 (sonnet): components in src/ui/components/paths/ (PathCard, SaveBranchButton); queryBody sends mode only for sim; downsample ≤200 pts + compactSim before persist; quota → drop oldest turn. Not browser-checked.
- V1 loop 1 findings: risk HIGH (horizonDays unbounded sync MC, backfill not deadline-bounded / runs after timeout, unbounded allocations+junk coins) MED (Infinity/negative numbers, raw err.message leak) LOW (case-collapse dup coins, realSimDeps no timeout); reliability CRITICAL (DCA+rebalance double-counts DCA-only coin, nested objects not strict → unknown key silently dropped) + dca:[] warn, neg weights, empty grid, test gaps.
- T6 (haiku): README "Paths (simulate mode)" section.
- V1 loop 1 fixed (opus): horizonDays≤3650, real deadline threaded into backfill, ≤10 allocations + coin regex + HL-universe resolve (unknown coin → branch error pre-backfill), finite/range numbers, sanitized errors, DCA-only coins excluded from rebalance, strict nested schemas globally, dca:[] dropped, empty grid → "no price history in range" (422 on route). Dup-coin error only for two spot legs (spot+short hedge allowed). 751 green.
- V1 drift: no MUST-FIX. checker: raw-float weights, toHistory drops text-less sim turns (trailer lost), /run fire-and-forget vs OPEN, cron backfill ignores dca coins, fork prefix stacking.
- V1 ponytail-review: shared isPerp/STABLES, duplicate session stores, dup MAX DD, hint trimming (rejected: spec-review wants caps in hint). standards/spec review: legacy stored config → 500 on /run after stricter schema; hint missing caps. Loop 2 delegated (sonnet).
- V1 loop 2 (sonnet): /run safeParse → 422 on legacy config, hint caps, cron backfills dca coins, text-less sim turns keep [paths] trailer, save awaits /run, fork prefix replaced, weights rounded, isPerp/STABLES shared in schemas.ts, stable SIDE title. Loop 3 (sonnet): reverted two loop-2 regressions (module-level session cache restored per mode; DRAWDOWN header MAX DD restored per design).
- V1 gate: 754 pass (one unidentified flaky failure in a loaded 42s run; 3 reruns green), typecheck + vite build green (pre-existing chunk-size warning). Not browser-rendered (needs DB + LLM keys).
