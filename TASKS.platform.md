# TASKS — Platform phase 8 (scanner + cockpit)

Harness: Claude Code. Planner: claude-opus-5-5 @ medium. Native subagents only (no bridges).
Worktree: `.claude/worktrees/platform-p1`, branch `feat/platform-p1` off `feat/flow-scout` 74511ec.
Gate baseline: typecheck ok, `bun test src` 1404 pass / 6 skip / 0 fail, build ok, check:api ok (bun 1.4.3).

| Role | Model @ effort |
|---|---|
| designer | fable @ medium |
| heavy (L3 only) | opus @ medium |
| worker | sonnet @ medium |
| ui-impl | fable @ medium |
| grunt | haiku @ high |
| reviewer | sonnet @ medium (fresh context; opus @ medium for review-risk on T1) |
| scout | haiku @ high / sonnet @ medium for 10+ files |

**Destination:** SPEC.md § Platform P4 Done is green, on one always-on Railway service.

## Decisions so far
- 2026-10-16: extend hypertrade; Railway one service (API + dist + loops); Supabase stays; no Redis/Timescale this phase; Vercel retired at cutover.
- 2026-10-16: Phase 1 scope only; paper/testnet; PGlite for Postgres-only tests (no local Pg/Docker).
- T0 done (489645f): cockpit at `/`, Terminal at `/terminal`; Recharts live profile + canvas time×price; long=blue, short=yellow; coverage <25% degrades. Contract gaps sent to T1: feed row adds direction/setupKind/tier/createdAt; ticket levels on opportunity, size only from governor preview; liqmap fixed log-price grid; health adds LLM spend, loop intervals, store kind; status filter comma list.

## Tasks
| ID | Task | Level | Role | Deps | Status |
|---|---|---|---|---|---|
| T0 | Design brief: DESIGN-terminal.md § Cockpit | L2 | designer | — | todo |
| T1 | Data layer: contracts `src/shared/platform.ts`, `011_platform.sql`, `db/migrate.ts`, `PlatformStore` (memory + pg) incl. ledger append helpers, `bus.ts`, `DB_POOL_MAX`, PGlite test | L3: schema/migration design + ledger data integrity | heavy | — | todo |
| T2a | Pure: opportunity status machine + dedupe, outcomes math, stats, liqmap aggregation (+ tests) | L2 | worker | T1 | todo |
| T2b | Pure: features, costs (book walk), score (wraps diff.ts), crawler priority (+ tests) | L2 | worker | T1 | todo |
| T3 | Runtime: `scripts/server.ts`, `runtime.ts`, health extension, desk loops moved, `Dockerfile`, scripts; `shared/hl-ws.ts` lift; `ws.ts` + `addresses.ts` | L2 | worker | T1 | todo |
| T4 | Loops: scanner, crawler, liqmap snapshots, outcomes loop, prune, alerts, freshness gate | L2 | worker | T2a, T2b, T3 | todo |
| T5 | Routes `/api/platform/*` + route tests; approve via desk/governor | L2 | worker | T2a, T2b | todo |
| T6 | Cockpit UI at `/`, Terminal to `/terminal` | L2 | ui-impl | T0, T1 | todo |
| T7 | README Railway section | L1 | grunt | T4 | todo |
| G | Verification gate: review lenses, feature-finalizer, ponytail-review, drift-check, full CI + live smoke | — | reviewer | all | todo |
