# ht: hypertrade in the terminal

A terminal companion for trading Hyperliquid perps. It works like a coding
agent: a transcript, a prompt, slash commands for fixed views, and an AI agent
you can ask in plain language. Live markets, positions and alerts stay visible
at the bottom of the screen.

It talks to Hyperliquid directly and reuses hypertrade's own modules: the HL
client, request signing, the desk governor, order resolution and alert
triggers. It needs no database and no web app.

## Run

```sh
bun install && (cd tui && bun install)   # once
bun run tui -- --demo                    # offline, from fixtures, orders simulated
bun run tui                              # live, testnet, read-only until you add a key
HT_NETWORK=mainnet bun run tui           # live mainnet data (still read-only without a key)
```

Tests: `cd tui && bun run typecheck && bun test`.

## Commands

| Command | What it does |
|---|---|
| `/markets [oi\|vol\|chg\|funding] [filter]` | Live table of all perps. Keys inside: `o v c f` sort, `/` filter, `enter` opens the coin, `b` opens its book, `esc` closes. |
| `/coin BTC` | Funding (current and predicted), OI, ATR14, flow regime and diagnostics, your position. |
| `/book BTC` | Live ladder with spread, depth within 50 bps, and slippage to fill $10k, $50k and $250k. |
| `/pos` | Positions with stop and liq distance, plus open orders. |
| `/long` `/short` | Order ticket (grammar below). |
| `/close BTC [pct]` | Reduce-only close ticket. |
| `/stop BTC <px>` | Replace the stop trigger. |
| `/cancel <oid>\|all [COIN]` | Cancel open orders. |
| `/alerts` | Active alerts: big moves, extreme funding, OI swings, no stop, near stop, breadth shock. |
| `/pulse` | Lab rule pulse (needs `LAB_URL` and `LAB_API_TOKEN`). |
| `/brief` | Latest routine brief from `data/marketstate`. |
| `/model` `/clear` `/help` `/quit` | Agent model, reset agent history, help, exit (or Ctrl-C twice). |

Anything that doesn't start with `/` goes to the agent. It can read markets,
books, candles, funding, positions, alerts, the Lab pulse and the brief. It can
also draft a ticket (`draft_order`, `draft_close`). It cannot send one.

### Order grammar

```
/long|/short COIN [size] stop <px|N%|Natr|pdl|pdh> [tp <px|N%|NR>] [Nx] [@px]
size := $<usd> | <n>% book | risk <n>%     default: risk HT_MAX_RISK_PCT
```

Examples: `/long BTC risk 0.5% stop 2% tp 2R`, `/short ETH $2k stop 2550 3x @2480`.

## Orders and safety

Every order is shown as a ticket first. A ticket resolves the exact size, stop,
take-profit and approximate liquidation price, runs the desk governor (risk per
trade, open risk, leverage, position count, R:R), and estimates slippage from the
live book. Nothing is sent until you press `y`.

- On `y` the ticket is quoted again against a fresh account read. If the mark has
  moved more than 0.5%, or the size, stops or verdict changed, the new ticket is
  shown and needs another `y`.
- Before signing, every check runs again: blockers, network, the notional cap,
  ticket age (30 s max) and stop side. Each ticket can be sent only once.
- An entry is one grouped order: an IOC entry within `HT_SLIPPAGE_PCT` of the
  mark, a reduce-only market stop, and an optional take-profit. If the exchange
  rejects the stop after the entry fills, the position is flattened at once.
- Testnet is the default. Mainnet runs only with `HT_NETWORK=mainnet` exactly,
  and shows a red `MAINNET` badge. When `HT_ACCOUNT` differs from the key's
  address, the key must be an approved agent for that account, or the app
  starts read-only.
- The key is never printed, logged or given to the agent.

Use a Hyperliquid **API wallet** key, which can trade but cannot withdraw, and
set `HT_ACCOUNT` to the master account.

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `HT_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `HT_ACCOUNT` | key's address | Account to read and trade for |
| `HT_AGENT_KEY` | none | API wallet key. Without it the app is read-only. |
| `HT_MAX_NOTIONAL_USD` | `1000` | Hard cap per order |
| `HT_SLIPPAGE_PCT` | `1` | IOC band for market entries and closes |
| `HT_WATCH` | `BTC,ETH,SOL,HYPE` | Coins the alerts watch besides your positions |
| `HT_MAX_RISK_PCT` `HT_MAX_OPEN_RISK_PCT` `HT_MAX_GROSS_LEV` `HT_MAX_COIN_LEV` `HT_MAX_POSITIONS` `HT_MIN_RR` | desk defaults (coin lev 3, gross 5) | Governor limits |
| `ANTHROPIC_API_KEY`, `ANALYST_PROVIDER`, `ANALYST_*` | none | Agent model, same as the web Analyst. Without it the agent is off and slash commands still work. |
| `LAB_URL`, `LAB_API_TOKEN` | none | `/pulse`. The URL must be https (plain http only for localhost). |
| `NO_COLOR`, `HT_ASCII` | unset | Plain output and ASCII borders |

This is a tool, not advice. The governor and the caps limit mistakes. They don't
make a trade a good one.
