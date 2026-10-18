# TUI build — task map

Harness: Claude Code (cloud). Planner: claude-opus-5-5. Roster: opus, sonnet,
haiku, fable (all Anthropic, native subagents; no bridges). Provider diversity
is limited to model family.

| Role | Model |
|---|---|
| planner | opus (session) |
| designer | opus (no visual evidence: degraded) |
| heavy | opus |
| worker | sonnet |
| grunt | haiku |
| ui-impl | opus |
| reviewer | opposite family of the implementer (opus ↔ sonnet) |
| discussion | sonnet |

**Destination:** `bun run tui` gives a coding-agent-style perps terminal over
Hyperliquid with live markets, positions, book, alerts, an AI agent and
confirm-gated orders (see SPEC.md "Done means").

## Tasks

- T0 scaffold `tui/` + extract pure modules from heavy src files — worker — frontier
- D design brief `tui/DESIGN.md` — designer — frontier
- T1 core data: `config.ts`, `info.ts`, `store.ts`, `alerts.ts`, demo fixtures — worker — after T0
- T2 tickets + exchange: `ticket.ts`, `exchange.ts` — heavy — after T0
- T3 commands: `commands/parse.ts` (slash + order grammar) — worker — after T0
- T4 extras: `lab.ts` pulse, `brief.ts` — grunt — after T0
- T5 agent: `agent/loop.ts`, `agent/tools.ts` — worker — after T1, T2
- T6 UI: `ui/*`, `main.tsx` — ui-impl — after D, T1–T5
- V verification gate: review lenses, drift check, full test/typecheck — reviewers

## Decisions so far
- T0 done: pure modules extracted (order-resolve, triggers, atr, fmtPx); root tests scoped to ./src; CI tui job.
- D done: DESIGN.md (dock + Static transcript, overlays for /markets and /book, ticket card states).
- T1–T5 done; review round fixed stale mids, stop matching, stale-account tickets, partial-close cleanup, agent-key approval check, strict agent inputs.
- T6 done; verification round fixed Ctrl/Alt+Y confirm, 500 ms arm delay, quit during send, uncertain outcomes, paste submit, five design drifts.
- Accepted deviation: resolve/governor failures render as a blocked ticket card, not an error entry (DESIGN §8 updated).
- Not verified: a real testnet order round trip (needs a funded testnet API wallet).
