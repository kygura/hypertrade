# TASKS — hypertrade build map

**Destination**: HYPERTRADE deployed on Vercel — portfolio/branch simulator, sector intelligence, MarketState briefing, behind a password, per SPEC.md.

## Decisions so far

- Three repos explored (hyperion = design system + HL client; marketwatch = series store/regime/stats; marketstate = fetchers + prompt corpus). Hyperion's branches engine was removed as dead code → simulator rebuilt fresh.
- Vercel + Supabase Postgres + GitHub Actions cron (Hobby cron is daily-only). App makes no LLM calls; cloud routine commits data/ files, push = redeploy.
- Single package, bun, Vite+React19+Tailwind4 front, Hono catch-all function back, layout pinned in SPEC.md.
- T0 done: git repo at app/, identity set locally.
- T1 done (haiku): scaffold committed; planner fixed emitted-artifact leak (tsconfigs now noEmit, build = typecheck && vite build, verified green). React 19.2.8, vite 6, tailwind 4, hono 4.7.
- T4 owns api/index.ts edits in wave 2; T5/T6/T7 route mounting will be staggered to avoid conflicts.

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
| T7 | Routine contract: ROUTINE.md (port marketstate prompt corpus + schemas), data/ seed examples, sectors/marketstate/trigger routes | sonnet | T2 | frontier |
| D1 | DESIGN.md — Fable design pass: iterate Hyperion language, solve mobile, all views in SPEC | fable | T0 | done |
| T8 | UI foundation: index.css tokens per DESIGN.md, shell/nav, router, login page, api client hook, state vocabulary components | sonnet | D1,T1 | done (planner added GET /auth/me + shell session probe) |
| T9 | UI Overview + Markets views (metrics strip, marketstate card, HL table, candle chart) | sonnet | T8,T5 | open |
| T10 | UI Branches views (list, editor, equity/drawdown/projection charts) | sonnet | T8,T6 | open |
| T11 | UI Sectors + MarketState views (treemap/grid, rotations, briefing, history, trigger) | sonnet | T8,T7 | open |
| V1 | Verification gate: build/tests, feature-finalizer, review-risk + review-reliability, ponytail-review, mp-standards-spec-review, design-drift check, fix loops (max 3) | mixed | all | open |
| V2 | Provision Supabase, apply migrations, vercel deploy, envs, smoke test | — (planner+MCP) | V1 | open |
