# Consolidation — one front, fewer cells, one way to do each thing

Status: four PRs. PR 1 and PR 2 done; PR 3 next. This file is the contract for the
consolidation work; `docs/SPEC.md` and `docs/design/README.md` win on data, API shape
and visuals, and each PR updates them in the same change.

## Why

A scout of the UI (2026-10-28) found that the product is not one feature repeated many
times, but it has no enforced rule for where things live:

- 10 top-level nav cells against the 9-cell ceiling in `docs/design/README.md` §5.2.
  Cells were appended as features shipped; old landing pages (Overview, Terminal) were
  demoted to sub-tabs instead of removed.
- About 32 routes in 6 families, each with its own sub-nav idiom (TerminalTabs links,
  EngineTabs `.subtab`, LabTabs, none for Markets/Cycles/Branches).
- Operator-visible overlaps: Cockpit vs Terminal as two landings, `/overview` as a
  digest of four other views, `/sectors` showing the same baskets twice with unlinked
  selections, one-way links between `/markets/:coin` and `/asset/:coin`, two kill-switch
  implementations, different confirmation weight for the same approve action.
- Roughly 700–900 duplicated lines (state ladders, desk types copied from the server,
  two LLM tool loops, about 8 number formatters, 4 copies of the 401 redirect).
- Docs that describe earlier states of the app.

Deliberately kept apart (verified, documented reasons): desk governor vs the external
engine governor; flow flags, scanner setups, tripwires, desk triggers and Lab rules
(different data, horizons, consumers); Branches form vs Paths chat (one engine);
`intel_alerts` vs the desk operational log; desk book vs exposure positions.

## Principle

**One cell per operator job, one home per object.**

- A top-level cell exists only if it answers a job no other cell answers. New features
  become a tab inside the cell whose job they serve. The ceiling stays 9; the target is 5.
- Inside a cell, sub-views use one sub-nav component (`SectionTabs`, built on the
  existing link-tab pattern, sticky under the top bar).
- A drill-in (`/x/:id`) keeps its family's tabs and a back link, or is a full view with
  a back link. Every coin page links to every other coin page for the same coin.
- One implementation per action (kill, approve, place). Confirmation weight follows the
  action, not the page.

## Target nav (5 cells)

The trading front is one cell. Its tabs read left to right as a funnel from **intel**
(what changed, what I know) to **act** (what to place, approve or kill), so the operator
walks one surface instead of choosing between Cockpit, Terminal and Desk.

| Cell | Job | Tabs / routes |
|---|---|---|
| TRADE | Know what changed for my book, then act on it | Intel: CHANGES `/terminal`, WATCH `/watch`, JOURNAL `/journal`, THESES `/theses`, QUERY `/query` → Act: FEED `/` (landing), ORDER `/order`, DESK `/desk`. Drill: `/asset/:coin` |
| MARKET | What is the market doing | PERPS `/markets`, SECTORS `/sectors`, STATE `/state`, CYCLES `/cycles`. Drills: `/markets/:coin`, `/cycles/:coin`. Header: the MetricsStrip from Overview |
| RESEARCH | What would have worked | LAB `/lab/*`, BRANCHES `/branches`. Drills: `/lab/rules/:id`, `/branches/:id` |
| ASK | Free-form question to the analyst | `/analyst` (ASK and SIMULATE) |
| ENGINE | External Hyperion console | `/strategies`, `/decisions`, `/governor` and drills |

Route URLs do not change, except `/overview`, which redirects to `/markets`. `/` stays
the landing (the Cockpit feed). `/?review=1` keeps redirecting to `/terminal?review=1`.
Telegram deep links (`/order`, `/desk`, `/asset/:coin`) keep working.

Not merged, on purpose: Desk ASK stays inside DESK (it proposes trades, persists runs,
serves Telegram `/ask`; the analyst is read-only). `/order` stays its own route. The
engine governor keeps Hyperion's vocabulary. `/sectors` keeps both panels.

## Confirmation levels (replaces README §7 "no typed-word confirmations")

1. Plain click: reversible or read-only actions.
2. Dialog (`ConfirmDialog`): anything that places, approves or cancels an order — Desk
   APPROVE, Cockpit APPROVE, `/order` place, engine decision approve.
3. Typed word: kill switches only (desk KILL, engine KILL).

## PR 1 — visible bugs, one kill switch, docs made true

No IA change.

1. **Sticky offsets per theme.** Add `--topbar-h` and `--subnav-h` tokens in
   `src/ui/index.css`; the themes set `--topbar-h` instead of an unlayered `height`.
   Every `sticky top-10`, `top-[92px]` and `scroll-mt-[...]` derives from the tokens.
   Done: under hyperdash (54px bar), tradexyz (48px) and the base theme (40px), sub-tab
   rows sit flush under the top bar at 320px and 1440px.
2. **Coin cross-links.** `/markets/:coin` links to `/asset/:coin` (INTEL); the Cockpit
   detail links to both (CHART, INTEL); `/asset/:coin` keeps its CHART link. Done: from
   any coin page, the other two are one click away.
3. **One kill switch.** A `useDeskKill` hook plus `KillSwitchDialog` used by Desk and
   the Cockpit header. Each page keeps its own button, shortcut and focus return.
   One refetch rule (refetch in `finally`). The one-way engine kill is not touched.
   Done: one implementation, a test on the hook's arm/disarm and error path.
4. **Approve weight.** Desk APPROVE opens the same Level 2 dialog as Cockpit APPROVE
   (`ConfirmDialog`). Done: no UI button places or approves an order without a dialog.
5. **Stale code comments** that cite old routes, counts or names.
6. **Docs made true.** Every statement in `docs/SPEC.md`, `docs/design/README.md`,
   `docs/design/terminal.md`, `docs/design/chat.md`, `README.md` and `docs/TASKS.md` about
   routes, nav cells, confirmation levels, themes and view inventory matches the code
   after items 1–5. Edit sections in place, keep section numbers (code cites them),
   remove superseded text instead of appending "supersedes" notes. Add a short view brief
   for `/cycles`, `/desk` and the ENGINE console where none exists. The README §5 nav
   section states the principle above and lists the current 10 cells as over the ceiling,
   with this file as the plan.

Gate: `bun run typecheck`, `bun test ./src`, `bun run check:api`, `bun run build`.

## PR 2 — code dedupe, no IA change

- One UI number/time module (`src/ui/lib/format.ts`): signed USD, compact USD, price,
  `fmtTs`/`fmtDur`/`fmtAge`, `fmtUtcStamp`, a null-safe sign class. Callers in
  `lib/desk.ts`, `components/strategy/format.ts`, `components/branches/format.ts`,
  `pages/cockpit/logic.ts`, `lib/lab.ts`, `components/state.tsx`, `pages/State.tsx`
  move to it. `src/shared/format.ts` keeps its ASCII minus (server and TUI depend on it).
  Chart-axis formatters stay local.
- Transport: export `REDIRECT_KEY`, `failFrom` and `parseWith(schema, prefix)` from
  `src/ui/lib/api.ts`; `lab.ts`, `analyst.ts`, `desk.ts`, `engine.ts`, `intel.ts` reuse
  them. One `streamSse` in `src/ui/lib/sse.ts` for analyst and desk streams, with an
  abort test.
- Types: `import type` server types instead of copies (`lib/desk.ts`, `Markets.tsx`,
  `components/branches/types.ts`), following `lib/lab.ts`.
- Small shared pieces: `StatCell`, `StabValue`, `MomentumBadge` on `Badge`, chart theme
  helpers, `useNow`/`useMedia`/`useQueryPatch` in `src/ui/lib/hooks.ts`, governor limit
  form, `summarizeDecision`, Desk and Governor position tables on `DataTable`.
- Server: shared `providerError`, one Claude price table (callers keep their
  unknown-model rule), `sectors.ts` on `getCtxs`, a read-only
  `DeskService.assessOperatorOrder` for `deskRisk.assess`.

Each moved function keeps or gains a table-driven test.

## PR 3 — MARKET and RESEARCH families (10 cells → 7)

- `SectionTabs` and a `PageContainer` layout route per family.
- MARKET family: Markets, Sectors, State, Cycles. MetricsStrip moves into the MARKET
  header (it is the only UI for funding skew, fear/greed, BTC dominance, stablecoin cap).
  `/overview` redirects to `/markets`; the Lab PulseTile moves to the Lab PULSE tab.
- RESEARCH family: Lab and Branches; `/branches/:id` gains a back link.
- `/sectors`: one `selectedId` drives both panels; the join keeps ids present in only one
  payload.
- Docs first: README §5 cells, §10 route map, §13 state matrix; SPEC "UI views" and
  §I0 item 1; terminal.md tab list.

## PR 4 — one TRADE front (7 cells → 5) and normalised states

- Fold COCKPIT, DESK and the Terminal tabs into TRADE with the Intel → Act tab order
  above, on `SectionTabs`. `isActive` keeps `/`, `/asset/:coin`, `/desk` in the family.
  "← TERMINAL" links become "← CHANGES". Cockpit feed items and Terminal change items
  stay separate lists (different status machines); they share the tab bar, the coin
  drill and the action path.
- ENGINE tabs move to `SectionTabs`.
- State handling: `useApi` keeps data when a refetch fails; `usePoll` gains latest-wins
  and reset-on-deps; then an `AsyncBody` composer replaces the hand-written
  loading/offline/error ladders (about 30–40 sites).
- Type scale: codemod `text-[Npx]` to the scale classes, plus a grep check in
  `package.json` added to the done gate. Visual pass on all themes.
- Agents: the analyst and desk agents get read tools for opportunities, alerts, the
  latest brief, exposure and theses, through an injected deps interface (no import cycle).
- Optional: one `runToolLoop` for analyst and desk, with parity tests on both event
  streams.
- Docs: README §5 final rule and TRADE family brief; SPEC Desk/Platform note that
  Cockpit APPROVE, Desk APPROVE and `/order` share one preview-and-submit path; a SPEC
  glossary for flow flag, scanner setup, tripwire, desk trigger and Lab rule.

## Done (whole plan)

Nav has 5 cells with one sub-nav component; no route answers a question another route
already answers; each action has one implementation and one confirmation level; the
docs describe the shipped app; the CLAUDE.md gate is green on every PR.
