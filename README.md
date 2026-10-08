# Hypertrade

A personal market terminal for tracking crypto assets, simulating allocation branches against historical data, and monitoring sector dynamics.

## Setup

```bash
bun install
```

## Development

```bash
bun run dev       # Vite dev server (localhost:5173)
bun run dev:api   # API server (localhost:8787)
```

## Build

```bash
bun run build
```

## Deployment

Deployed on Vercel + Supabase. Set environment variables from `.env.example` in Vercel project settings.

## Chart history

`/markets/:coin` charts every Hyperliquid perp at `1m 5m 15m 1H 4H 1D 1W 1M`
with funding, open interest and premium panes. History is stitched from
layers, newest first (`src/server/market/candleSync.ts`):

1. **Hyperliquid** `candleSnapshot` — native interval, but only the latest
   5000 bars (3.5 days of 1m, 208 days of 1h). The cron persists them every
   15 minutes, so LTF history keeps growing past that window.
2. **Binance spot** (`data-api.binance.vision`, keyless) below HL's floor.
3. **Bitstamp** below Binance's (BTC reaches 2011).

1W/1M below HL's floor are resampled from stored daily bars on HL's own
bucket phase. Every external layer must pass a seam check against the bars
above it (same-ticker impostors are rejected), and HL's zero-volume
pre-listing bars are dropped. Pages load as the chart scrolls left; the newest
bar streams over HL's websocket.

Funding is HL `fundingHistory` (hourly, full history) in the `funding` table.
OI has no history endpoint upstream: it comes from the collector's 15-minute
`hl.oi.<COIN>` snapshots, taken for the top 20 by OI plus core, branch and
recently charted coins. Retention: 1m bars 30 days, 5m bars 120 days.

Requires `db/migrations/002_chart_history.sql` (adds `candles.src`,
`sync_state`, `funding`, and drops the old CoinGecko 4-day rows).

## Social attention (optional)

Set `ELFA_API_KEY` and the collect cron adds Elfa's trending-tokens feed:
mentions in the trailing 24h for every Hyperliquid-listed coin on it, written
as `elfa.mentions_24h.<COIN>`, `elfa.share_24h.<COIN>` (share of all
trending-token mentions) and `elfa.mentions_chg_24h.<COIN>` (vs the prior
24h, as a fraction). `/api/sectors` sums them per sector into
`social_share_24h` / `social_mentions_24h`, shown as `SOC` next to the
routine's `MS` on the Sectors grid and as mention columns in the drill-in.

`MS` is the routine's judgment; `SOC` is a count. Neither predicts price.
Elfa publishes no evidence that its counts lead price moves, and the research
on social-attention signals in crypto finds small, short-lived effects. The
point is to see where the two disagree.

Elfa's free plan is 1,000 credits a month, one per call. The collector
fetches at most once per `ELFA_MIN_INTERVAL_HOURS` (default 8, about 90
credits a month) however often the cron fires. The key is meant to be
shared with the provenance repo, whose social yardstick spends most of the
rest. Without a key the collector records `skipped:no-key` and nothing else
changes.

## Prop-trading contract

`PROP.md` is the operator's own rulebook for trading a Breakout evaluation
with this app as journal and enforcer: the firm's limits, the risk framework
derived from them, the setup ledger, the session protocol and the gates that
must clear before a fee is paid. The journal that enforces it is T13–T15 in
`TASKS.md`.

## Desk (optional)

`/desk` is an agentic portfolio desk: a portfolio-manager agent that runs a
team of specialist agents, answers market questions, proposes and manages
trades, and alerts you. Code: `src/server/desk/*`, `src/server/routes/desk.ts`,
`src/ui/pages/Desk.tsx`, `scripts/desk-worker.ts`. Needs
`db/migrations/003_desk.sql` and any analyst provider key (it reuses the
analyst's model configuration).

**The team.** The PM (`agents.ts`) calls `consult_specialists` to run several
specialists in parallel, or `spawn_agent` to start an ad-hoc analyst with a
mandate and a subset of the read tools. Roster (`prompts.ts`):

| id | role | tools |
|---|---|---|
| `flows` | derivatives & flows | `flow_diagnostics`, `market_breadth`, `funding_history`, `price_structure`, HL markets, metrics |
| `macro` | macro, liquidity & fiscal | `macro_dashboard` (FRED net liquidity, rates, dollar, credit, VIX), web search |
| `news` | news & geopolitics | briefing, sectors, web search |
| `onchain` | cycle & on-chain | `cycle_regime` (hl-cycles), metrics, web search |
| `risk` | risk officer | `portfolio`, `desk_history`, levels, flows |
| `narratives` | sector rotation | sectors, breadth, markets, flows, web search |

`flow_diagnostics` (`analytics.ts`) is the deterministic core of "is this
rally a bull trap or real flow": price vs OI change (new longs, short
covering, liquidation, spot-led), funding z-score vs 30 days, perp premium,
volume vs the prior window, the share of volume on bars closing with the
move, and extension, rolled into a 0–100 trap score with each component's
reason. OI history comes from the collector's `hl.oi.<COIN>` snapshots.

**Acting.** Only the PM holds `propose_trade`, `propose_exit` and
`send_alert`. A proposal names side, stop, target and `riskPct`; the
governor (`governor.ts`) computes size from equity and the stop at the live
mark and enforces the limits (per-trade and open risk, gross and per-coin
leverage, reward:risk, stop distance, daily loss, one position per coin,
kill switch). It runs again at execution, so a late approval is checked
against current prices. `DESK_APPROVAL=manual` queues every entry for you
(Desk page or Telegram buttons); `auto` (default) executes what the governor
passes. Exits never wait. The venue is a paper book (`paper.ts`: mark fills
with slippage and taker fees, stops/targets settled against 5m highs and
lows). `DESK_WATCH_ADDRESS` monitors a real Hyperliquid account read-only
(positions, stops, equity), with no keys.

**Live on Hyperliquid testnet** (`hl/`): set `DESK_VENUE=hl-testnet` and
`DESK_HL_SECRET_KEY` to an API wallet key created at
app.hyperliquid-testnet.xyz/API (it can trade but not withdraw), plus
`DESK_HL_ACCOUNT` = the account it trades for. An entry is one signed
`normalTpsl` action: an IOC limit 1% through the testnet mark, a
reduce-only market stop at the proposal's stop and a take-profit at its
target, all resting on the exchange. If the stop is rejected the position is
flattened at once. The governor sizes from the testnet account's equity and
the testnet mark (testnet prices can differ from mainnet's; a stop that is
on the wrong side of the testnet mark is blocked). Exits are reduce-only and
cancel the leftover triggers when flat. Signing (`hl/signing.ts`) is
checked against hyperliquid-python-sdk's published vectors. Mainnet is
refused; a bad key falls back to paper with a note on the page.
`DESK_HL_LEVERAGE` (cross, default 3) and `DESK_HL_SLIPPAGE_PCT` (default 1)
tune the orders.

**Asking.** `POST /api/desk/ask {question, history?, act?}` streams the run
(SSE). Asks are analysis-only unless `act` is set ("let the desk act" on the
page). Each run is bounded: 8 agents, 3 spawns, 10 PM rounds, 6 per
specialist, 3 proposals, 3 alerts, 240 s.

**Watching.** `tick()` (`watch.ts`) settles paper stops, checks the day-loss
limit, and evaluates triggers: 1h/4h moves, funding extremes, 4h OI surges,
positions near their stop or without one, breadth shocks. Each alerts once
per 3h; a trigger (or the scheduled review, `DESK_REVIEW_HOURS`) wakes the
team for a cycle, capped by `DESK_MAX_CYCLES_PER_DAY` and
`DESK_CYCLE_COOLDOWN_MIN`. It runs from `collect.yml`'s `desk` job every 15
minutes (set the repo variable `DESK_ENABLED=true`), or every minute from
`bun run desk:worker` on any always-on machine.

**Alerts and control.** Telegram (`DESK_TELEGRAM_BOT_TOKEN`,
`DESK_TELEGRAM_CHAT_ID`): alerts with Approve/Reject buttons, plus `/status`,
`/pending`, `/approve <id>`, `/reject <id>`, `/kill`, `/resume`, and `/ask`
(worker only). Use the worker's polling, or set
`DESK_TELEGRAM_WEBHOOK_SECRET` and register
`${APP_URL}/api/desk/telegram` with `setWebhook` (`secret_token` = that
secret). Discord (`DESK_DISCORD_WEBHOOK_URL`) and a generic JSON webhook
(`DESK_ALERT_WEBHOOK_URL`) also work. Every alert is stored and shown on the
page. All `DESK_*` settings are listed in `.env.example`.

## Strategy engine (optional)

The `/strategies`, `/decisions` and `/governor` pages talk to the hyperion core
through the `/api/engine/*` proxy (`src/server/routes/engine.ts`), which forwards
to `${ENGINE_URL}/api/strategy/*` with `Authorization: Bearer ${ENGINE_TOKEN}`.

- `ENGINE_URL` — base URL of the hyperion core (e.g. `http://localhost:8080`).
  Unset: the proxy answers `503 { "error": "engine not configured" }` and the
  pages render their offline state.
- `ENGINE_TOKEN` — the core's API bearer token. Optional; omitted when unset.

Upstream failures surface as `502 { "error": "engine unreachable" }` (or
`"engine timeout"` after 10s). Wire types live in
`src/shared/strategy-protocol.ts`; fixtures under `src/shared/fixtures/strategy/`.

## Analyst (optional)

`/analyst` is a read-only natural-language analyst over the app's data
(briefings, sectors, metrics, Hyperliquid markets, engine strategies and
decisions), plus web search on Anthropic models. It never places or approves
anything; Jev and the operator own the trading loop. Server:
`src/server/llm/*`, `src/server/routes/analyst.ts` (`POST /api/analyst/query`,
SSE; `GET /api/analyst/models`, the model catalog). UI: `src/ui/pages/Analyst.tsx`
and `src/ui/components/analyst/*`.

### Providers

Configure any number; the model picker lets the operator choose per question
(persisted per browser). Setting a provider's key is all it takes: its
curated models appear in the picker.

| Provider (`id`) | Key env var | Models (checked 2026-10-01) | Effort | Notes |
|---|---|---|---|---|
| Anthropic (`anthropic`) | `ANALYST_ANTHROPIC_API_KEY` | Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5 | low…max (not Haiku) | Web search; refusal fallbacks; summarized thinking |
| OpenAI (`openai`) | `OPENAI_API_KEY` | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna | low…max | `max_completion_tokens` |
| Google Gemini (`google`) | `GEMINI_API_KEY` | Gemini 3.8 Flash, 3.5 Flash-Lite | low/medium/high | OpenAI-compatible endpoint |
| xAI (`xai`) | `XAI_API_KEY` | Grok 4.7 | — | |
| DeepSeek (`deepseek`) | `DEEPSEEK_API_KEY` | DeepSeek V4 Pro, V4.1 Flash | low/high/max | Thinking mode on; `reasoning_content` replayed in tool loops |
| Moonshot Kimi (`moonshot`) | `MOONSHOT_API_KEY` | Kimi K3, K2.6 | low/high/max (K3) | K3 defaults to max upstream; the analyst sends an explicit level |
| Alibaba Qwen (`qwen`) | `DASHSCOPE_API_KEY` | Qwen3.8 Max, 3.7 Plus, 3.8 Flash | — | International endpoint by default |
| OpenRouter (`openrouter`) | `OPENROUTER_API_KEY` | from `ANALYST_OPENROUTER_MODELS` | — | Needs a model list |
| Custom (`openai-compatible`) | `ANALYST_OPENAI_API_KEY` + `ANALYST_OPENAI_BASE_URL` | from `ANALYST_MODELS` | — | Any `/chat/completions` server |

Each vendor also reads an `ANALYST_`-prefixed key (`ANALYST_DEEPSEEK_API_KEY`,
…) ahead of the standard name, and takes `ANALYST_<ID>_BASE_URL` (regional
endpoints, proxies) and `ANALYST_<ID>_MODELS` (`id,id2=Label Two`, replaces
the curated list) where `<ID>` is `GEMINI`, `XAI`, `DEEPSEEK`, `MOONSHOT`,
`QWEN` or `OPENROUTER`. OpenAI's are `ANALYST_OPENAI_PLATFORM_BASE_URL` /
`ANALYST_OPENAI_PLATFORM_MODELS`: `ANALYST_OPENAI_*` already names the
custom slot. Curated lists live in `src/server/llm/presets.ts` (vendors) and
`src/server/llm/catalog.ts` (Anthropic).

### Server default

- `ANALYST_PROVIDER` — the provider a query uses when it names none:
  `anthropic` (default), a preset id (`deepseek`, `moonshot`/`kimi`,
  `google`/`gemini`, `openai-platform`, `xai`, `qwen`, `openrouter`), or
  `openai-compatible` (`openai` keeps meaning this, as before). When it isn't
  configured, the first ready provider in the catalog is used instead.
- `ANALYST_API_KEY` / `ANALYST_BASE_URL` / `ANALYST_MODEL` — the default
  provider's key, base URL and model (the original single-provider settings,
  unchanged).
- `ANALYST_EFFORT` — effort used for the default provider when a query
  doesn't pick one; otherwise each model's own default applies (Opus 5.5:
  medium; DeepSeek, Kimi K3: high).

`GET /api/analyst/models` always answers `200`, even with nothing
configured, listing every provider with `available` and, when unavailable,
the env var to set. `POST /api/analyst/query`'s `provider`/`model`/`effort`
are validated against it: an unknown provider, a model the provider doesn't
list, or an effort the model doesn't take gets `400 { error, field }`. With no
provider configured at all, `/status` and default queries answer
`503 { "error": "analyst not configured" }`.

Reasoning streams to the UI as `reasoning` events when the model exposes it.
DeepSeek and Kimi require their reasoning back during a tool loop; the client
replays it, and folds earlier session turns into the opening message for
them (the session history is text-only). Web search is Anthropic-only.
Each question is bounded to 8 tool rounds and 90 seconds.

## Lab (heuristic research)

`/lab` and its tools search a metric universe for simple, human-readable
trading rules ("when `cm:CapMVRVCur` z(90) < −1.1 and `ht:funding` ≥ 0, go long
BTC"), score them as strategies net of slippage, validate them walk-forward and
on a holdout, and track the ones you save in a catalogue with live
performance, health checks and a Market Pulse. It rebuilds the methodology
Glassnode published for Alpha Lab over keyless data. Full spec and the tool
contract: [`LAB.md`](LAB.md). Results are historical research, not advice.

Providers (all keyless): `ht` (hypertrade DB, live Hyperliquid fallback for
price/funding), `cm` (Coin Metrics community API), `fng` (alternative.me Fear
& Greed), `llama` (DefiLlama stablecoins and TVL), `bc` (blockchain.com
Bitcoin network charts), `deribit` (BTC and ETH DVOL history). Runs and the
catalogue live in Postgres (`db/migrations/004_lab.sql`, then
`005_lab_guard.sql`; apply them like the others; the newest 500 runs are
kept), in a JSON file locally, or in memory.

**Lab data.** `/api/cron/lab-collect` runs the Lab collector
(`src/server/lab/collect.ts`) which stores the daily history of every `cm`
(per `LAB_ASSETS`, default `BTC,ETH`), `fng`, `llama`, `bc` and `deribit`
metric in `observations` as `lab.<provider>.<key>[.<asset>]` (e.g.
`lab.cm.CapMVRVCur.btc`, `lab.bc.hash_rate`). The collect workflow calls it
in its own job every 15 minutes (a no-op for fresh series) and Vercel Cron
daily at 06:30 UTC as a fallback. A run has a 200 s budget: no series starts
after it and every upstream request is cut to end by it; a paged history it
cuts short is stored as far as it got and resumed on the next run. Runs never
overlap: a lease in `sync_state` (`coin = '_lab'`, `series = '_lease'`,
`synced_at` = expiry, budget + 60 s) is taken by one conditional upsert, and
a second trigger answers `{"busy": true}` without collecting. A series' first
sync pulls its full history; after that it refetches a tail (last sync minus
a week) at most every 20 h. Only completed UTC days are stored (today's
value is still forming), and that week of overlap is the revision horizon:
an upstream revision older than 7 days is not picked up. A failure waits 1 h
(a 4xx refusal 20 h) before the next try; one dead source never stops the
others, and Coin Metrics goes one request at a time to stay inside its
community rate limit. Bookkeeping is in `sync_state` under `coin = '_lab'`. Searches read that stored history first when its last
point is at most 2 days old, top up a staler one live from its last week, and
go live for anything not collected or without a DB.

Point in time: every metric is shifted by its publication lag (`lagDays`), and
the calendar ends at the last *completed* UTC day: today's forming bar is
dropped, so a rule "firing now" fires as of the last daily close. Gaps are
forward-filled up to 3 days (8 for weekly FRED series such as WALCL, WTREGEN
and net liquidity). Level metrics (price, supply, hash rate, TVL, …) are
flagged non-stationary, so searches skip their raw values.

| env | |
|---|---|
| `LAB_API_TOKEN` | comma-separated bearer tokens accepted on `/api/lab/*` and `/api/mcp` (any method), plus `GET /api/metrics/*`, `GET /api/sectors` and `GET /api/marketstate*` (the session cookie also works everywhere) |
| `LAB_SEARCH_DEADLINE_MS` | server search budget, default 50 000; local CLI/stdio: none unless set |
| `LAB_URL` | CLI/stdio: deployed origin to proxy to; unset runs the lab in-process |
| `LAB_STORE_FILE` | local store file, default `~/.hypertrade/lab.json` |
| `LAB_ASSETS` | assets the cron collector stores `cm` history for, default `BTC,ETH` |
| `LAB_ALLOWED_ORIGINS` | extra browser origins allowed on `/api/mcp` (besides `APP_URL` and localhost) |

The same 12 tools (`lab_search`, `lab_evaluate_rule`, `lab_catalogue_*`,
`lab_market_pulse`, …) are served over every surface, plus an `autoresearch`
MCP prompt that runs the research loop.

**Claude Code.** The project `.mcp.json` registers `hypertrade-lab` as a stdio
server (`bun run lab:mcp`): in-process by default, or a proxy to the deployed
app when `LAB_URL` and `LAB_API_TOKEN` are set in the environment. Or connect
to the deployment directly over HTTP:

```bash
claude mcp add --transport http hypertrade-lab https://<app>/api/mcp \
  --header "Authorization: Bearer $LAB_API_TOKEN"
```

Then ask Claude for something like: "Find a long-only rule for BTC with
`lab_search`, stress-test the best one (walk-forward vs holdout,
`lab_sensitivity`, a `lab_evaluate_rule` on another window), and
`lab_catalogue_save` it only if its verdict is `robust`, the save bar:
walk-forward Sharpe > 1, holdout Sharpe > 0, stability ≥ 0.5 and deflated
Sharpe ≥ 0.9." The `/analyst` page can read the same
lab (runs, evaluations, catalogue, Market Pulse) but never searches or saves.

**Claude routines, claude.ai custom connectors, other remote MCP clients.**
Remote MCP URL `https://<app>/api/mcp`, authenticated with the header
`Authorization: Bearer <LAB_API_TOKEN>`. The server does bearer headers only,
not OAuth: clients that let you set a header (Claude Code, the API's MCP
connector) work; a connector UI that only offers OAuth will not.

**CLI** (local, or remote with `LAB_URL`):

```bash
bun run lab tools
bun run lab lab_list_metrics --provider cm --asset BTC
bun run lab lab_search --asset BTC --metrics '["cm:CapMVRVCur","ht:funding","fng:value"]' --horizon-days 14
bun run lab lab_market_pulse --pretty
```

**REST**: `GET /api/lab/tools` lists definitions; `POST /api/lab/tools/<name>`
takes the arguments as JSON and answers `{ ok: true, result }` or
`{ ok: false, error, field? }` (400 on bad arguments):

```bash
curl -s https://<app>/api/lab/tools/lab_catalogue_health \
  -H "Authorization: Bearer $LAB_API_TOKEN" -H 'content-type: application/json' -d '{}'
```
