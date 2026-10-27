# CLAUDE.md — hypertrade

Hypertrade is a market-intelligence app for Hyperliquid perps: an always-on Bun/Hono
backend (scanner, crawler, Intel, Lab, desk) plus a React cockpit and a Lab research
engine.

## Stack and commands

Bun everywhere (no npm/yarn). Single package: Vite + React 19 + Tailwind 4 front, Hono
back, zod schemas in `src/shared/`, Postgres (postgres.js) with in-memory store
twins. The Ink terminal client in `tui/` is a separate package (`bun run tui`).

```bash
bun install
bun run typecheck        # tsc for src and node config
bun test ./src           # unit tests (CI runs exactly this)
bun run check:api        # scripts/check-api-esm.sh: API entry must stay ESM-clean
bun run build            # typecheck + vite build
bun run dev              # vite UI; bun run dev:api for the API; bun start = always-on server
bun run db:migrate       # db/migrate.ts
```

Done gate for any change: typecheck, `bun test ./src`, `check:api`, `build` all green.

Postgres-only tests (`*.pg.test.ts`) skip unless `INTEL_PG_TEST_URL` is set, e.g.
`INTEL_PG_TEST_URL=postgres://postgres@127.0.0.1:5433/hypertrade bun test src/server/intel/store.pg.test.ts`
(a local PGlite socket server such as `pglite-server` works). Migration and platform
store tests also run in-process on PGlite via `src/server/testing/pglite.ts`.

**Migrations:** `db/migrations/NNN_name.sql`, numbered, applied by filename. Never edit
a migration that has been applied or merged to master (the runner skips it by name, so
existing databases never see the edit). Add the next number instead.

## Conventions (observed in the code)

- **zod at trust boundaries.** Contracts live in `src/shared/*.ts` (`intel.ts`,
  `platform.ts`, `schemas.ts`, `intent.ts`); route inputs, LLM output and external API
  payloads are parsed there, not trusted.
- **LLM output is validated and fails closed.** `completeStructured`
  (`src/server/intel/llm.ts`) parses against a zod schema, retries once, then fails and
  caches nothing; the daily LLM cap fails closed before the provider call; the number
  validator (`src/server/intel/numbers.ts`) drops lines whose numbers or imperatives
  are not backed by the input payload.
- **Store parity.** Each store has memory and pg twins behind one interface
  (`src/server/intel/store.ts`, `src/server/platform/store*.ts`); the Lab store also
  has a JSON-file twin (`fileStore` in `src/server/lab/store.ts`) that must keep
  loading files written before a field existed. One shared test suite runs against
  the twins. Change one twin, change all.
- **postgres.js runs with `fetch_types: false`** (`src/server/db.ts`), so array params
  do not work. Build lists with `in ${sql()(ids)}`, never `any(${arr}::type[])`; store
  lists as jsonb.
- **Pure functions plus seams.** Logic is pure and exported (`novelty()`, `groupStats`,
  `explain()`); I/O (clock, fetch, LLM, store) is injected so tests need no network.
- **A second evaluation path needs a parity test.** Platform setups as data vs the
  scanner predicate (`src/server/platform/setups.test.ts`), Lab replay vs live rule
  firing (`src/server/lab/engine/eventStudy.test.ts`).
- **Alerts are informational and rare.** Facts (n, clusters, interval), never a verdict;
  dedupe and cooldown; no nagging or repeat pings.
- **Commits:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:`), no AI
  attribution or Co-Authored-By lines.

## Working principles

- Read the code you are about to change, and its callers, before editing.
- Smallest diff that solves the request. No unrequested features or abstractions.
- Reuse existing helpers and patterns before writing new ones.
- Fix the root cause in the shared function, not the one call site named in the report.
- Every non-trivial change leaves one runnable check that fails if the logic breaks.
- Match surrounding style; leave unrelated code and comments alone.

## Where things live

Root has only: this file, `README.md` (setup, env, API overview), and `ROUTINE.md`
(the routine runbook). Everything else is under `docs/`.

| Path | Purpose |
|---|---|
| `docs/SPEC.md` | Product contract: pillars, routes, Intel/Flow/Scout/Platform sections. Wins on data and API shape. |
| `docs/design/README.md` | Visual language, tokens, states, per-view briefs. Wins on visuals. |
| `docs/design/terminal.md`, `docs/design/chat.md` | Binding briefs for the Intel Terminal/Cockpit and the Paths chat; extend the main design doc. |
| `docs/FEATURES.md` | Signal-evidence ideas (phase 9) and what is in scope. |
| `docs/LAB.md` | Lab research engine contract: rules, validation, tools, MCP. |
| `docs/TASKS.md` | Open items, completed-phase summary, pointers to deleted task files in git history. |
| `docs/fallback-routine.md`, `docs/research/` | Provider-agnostic fallback routine; research notes. |
| `ROUTINE.md` | Runbook for the scheduled routines, dispatched by clock from one 4 h trigger: board scan, daily market state and post-mortems, weekly journal and review, monthly tune PR, on-demand check. They share `data/playbook.md`. |
| `tui/` | Separate terminal client with its own `SPEC.md`, `DESIGN.md`, `TASKS.md`. |

**The runbook is for the scheduled cloud routine only.** Scheduled sessions open it
by path, so keep its name and root location. For ordinary development work, do not
follow them and do not touch `data/**` unless asked; use `docs/SPEC.md`, the design docs
and `docs/LAB.md`.
