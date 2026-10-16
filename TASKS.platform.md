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
- T1 done (75d0b75), 1413 pass. T2a done (6ec6111), 1443 pass.
- T1 risk review (opus): 7 findings. Fix round sent to T1: rescans only pre-decision; decision entry snapshots what operator saw; JSON-safe payloads (no NaN/∞); no migrate baseline; advisory lock; costs only pre-decision; parity on invalid input; `statusChangedAt` for expiry. Finding 7 (app runs as table owner → can disable trigger) → README: run app as non-owner role.

## Tasks
| ID | Task | Level | Role | Deps | Status |
|---|---|---|---|---|---|
| T0 | Design brief: DESIGN-terminal.md § Cockpit | L2 | designer | — | done |
| T1 | Data layer: contracts `src/shared/platform.ts`, `011_platform.sql`, `db/migrate.ts`, `PlatformStore` (memory + pg) incl. ledger append helpers, `bus.ts`, `DB_POOL_MAX`, PGlite test | L3: schema/migration design + ledger data integrity | heavy | — | done |
| T2a | Pure: opportunity status machine + dedupe, outcomes math, stats, liqmap aggregation (+ tests) | L2 | worker | T1 | done |
| T2b | Pure: features, costs (book walk), score (wraps diff.ts), crawler priority (+ tests) | L2 | worker | T1 | done |
| T3 | Runtime: `scripts/server.ts`, `runtime.ts`, health extension, desk loops moved, `Dockerfile`, scripts; `shared/hl-ws.ts` lift; `ws.ts` + `addresses.ts` | L2 | worker | T1 | done |
| T4 | Loops: scanner, crawler, liqmap snapshots, outcomes loop, prune, alerts, freshness gate | L2 | worker | T2a, T2b, T3 | done |
| T5 | Routes `/api/platform/*` + route tests; approve via desk/governor | L2 | worker | T2a, T2b | done |
| T6 | Cockpit UI at `/`, Terminal to `/terminal` | L2 | ui-impl | T0, T1 | done |
| T7 | README Railway section | L1 | grunt | T4 | done |
| G | Verification gate: review lenses, feature-finalizer, ponytail-review, drift-check, full CI + live smoke | — | reviewer | all | in progress (fix loop 1: F1–F3, then F4 UI) |
- Gate loop 1 (2026-10-16): CI green (1550 pass), live smoke green (crawler 400/min, BTC map 43 buckets). 7 lenses → ~50 findings. Fix wave: F1 heavy (failed status, reject only from ready, reconcile stuck approved + open→closed, desk preview+submit lock, outcome unique index, health redaction, Supabase anon/RLS), F2 (gap-normalized rv for restart blindness, cooldown, late horizons via candles, stats exclude uncosted, coverage /2·OI, fin helper), F3 (bind before boot, no pool release in long-running, crawler 500 + per-poll guard, WS stale/backoff/stagger, alert hysteresis, non-root Docker, LLM spend). F4 UI next: always-on liquidation panel + board when feed empty, warming-up, failed pill, server cluster rule, detail raw inputs. F1–F3 hit a session rate limit mid-run and were resumed.
