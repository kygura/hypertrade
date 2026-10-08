# TASKS — hypertrade build map

**Destination**: HYPERTRADE deployed on Vercel — portfolio/branch simulator, sector intelligence, MarketState briefing, behind a password, per SPEC.md.

## Decisions so far

- Three repos explored (hyperion = design system + HL client; marketwatch = series store/regime/stats; marketstate = fetchers + prompt corpus). Hyperion's branches engine was removed as dead code → simulator rebuilt fresh.
- Vercel + Supabase Postgres + GitHub Actions cron (Hobby cron is daily-only). App makes no LLM calls; cloud routine commits data/ files, push = redeploy.
- Single package, bun, Vite+React19+Tailwind4 front, Hono catch-all function back, layout pinned in SPEC.md.
- T0 done: git repo at app/, identity set locally.
- T1 done (haiku): scaffold committed; planner fixed emitted-artifact leak (tsconfigs now noEmit, build = typecheck && vite build, verified green). React 19.2.8, vite 6, tailwind 4, hono 4.7.
- T4 owns api/index.ts edits in wave 2; T5/T6/T7 route mounting will be staggered to avoid conflicts.
- V1 accepted deviations (documented, not fixed): HistoryStepper is server-backed (T7's static-import index design supersedes DESIGN.md's build-time glob); text-[Npx] arbitrary values match the closed type scale (convention-enforced, refactor not worth churn); /metrics/series/:id has no UI caller yet (SPEC surface for later); recharts chunk size warning (code-split later); no dependency audit run (sandbox blocks registry — rely on Dependabot post-push).

## Tasks

| # | Task | Model | Depends on | Status |
|---|------|-------|-----------|--------|
| T0 | git init, initial commit of SPEC/TASKS | — (planner) | — | frontier |
| T1 | Scaffold: package.json, vite+tailwind4+geist, api/index.ts Hono hello, vercel.json, tsconfig, .env.example, .gitignore, README stub, .github/workflows/collect.yml | haiku | T0 | frontier |
| T2 | Shared libs port: src/shared/{types,schemas,stats,baseline,format,hl-client}.ts adapted from source repos + tests | sonnet | T1 | done |
| T3 | DB: db/migrations/001_init.sql per SPEC schema + src/server/db.ts (postgres.js) + query helpers | opus | T1 | done |
| T4 | Auth: src/server/auth.ts + routes, HMAC cookie session, middleware + tests | opus | T1 | done |
| T5 | Collectors: hyperliquid/cryptoContext/fred ports + cron route + metrics routes (summary/series) + tests | sonnet | T2,T3 | done |
| T6 | Branch simulator: candles backfill (coingecko+HL), engine (equity/drawdown/CAGR/benchmarks/monte-carlo), branches routes + tests (TDD) | sonnet | T2,T3 | done (V1 must re-verify threshold-rebalance test math + montecarlo blend) |
| T7 | Routine contract: ROUTINE.md (port marketstate prompt corpus + schemas), data/ seed examples, sectors/marketstate/trigger routes | sonnet | T2 | done (history via static-import index.ts files — Vercel bundling) |
| T7b | All completed routes mounted in api/index.ts by planner; 77 server tests green | — | — | done |
| D1 | DESIGN.md — Fable design pass: iterate Hyperion language, solve mobile, all views in SPEC | fable | T0 | done |
| T8 | UI foundation: index.css tokens per DESIGN.md, shell/nav, router, login page, api client hook, state vocabulary components | sonnet | D1,T1 | done (planner added GET /auth/me + shell session probe) |
| T9 | UI Overview + Markets views (metrics strip, marketstate card, HL table, candle chart) | sonnet | T8,T5 | done (hl route mounted by planner; debts → T12) |
| T11 | UI Sectors + MarketState views (treemap/grid, rotations, briefing, history, trigger) | sonnet | T8,T7 | done |
| T12 | Reconcile+wire: App.tsx routes for Branches/Sectors/State; BranchesCard vs real branch shapes (list route lacks result; fields are cagrPct + {ts,value}); fmtUsd B-suffix + dedupe local fmtCompactUsd; SectorDrillPanel token chips → link /markets/:coin (route exists now) | sonnet | T10,T11 | done (planner fixed maxDdClass magnitude convention) |
| T10 | UI Branches views (list, editor, equity/drawdown/projection charts) | sonnet | T8,T6 | done |
| V1 | Verification gate: build/tests, feature-finalizer, review-risk + review-reliability, ponytail-review, mp-standards-spec-review, design-drift check, fix loops (max 3) | mixed | all | done (1 loop: 2 criticals fixed — z30 n-gate, sim NaN guard; error shapes normalized; ~300 lines dead code removed; fmtPct unit dedupe; OfflineBlock wired; per-token sector table; CI workflow added; sim math independently verified correct) |
| V2 | Provision Supabase, apply migrations, vercel deploy, envs, smoke test | — (planner+MCP) | V1 | **open — app has never been live; routine data stale since 2026-08-30** |
| P0 | PROP.md — prop-trading contract: Breakout rule set, risk framework, setup ledger, session protocol, gates | fable | — | done |
| T13 | Journal DB + routes: `db/migrations/002_journal.sql` (trades, sessions, accounts per PROP.md §(e)), `src/server/routes/journal.ts` (CRUD + `/stats`), tests | sonnet | T3,P0 | open |
| T14 | Journal UI `/journal`: daily check-in, plan-before-trigger form, sizing calculator (PROP.md §(b) formula), setup picker limited to §(c) ledger, server-computed lockout banner, venue tag paper/eval/funded | sonnet | T8,T13 | open |
| T15 | Gate page: PROP.md §(f) checklist computed from paper record; stays red until cleared; weekly per-setup expectancy review | sonnet | T14 | open |
| D1x | Desk (phase 3): agent team (PM + 6 specialists + spawn), flow diagnostics, macro/structure/breadth tools, governor, paper broker, watch tick + triggers, alerts (Telegram/Discord/webhook), Telegram control, `/api/desk/*`, `/desk` page, worker, `003_desk.sql`, tests | opus | T5,T9 | done (paper venue; live testnet in D2x) |
| D2x | Live Hyperliquid broker behind the governor (agent-wallet signing, entry + reduce-only TP/SL, position sync), testnet first | opus | D1x | done (testnet; signing pinned to the Python SDK vectors; mainnet refused) |

## Lab — heuristic research engine (LAB.md)

Destination: an Alpha Lab equivalent (LAB.md) exposed once as a tool registry and served over REST `/api/lab/tools`, MCP `/api/mcp` (HTTP) and stdio, a CLI, and the `/lab` page.

Harness: Claude Code (cloud), native subagents only (no Codex/OpenCode/Pi bridges on PATH; subagent depth 1, so the top session plans). Stack: lead opus · heavy opus · worker opus · designer fable · ui-impl opus · reviewer fable (all implementers are opus). Provider decision: keyless sources only (operator declined a Glassnode key).

| # | Task | Model | Depends on | Status |
|---|------|-------|-----------|--------|
| L0 | LAB.md spec + `src/server/lab/types.ts` contract | planner | — | done |
| L1 | Engine (pure): features, labels, depth-2 forest, rule extraction, backtest, walk-forward/holdout/sensitivity, trial search; planted-signal + noise tests | opus (heavy) | L0 | done (34 tests; 3000d×95 features ≈1.7 s, ×589 ≈8 s; noise bar = WF and holdout Sharpe > 1, 0/12 seeds) |
| L2 | Providers: ht (DB + live HL), cm (Coin Metrics community), fng, llama; registry + `loadDataset` | opus | L0 | done (30 fixture tests) |
| L3a | `004_lab.sql` + LabStore (pg / memory / file) | opus | L0 | done |
| L4a | MCP JSON-RPC core, `/api/mcp`, `/api/lab/tools`, bearer auth, CLI, stdio | opus | L0 | done |
| D2 | DESIGN.md §10.9 `/lab` brief | fable | L0 | done (LAB = 9th nav cell; tabs SEARCH·RUNS·CATALOGUE·PULSE) |
| L3b | Lab service + tool registry (12 tools, autoresearch prompt), catalogue health, pulse; mount in api/index.ts | opus | L1,L2,L3a,L4a | done |
| U1 | `/lab` page per §10.9 | opus (ui-impl) | D2 (built against the pinned tool contract, parallel to L3b) | done |
| V3 | Verification gate: tests/build, reviewer (fable), drift check, fix loops ≤3 | mixed | all | done (1 loop: MCP batch DoS capped, upstream errors → 502 with cause, refusals → 400 unstored, origin allow-list, asset charset, Vercel maxDuration 60; UI: holdout unsortable, WF-only stats, a11y/tokens. 588 tests green) |
