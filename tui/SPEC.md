# hypertrade TUI — spec

`ht` is a terminal companion for trading Hyperliquid perpetuals. It looks and
behaves like a coding agent: a scrolling transcript, a prompt at the bottom,
slash commands for deterministic views, and an AI agent you can talk to in
plain language. It reuses hypertrade's pure modules (HL client, signing,
governor, analytics, order resolution, triggers, LLM providers) and talks to
Hyperliquid directly. No Postgres, no web app required.

## Stack

- Bun 1.4, TypeScript, Ink + React (versions chosen to satisfy Ink's peer
  range), `ink-testing-library` for render tests, `bun:test`.
- `tui/` is its own package (`tui/package.json`, own `node_modules`, own
  `tsconfig.json`) so its React does not collide with the web app's React RC.
  It imports hypertrade code by relative path (`../../src/shared/...`). Those
  modules resolve their own deps (zod, @noble, msgpack, @anthropic-ai/sdk) from
  the root `node_modules`, so the root needs `bun install` too.
- Only import light modules: `src/shared/*`, `src/server/desk/hl/{signing,wire}.ts`,
  `src/server/desk/{governor,config,analytics,triggers}.ts`,
  `src/server/intel/order-resolve.ts`, `src/server/platform/costs.ts`,
  `src/server/llm/{provider,anthropic,openai,presets,catalog}.ts`. Never import
  anything that pulls in `db.ts`, `routes/*`, `service.ts`, `tools.ts` or
  `agents.ts`. T0 extracts the pure pieces that currently live in heavy files.

Run: `bun run tui` from the repo root (script delegates to `tui/`), or
`bun run start` inside `tui/`. `bun run tui -- --demo` runs from fixtures with
no network and no keys.

## Configuration (env, read once at start)

| Var | Meaning | Default |
|---|---|---|
| `HT_NETWORK` | `testnet` or `mainnet` | `testnet` |
| `HT_ACCOUNT` | master account address to read (positions, orders, equity) | derived from key, else none |
| `HT_AGENT_KEY` | Hyperliquid API-wallet private key (can trade, cannot withdraw). Absent → read-only | — |
| `HT_MAX_NOTIONAL_USD` | hard cap per order, checked before signing | `1000` |
| `HT_SLIPPAGE_PCT` | IOC price band for market entries/closes | `1` |
| `HT_WATCH` | comma list of coins for alerts besides open positions | `BTC,ETH,SOL,HYPE` |
| Governor limits | `HT_MAX_RISK_PCT`, `HT_MAX_OPEN_RISK_PCT`, `HT_MAX_GROSS_LEV`, `HT_MAX_COIN_LEV`, `HT_MAX_POSITIONS`, `HT_MIN_RR` | desk defaults, except coin lev 3 and gross lev 5 |
| LLM | same env as the web Analyst (`ANTHROPIC_API_KEY`, `ANALYST_PROVIDER`, `ANALYST_*`) via `resolveProvider(process.env)` | none → agent disabled, slash commands still work |
| `LAB_URL`, `LAB_API_TOKEN` | deployed app for Lab pulse | none → `/pulse` says how to enable |

Mainnet is never implied. `HT_NETWORK=mainnet` with a key shows a red
`MAINNET` badge permanently in the status bar. The key is never printed,
logged, sent to the LLM, or included in any tool output.

## Core flows

1. **Start-up.** Load config, fetch `metaAndAssetCtxs` and (if an account is
   known) `clearinghouseState` + `frontendOpenOrders`. Open the HL WebSocket
   for `allMids`. Show a status bar: network, account (short), equity, uPnL,
   margin used, positions count, WS state, alert count, agent model.
2. **Markets.** `/markets [sort] [filter]` — live table: coin, mark, 24h %,
   funding (hourly + APR), predicted funding, OI USD, 24h volume, premium,
   max lev. Sort keys `oi|vol|chg|funding`. Updates from polls (15 s) + WS mids.
3. **Coin drill-in.** `/coin BTC` — mark, 24h, funding APR + predicted,
   OI, flow regime and trap/rally diagnostics (`rallyDiagnostics`,
   `classifyRegime` from desk/analytics), ATR14 daily, nearest positions.
4. **Book.** `/book BTC` — top N levels each side, spread bps, depth within
   50 bps, slippage to fill $10k / $50k / $250k via `walkBook`.
5. **Positions.** `/pos` — positions with side, size, entry, mark, uPnL,
   stop/TP (from open trigger orders), distance to stop and to liq;
   open orders below. Header totals.
6. **Order ticket.** `/long BTC risk 0.5% stop 2% tp 3%` (grammar below) or an
   agent `draft_order`. The ticket resolves the intent (`resolveOrder`), runs
   the governor (`evaluateRisk`), estimates fill slippage from the live book,
   checks `HT_MAX_NOTIONAL_USD`, and renders a framed ticket: side, coin,
   size, notional, entry est., stop, TP, liq ≈, risk $ and %, R:R, slippage
   bps, governor verdict with reasons/warnings, network. Keys: `y` send,
   `n`/`Esc` discard. On `y` the ticket is re-quoted; if mark moved > 0.5% or
   the verdict changed, the new ticket is shown and needs another `y`.
   Sending = set cross leverage (as the desk broker does) → one
   `normalTpsl` order action: IOC entry at mark ± slippage, reduce-only market
   SL trigger, optional TP trigger. Result (filled size, avg px, oids, errors)
   lands in the transcript. Read-only mode (no key) still shows the ticket
   with "read-only: no key" and no `y`.
7. **Manage.** `/close BTC [pct]` (reduce-only IOC, ticket + confirm),
   `/cancel <oid>|all [coin]` (confirm), `/stop BTC <px>` replace the stop
   trigger (confirm).
8. **Alerts.** Every poll, build mark history and OI history in memory and run
   `evaluateTriggers` for watched coins + open positions (moves, extreme
   funding, OI swings, no-stop, near-stop, breadth shock). New alerts (by
   key, 30 min cooldown) append a coloured line to the transcript and bump
   the status bar counter. `/alerts` lists the active set.
9. **Agent.** Any input not starting with `/` goes to the agent. Provider
   from `resolveProvider`; `/model` shows it. Streaming text into the
   transcript; tool calls shown as one dim line each (`▸ get_book BTC`).
   Tools (read-only unless noted): `get_markets`, `get_coin`, `get_book`,
   `get_positions`, `get_alerts`, `get_funding_history`, `get_candles`,
   `lab_pulse`, `get_brief`, and `draft_order` (returns a ticket preview to the
   model and surfaces the same ticket to the human for `y/N`; the model can
   never send). Max 8 tool rounds, 120 s per question, `Esc` aborts. History
   kept for the session; `/clear` resets. System prompt: market intelligence,
   hedged language, never claims an order was sent unless the tool result
   says the human confirmed it.
10. **Lab pulse.** `/pulse` — remote `lab_market_pulse` via `LAB_URL` +
    `LAB_API_TOKEN`: per asset long/short firing counts and rule texts.
11. **Brief.** `/brief` — read `data/marketstate/latest.json` from the repo
    (headline, tldr, risks) and `data/sectors/latest.json` top sectors.
12. **Help.** `/help` lists commands; `/quit` or Ctrl-C twice exits.

## Order grammar (`/long`, `/short`)

```
/long|/short COIN [size] [stop] [tp] [lev] [limit]
size  := $<usd> | <n>% book | risk <n>%      (default: risk = HT_MAX_RISK_PCT)
stop  := stop <px> | stop <n>% | stop <n>atr | stop pdl|pdh    (required)
tp    := tp <px> | tp <n>% | tp <n>R
lev   := <n>x                                 (default 3)
limit := @<px>                                (default market)
```

Risk-based sizing (`risk 0.5%`) is computed from the stop distance:
notional = equity × risk% / stop%. It maps onto `OrderIntent.size.usd`.
Parse errors name the bad token.

## Done means

- `bun install` at root and in `tui/` succeed; `bun run tui -- --demo`
  renders the status bar, `/markets`, `/pos`, `/book BTC`, a ticket, and an
  alert from fixtures, and exits cleanly on `/quit`.
- `bun run tui` (no keys) connects to HL mainnet info/WS read-only and shows
  live markets.
- `cd tui && bun test` passes: grammar parser, ticket building (resolve +
  governor + caps), exchange action building (signed payload shape against a
  fixed key, no network), alert dedupe/cooldown, agent loop with a scripted
  provider including `draft_order` never sending, and Ink render tests of the
  main views.
- `cd tui && bun run typecheck` clean; root `bun run typecheck` and
  `bun test src` still pass after the T0 extractions.
- No network call is made by any test.
