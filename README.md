# Hypertrade

A personal market terminal and signal platform for crypto perps. It tracks assets, simulates allocation branches against historical data, monitors sector dynamics, and runs an always-on worker that scans Hyperliquid and surfaces ranked setups.

Surfaces: the platform cockpit (`/`) and Terminal (`/terminal`), Intel, Desk, Lab, Analyst, and the hypertrade routine (a scheduled Claude session that commits research to `data/*.json`: every 4 h it scans the top-30 Hyperliquid perps on their 4h/1d/1w bars, names where positioning is imbalanced and writes conditional setups through a code gate; market state, sectors and the Lab snapshot once a day, Lab search weekly; one ntfy push only when something is new; see `ROUTINE.md`).

## Status

- **Live in the repo (master):** the platform backend in `src/server/platform/` (scanner, crawler, liquidation map, outcomes, alerts loops) on one Bun process, the cockpit UI, `/api/platform/*`, and the routine pipeline (`bun run routine`: board scan, tripwires, setups ledger, daily brief; Opus 5.5 by default, Kimi as fallback).
- **Hosting:** free tier first. Vercel serves the UI and API, a GitHub Actions hourly tick (`.github/workflows/platform-tick.yml`, `bun run platform:tick`) runs the platform worker loops against Postgres, and the Claude routine commits research. The always-on Railway worker below is the upgrade path for when live mids (order approval) or sub-hourly scans become a hard requirement. History in `docs/TASKS.md`.
- **Not committed yet:** an Ink terminal UI under `src/tui/` (`bun run tui`) with `SPEC-tui.md` and `DESIGN-tui.md`.

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

The database is Supabase Postgres. The app has run on Vercel (static UI, serverless API, crons in `vercel.json`); the upgrade path is the single always-on Railway service below. Set environment variables from `.env.example` in whichever host is active.

## Railway (always-on backend, phase 8)

One Bun process (`scripts/server.ts`) serves the API, the built UI and the platform worker loops (scanner, crawler, liqmap, outcomes, alerts, desk, Telegram). Follow the steps in order: migrations before the first boot, restricted role after migrations.

1. **Create the service.** New Railway project, deploy from this GitHub repo. Builder: `Dockerfile` (Railpack does not detect Bun). Region: `asia-southeast1` (Singapore). Generate a public domain under Networking. Healthcheck path: `/api/health` (public, no login).
2. **Database.** Set `DATABASE_URL` to the Supabase transaction pooler URL (port 6543, IPv4). Railway egress is IPv4 by default, and `prepare: false` is already set in code. Set `DB_POOL_MAX=4`. For the first deploy set `MIGRATE_ON_BOOT=1`, or run `bun run db:migrate` once with the owner URL. Migrations apply in name order, one transaction each, under an advisory lock, so concurrent boots cannot race. An existing database re-applies `001`–`010` once; they are idempotent. `011`–`013` add the platform tables, the gate hardening and the dedupe index.
3. **Restricted app role (recommended).** `ledger_entries` is append-only through a trigger. Only the table owner can drop or disable that trigger, so run the app as a non-owner role. Run this in the Supabase SQL editor as `postgres`, after step 2 (the `revoke` needs the table to exist). Replace the password and keep it in Railway only.

   ```sql
   create role hypertrade_app login password '<generated>';
   grant usage on schema public to hypertrade_app;
   grant select, insert, update, delete on all tables in schema public to hypertrade_app;
   grant usage, select on all sequences in schema public to hypertrade_app;
   alter default privileges for role postgres in schema public
     grant select, insert, update, delete on tables to hypertrade_app;
   alter default privileges for role postgres in schema public
     grant usage, select on sequences to hypertrade_app;
   revoke update, delete, truncate on ledger_entries from hypertrade_app;
   -- Supabase exposes public over PostgREST to the anon key: shut that door. Covers every
   -- table, older ones (001–010) included; the app talks Postgres directly, not PostgREST.
   revoke all on all tables in schema public from anon, authenticated;
   alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
   -- RLS with no anon/authenticated policy: PostgREST is denied even if a grant comes back.
   -- The owner bypasses RLS; hypertrade_app gets the only policy (RLS binds every non-owner role).
   alter table ledger_entries enable row level security;
   alter table opportunities enable row level security;
   drop policy if exists app_all on ledger_entries;
   create policy app_all on ledger_entries for all to hypertrade_app using (true) with check (true);
   drop policy if exists app_all on opportunities;
   create policy app_all on opportunities for all to hypertrade_app using (true) with check (true);
   ```

   Point `DATABASE_URL` at the same pooler with the `hypertrade_app` user (Supabase usually wants `hypertrade_app.<project-ref>`; copy the exact string from the Connect panel). Leave `MIGRATE_ON_BOOT` unset: this role cannot create tables. Migrations run as the owner, with `DATABASE_URL=<owner pooler URL> bun run db:migrate`. There is no separate migrate URL.
4. **Environment variables.** Set these on the Railway service. Never commit values.

   Required:

   | Variable | Purpose |
   | --- | --- |
   | `APP_PASSWORD` | Login password for the cockpit and terminal. |
   | `SESSION_SECRET` | Signs the session cookie. |
   | `CRON_TOKEN` | Sent as `x-cron-token` to `/api/cron/*`. Must match the GitHub secret. `CRON_SECRET` is accepted as a bearer alternative. |
   | `APP_URL` | Public origin, no trailing slash. Builds Telegram links. Set it on Railway as well as in GitHub. |

   Optional, for the worker and platform (defaults in parentheses):

   | Variable | Purpose |
   | --- | --- |
   | `PORT` (8787) | Listen port. Railway sets it. |
   | `DATABASE_URL` (unset) | Postgres. Without it the store is in memory and nothing survives a restart. `DATABASE_POSTGRES_URL` and `POSTGRES_URL` are also read. |
   | `DB_POOL_MAX` (1) | Connection pool size. Use 4. |
   | `DB_QUERY_TIMEOUT_MS` (30000) | Per-query timeout. |
   | `MIGRATE_ON_BOOT` (unset) | `1` runs migrations before serving. Needs `DATABASE_URL`. |
   | `WORKER_LOOPS` (`all`) | `all`, `off`, or a comma list of `ws`, `scanner`, `crawler`, `liqmap`, `outcomes`, `alerts`, `prune`, `desk`, `telegram`. |
   | `PLATFORM_SCAN_INTERVAL_SEC` (60) | Universe scan period. |
   | `PLATFORM_COST_TOP_N` (25) | Coins costed from `l2Book` per scan. |
   | `PLATFORM_LIQMAP_COINS` (30) | Coins in each 15-minute liquidation snapshot. |
   | `PLATFORM_CRAWL_WEIGHT_PER_MIN` (800) | Hyperliquid weight budget for the crawler. |
   | `PLATFORM_CRAWL_MAX_AGE_MIN` (30) | Max age of a poll for addresses with open positions. |
   | `PLATFORM_RETENTION_DAYS` (14) | Pruning window for snapshot and history tables. The ledger is never pruned. |
   | `PLATFORM_OUTCOME_HORIZONS` (`1h,4h,24h,72h`) | Outcome horizons. |
   | `PLATFORM_EDGE_MIN_N` (30) | Resolved outcomes needed before edge leaves `unvalidated`. |
   | `PLATFORM_READY_TTL_MIN` (60) | Minutes before an undecided `ready` opportunity expires. |
   | `PLATFORM_RESEARCH_SCORE` (4) | Reserved; research is operator-triggered in phase 8. |
   | `PLATFORM_PUSH_SCORE` (3) | Score that triggers a Telegram alert on `ready`. |
   | `PLATFORM_MY_MARKETS` (`BTC,ETH,HYPE,SOL,XPL,LIT,ZEC`) | "My markets": added to the novelty universe and to `lab_event_study` with `mine`. |
   | `PLATFORM_NOVELTY_UNIVERSE` (unset) | Novelty universe: `;`-separated `mine`, `top:N`, `sectors:AI,Perp DEX`. Unset: liquidity tier 1 plus my markets. |
   | `PLATFORM_SCAN_UNIVERSE` (unset) | Coins the scanner runs setups on, same syntax as `PLATFORM_NOVELTY_UNIVERSE`. Liquidity tiers still rank the whole universe. Unset: every live coin. |
   | `DESK_WORKER_TICK_SEC` (60) | Desk watch tick period, minimum 30. |
   | `DESK_MAX_CYCLES_PER_DAY` (8) | Agent cycle budget per day. |
   | `DESK_TELEGRAM_BOT_TOKEN`, `DESK_TELEGRAM_CHAT_ID` (unset) | Both needed for the Telegram loop. Without them it does not run. |
   | `DESK_TELEGRAM_WEBHOOK_SECRET` (unset) | If set, the Telegram long-poll turns off (webhook mode). Leave unset so the worker polls. |
   | `NTFY_TOPIC` (unset) | Push alerts to this ntfy topic. `NTFY_SERVER` (`https://ntfy.sh`) and `NTFY_TOKEN` (bearer token, protected topics) are optional. |
   | `ANTHROPIC_API_KEY` (unset) | Optional LLM key for the analyst and desk. See Analyst. |

5. **Cut over from Vercel.**
   - GitHub Actions secret `APP_URL` = the Railway origin. The collect, lab and intel jobs now call the worker.
   - Repository variable `DESK_ENABLED=false`. The desk tick runs inside the worker now; leaving the job on runs two ticks per window.
   - `INTEL_ENABLED` stays as it was.
   - `vercel.json` still schedules collect, lab-collect and backfill on Vercel. Pause the Vercel project after one green day on Railway.
   - Telegram review links open `/terminal?review=1`.
6. **Verify.**

   ```bash
   curl -sS "$APP_URL/api/health"
   ```

   Expect `"store":"pg"`, every entry in `loops` with `"ok":true`, `ws.state` `"open"`, `scanAgeSec` under 90, and `crawler.pollsPerMin` above 0. The crawler reads 0 until the WebSocket has supplied trader addresses. Z-scores need history: the scanner ring spans 24 h, is persisted every 5 min to `scan_snapshots`, and is reloaded at boot. Expect thin features on a fresh database.
7. **Local run.**

   ```bash
   WORKER_LOOPS=all bun run start                       # no DATABASE_URL: memory store
   docker build -t hypertrade . && docker run -p 8787:8787 --env-file .env hypertrade
   ```

Cost: Hobby plan is about $5/mo plus usage. At 0.5 vCPU and 512 MB, usage is about $15/mo at the rates in the research notes. Check current Railway pricing before relying on this.

## Routine (scheduled Claude session)

The runbook is `ROUTINE.md`. One 4 h trigger dispatches by clock: the board scan every run; market state, sectors and post-mortems of closed setups daily; a journal of your HL fills against the ledger on Sundays; a review of templates, conviction and Lab rules on Mondays; one tune PR to `src/server/routine/` a month, which a human merges. Lessons accumulate in `data/playbook.md`, which every run reads. The board run collects the board (`bun run routine --collect-only`: top-30 perps by volume plus majors and `PLATFORM_MY_MARKETS`, with 4h/1d/1w structure, funding vs its own week and vs Binance/Bybit, OI change from the committed `data/board/history.json`, and a level menu), reads it, and writes setups that code resolves, gates and grades (`data/setups/ledger.json`). `bun run signals:collect` adds an optional snapshot of the platform's intraday signals. One ntfy push through the desk notifier only when something is new. Secrets in the cloud environment:

| Variable | Purpose |
| --- | --- |
| `APP_URL`, `LAB_API_TOKEN` | Worker origin and the read bearer (GETs under `/api/platform`, `/api/intel`, and `/api/lab/trials` for authored ideas; `LAB_URL=$APP_URL` for the Lab CLI). The session needs no `DATABASE_URL`: it has no route to Postgres. |
| `NTFY_TOPIC` (`NTFY_SERVER`, `NTFY_TOKEN` optional) | The push channel. No Telegram setup is needed. |
| `DESK_WATCH_ADDRESS` (optional) | Your Hyperliquid account, read-only, for the Sunday journal. |

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

## Desk (optional)

`/desk` is an agentic portfolio desk: a portfolio-manager agent that runs a
team of specialist "scout" agents, answers market questions, proposes and
manages trades, and alerts you. Code: `src/server/desk/*`,
`src/server/routes/desk.ts`, `src/ui/pages/Desk.tsx`, `scripts/desk-worker.ts`.
Needs `db/migrations/003_desk.sql` and any analyst provider key.

**Models.** Anthropic goes first. With an Anthropic key (`ANTHROPIC_API_KEY`
or `ANALYST_ANTHROPIC_API_KEY`) the PM runs Claude Opus 5.5 at high effort and
scouts run Claude Sonnet 5.5 at medium, whatever `ANALYST_PROVIDER` and
`DESK_SCOUT_PROVIDER` say. `DESK_ANALYST_MODEL` / `DESK_SCOUT_MODEL` still pick
the model when they name a Claude model. `DESK_ANTHROPIC_FIRST=false` turns
this off.

Without an Anthropic key (or with it turned off), the PM, like the interactive
`/analyst`, runs `DESK_ANALYST_MODEL` on the server's default provider. Scouts
run on the same provider and model unless overridden: `DESK_SCOUT_MODEL` picks
a different model on that provider, and `DESK_SCOUT_PROVIDER` moves scouts to a
different provider entirely (any id from the Analyst provider table below).
If `DESK_SCOUT_PROVIDER` can't resolve (no key, unknown provider/model), scouts
fall back to the analyst's provider and the server logs a warning once.

**Web search.** Set `EXA_API_KEY` to give both the Analyst and every Desk
scout a real `web_search` tool (Exa's "Instant" search, `src/server/llm/tools.ts`),
regardless of provider — this is what makes the `news` and `macro` scouts
below actually able to search; without it they can only reason over the
app's own data. Moonshot's own built-in `$web_search` tool is not wired up
here: Moonshot has flagged it for deprecation (retiring 2026-10-20) in favor
of standalone search endpoints that would need a real integration, not a
small change.

**The team.** The PM (`agents.ts`) calls `consult_specialists` to run several
scouts in parallel, or `spawn_agent` to start an ad-hoc analyst with a
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
(`DESK_ALERT_WEBHOOK_URL`) and ntfy (`NTFY_TOPIC`) also work. Every alert is stored and shown on the
page. All `DESK_*` settings are listed in `.env.example`.

## Intel (the Terminal)

The Terminal (`/` and `/journal`, `/theses`, `/query`, `/order`, `/watch`;
docs/SPEC.md § Intel) reads `/api/intel/*`. Code: `src/server/intel/*`,
`src/server/routes/intel/*`. Needs `db/migrations/007_intel.sql` (plus 008, 009 and
010, see Setup below); LLM features
use the Desk's model resolution and alerts go through the Desk notifier.
Orders from `/order` go to the Desk venue only (paper or testnet), always
preview → confirm. `GET /api/intel/*` also accepts the `LAB_API_TOKEN` bearer;
writes need the session cookie.

Background jobs: `POST /api/cron/intel/{ingest,brief,graph,watch}`
(x-cron-token), each leased and budgeted to 200 s. `collect.yml`'s `intel` job
calls all four after `collect` every 15 minutes once the repo variable
`INTEL_ENABLED=true` is set; brief self-throttles to `INTEL_BRIEF_HOURS`,
graph to once a day, watch rechecks a watch at most hourly. There is no
Vercel Cron fallback: every intel job stays behind `INTEL_ENABLED`.

| env | |
|---|---|
| `INTEL_MIN_Z` | \|z\| a change must clear to reach the brief, default 2 |
| `INTEL_TOP_K` | brief items kept after ranking, default 5 |
| `INTEL_PUSH_MATERIALITY` | alert threshold: items at or above it push to Telegram now, and flow flags at or above it are eligible for auto-research; default 0.35 |
| `INTEL_DIGEST_MATERIALITY` | digest floor: items below it are hidden from the digest (still logged); default 0.10 |
| `INTEL_RESEARCH_DAILY` | manual research runs per UTC day, default 10 |
| `INTEL_RESEARCH_AUTO_DAILY` | automatic (flow-flag) research runs per UTC day, default 3 |
| `INTEL_LLM_DAILY_CAP` | Intel LLM calls per day before failing closed, default 200 |
| `INTEL_LLM_DAILY_USD` | Intel LLM spend per UTC day (usage × model price) before failing closed, default 2.00 |
| `INTEL_BRIEF_HOURS` | cron brief at most every N hours, default 6 |
| `INTEL_TZ` | journal session clock (asia/eu/us by hour), default UTC |
| `INTEL_RSS_FEEDS` | comma-separated RSS/Atom URLs; default a built-in keyless list |
| `INTEL_SNAPSHOT_SPACES` | Snapshot governance map `ASSET=space.eth,…`; replaces the built-in map |
| `INTEL_WEBSEARCH` | `true` enables the hourly LLM web-search headline sweep |
| `INTEL_TG_CHANNELS` | comma-separated public Telegram channels (read via `t.me/s/<channel>`) |
| `X_BEARER_TOKEN`, `INTEL_X_LIST_ID` | X list timeline ingest; both required |
| `INTEL_RPC_<CHAIN>` | RPC override for the contract/wallet watcher (`ETHEREUM`, `ARBITRUM`, `BASE`, `OPTIMISM`, `POLYGON`, `BSC`, `AVALANCHE`, `HYPEREVM`); default public RPCs |
| `DATABASE_URL_READONLY` | read-only Postgres role for `/api/intel/query/run`; default the main connection |
| `COINALYZE_API_KEY` | Coinalyze flow collector in the collect cron (free key, 40 calls/min); unset → no flow rows and the heatmap's flow status reads `no_source` |
| `bun scripts/backfill-oi.ts [COIN ...]` | one-off Coinalyze daily OI backfill into `hl.oi.<COIN>` (needs `COINALYZE_API_KEY`, `DATABASE_URL`); idempotent, the novelty loop also runs it once per coin per process |
| `INTEL_FLOW_MAX_COINS` | held ∪ watched coins the flow collector covers (by notional, then watch order), 1–20, default 8 |
| `INTEL_THRESHOLDS` | threshold-crossing events, comma list of `metric>value` / `metric<value`; default `funding>0.0000625` (0.05%/8 h, hourly) |
| `INTEL_DELEV_OI_PCT` | deleveraging detector's OI 6 h drop, in %, default 8 |
| repo var `INTEL_ENABLED` | `true` turns on the workflow's `intel` job |

### How the Terminal works

`/` is now the Terminal. It shows what changed since your last look, measured
against your positions and watchlist: a ranked diff, the alerts and catalysts
that touch those assets, and a short brief. The Overview that used to live at
`/` moved unchanged to `/overview`. Design: `docs/design/terminal.md`. Spec: docs/SPEC.md
§ Intel. Code: `src/server/intel/*`, `src/server/routes/intel/*`,
`src/ui/pages/terminal/*`.

**Routes.** Seven, sharing one sub-tab strip:

| route | what it does |
|---|---|
| `/` | Terminal: brief, alerts, catalysts, exposure. A UI open logs a review. |
| `/journal` | Round trips from the watched address and the Desk paper book, with session, hold time, R, MAE/MFE, per-tag stats and a weekly report. |
| `/theses` | Paste a thesis. The LLM extracts claims; code checks each against a fixed catalogue. |
| `/query` | Natural language to a screener DSL over the snapshot store. The DSL is editable; the SQL is shown read-only. |
| `/order` | Order copilot, preview then confirm (below). |
| `/watch` | Watches on URLs, EVM contracts and EVM wallets. Changes are summarised and routed to exposed assets only. |
| `/overview` | The former Overview, unchanged. |

Telegram deep links to `/?review=1` open the Terminal and log a review.

**Positions.** Three sources, unified at read time into one shape. `manual`
rows live in `intel_positions` and are edited from the Terminal. `hl` is the
account at `DESK_WATCH_ADDRESS`, read-only. `desk` is the Desk's paper or
testnet book. A source that fails is listed in `sources` with its error and
contributes nothing; the page still loads. The watchlist is `intel_watchlist`,
falling back to `DESK_WATCHLIST` when it is empty.

**Snapshot store.** `intel_snapshots` holds one row per asset per tick: price,
24 h volume, funding, open interest, premium, basis, and book depth and spread.
`POST /api/cron/collect` writes it every 15 minutes from the `metaAndAssetCtxs`
fetch it already makes. Assets are held, watched, and the top 20 by open
interest. Order book depth comes from `l2Book` for held and watched coins only
(at most 25). Rows are kept 90 days and pruned by the backfill job. A metric
with fewer than 24 samples gets no z-score and is skipped, not read as zero.

**What the LLM does.** It turns text into structure: extracts events and
clusters from feeds, writes one line on how a change touches a position,
extracts thesis claims, parses queries and order intents, proposes exposure
edges, summarises watched contract changes, narrates the brief and tags journal
trades. It does not predict direction, set price targets, size positions,
send orders, or decide what is material. Materiality is code:
`|z| × exposure weight × stop proximity`. Only a change clearing `INTEL_MIN_Z`
reaches the brief, and if nothing does, the brief is silent.

Every LLM line carries a claim tag. `observed` (shown as OBS) needs a source
and a timestamp. `hypothesis` (shown as HYP) needs neither. Lines with no tag,
or an `observed` tag without a source and timestamp, are dropped before display
and counted in the trace. If every line is dropped, the brief shows the ranked
table without prose. Calls go through `completeStructured`
(`src/server/intel/llm.ts`) on the Desk's model resolution: the cheap tier for
extraction and tagging, the strong tier for narration and parsing. Results are
cached in `intel_llm_cache`. Web search is off unless a call asks for it. Over
`INTEL_LLM_DAILY_CAP` calls a day, calls fail closed and the UI says so.

**Cron.** `POST /api/cron/intel/{ingest,brief,graph,watch}` with
`x-cron-token`. Each takes a lease and stops within 200 s. Ingest runs every
15 minutes (sources, mapper, catalyst alerts). Brief runs every
`INTEL_BRIEF_HOURS` (default 6). It messages Telegram only when something
clears the threshold, and it never marks a review. Graph runs once a day, and
watch checks each watch at most hourly. The `intel` job in
`.github/workflows/collect.yml` calls all four after `collect`, and only when
the repo variable `INTEL_ENABLED` is `true`. Vercel Cron does not run any
intel job, so nothing bypasses that gate.

**Setup.** Apply `db/migrations/007_intel.sql` before enabling anything. It
creates every `intel_*` table the Terminal reads, and the routes do not work
without it. Then `008_intel_stops.sql` (stop triggers of the watched HL
account, for journal R; without it the capture is skipped and reported).
`009_flow.sql` (non-HL venue flow rows; without it the flow collector, heatmap
and digest log fail) and `010_research.sql` (research runs and their lock;
without it `/api/intel/research` and auto-research fail). Apply 009 and 010
before deploying this code, as with 002, 003, 004 and 007.
Environment variables are in the table under
[Intel (optional)](#intel-optional), which also covers `INTEL_ENABLED`;
`.env.example` lists the same keys.

### Research

The RESEARCH panel on `/` asks one question about a coin (optionally tied to a
flow flag) and returns an explanation, evidence and open questions. Routes:
`POST /api/intel/research` (`{question, asset?, flagId?}`; 429 at the daily
limit, 409 while another run is in flight) and `GET /api/intel/research`
(recent runs, `usedToday`, `limit`). A flow-flag chip's action posts the chip
question with the flag id. The ingest job also researches the strongest
unexplained flags on its own. Limits: `INTEL_RESEARCH_DAILY` manual and
`INTEL_RESEARCH_AUTO_DAILY` automatic runs per UTC day, at most 8 web searches
and 45 s per run, and the `INTEL_LLM_DAILY_USD` spend cap. Evidence that cites
a source and time is `observed`; everything else is a `hypothesis`, and any
number that is not in the inputs is dropped.

**Order copilot.** Paper or Hyperliquid testnet only. Mainnet is not
selectable; the Desk venue config refuses it.

1. `POST /api/intel/order/preview` takes text or a parsed intent (asset, side,
   size, entry, stop, optional target). It resolves the stop from candles and
   returns size, liquidation price, risk as a percentage of the book, and the
   governor verdict with its warnings. A missing target skips the reward:risk
   check and warns.
2. `POST /api/intel/order/confirm` takes the intent and the preview hash. Only
   this call executes anything, and only on the operator's click in the UI.
   It re-resolves on fresh data. It answers 409 if the preview is stale (the
   live mark has moved more than 0.5%) or the hash does not match.

The governor's rules run again at confirm, through `evaluateRisk` (extracted
from `evaluateOpen`). Operator orders are recorded as `operator:copilot`. The
Desk's approval mode does not change this path. Nothing executes autonomously.

**Known limits.**

- No embeddings, because there is no keyless embedding source. Clustering uses
  token-shingle Jaccard ≥ 0.5 within 48 h, then merges on shared entities.
  Two headlines with different words about the same event may not cluster.
- Hyperliquid journal trades carry no stop, so their R is blank. The journal's
  stop lookup for `hl` is not wired. Desk trades take R from the proposal's
  stop.
- The macro calendar (`src/server/intel/calendar.ts`) is static: FOMC, CPI
  and NFP dates for 2026 and 2027 only, and the 2027 BLS dates are estimates.
  Check it against the published calendars each year and add the next one.
  After 2027 the calendar is empty.
- Snapshots are 15 minutes apart. Five-minute ticks were rejected because
  Actions jitter makes them unreliable.
- Feedback (up or down per alert) feeds a weekly report. Thresholds and
  weights are not tuned automatically. The one automatic effect: a bucket with
  at least 5 votes in 30 days and a net score of −60% or worse has its pushes
  demoted to the brief. It is never dropped.
- The doc watcher does not render JavaScript pages. Bot-blocked and
  JS-rendered pages fail visibly with the HTTP code or empty text.
- X and Telegram ingest are optional. X needs `X_BEARER_TOKEN` and
  `INTEL_X_LIST_ID`. Telegram channels (`INTEL_TG_CHANNELS`) are read from
  `t.me/s/<channel>`. Vercel IPs are often refused there; the failure is
  recorded, not retried. The Terminal works without either.
- Intel messages go through the Desk notifier, so nothing is sent to Telegram
  or Discord unless the Desk's alert settings are configured.

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
decisions), plus web search — real-time search via Exa (`EXA_API_KEY`, any
provider) when configured, else Anthropic's own native search on Anthropic
models only. It never places or approves anything; Jev and the operator own
the trading loop. Server:
`src/server/llm/*`, `src/server/routes/analyst.ts` (`POST /api/analyst/query`,
SSE; `GET /api/analyst/models`, the model catalog). UI: `src/ui/pages/Analyst.tsx`
and `src/ui/components/analyst/*`.

### Providers

Configure any number; the model picker lets the operator choose per question
(persisted per browser). Setting a provider's key is all it takes: its
curated models appear in the picker.

| Provider (`id`) | Key env var | Models (checked 2026-10-01) | Effort | Notes |
|---|---|---|---|---|
| Anthropic (`anthropic`) | `ANALYST_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY` | Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5 | low…max (not Haiku) | Native web search (superseded by Exa when `EXA_API_KEY` is set); refusal fallbacks; summarized thinking |
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
- `ANALYST_API_KEY` / `ANALYST_BASE_URL` / `DESK_ANALYST_MODEL` — the default
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

## Paths (simulate mode)

`/analyst` has a `SIMULATE` toggle next to `ASK`. Type a loose intent and get
simulated wealth paths: one or more branches, each with an equity curve against
the BTC/USDC benchmarks, drawdown and stats. Historical simulation, not advice.

Example prompts:

- "what if I'd put 30% of my stack into SOL perps at 3x and DCA'd ETH weekly since January"
- "hedge my ETH with a short BTC position"
- "compare 60/40 ETH/USDC against 100% BTC since 2023"

How it works:

- LLM calls `simulate_paths`; the JSON is validated with zod (`SimIntentSchema`), normalized by the `runIntent` adapter (`src/server/sim/intent.ts`), then run by the engine (`src/server/sim/engine.ts`).
- Each result streams to the thread as a `sim_result` SSE event (one card per call, branches side by side).
- `SAVE AS BRANCH` posts to the existing `POST /api/branches`; the saved branch opens at `/branches/:id`.
- A follow-up message forks the previous intent ("same but 5x") instead of re-guessing it.

New branch config fields (all optional, old configs unchanged):

- `allocations[].side`: `"long"` (default) or `"short"`; short makes a perp leg.
- `allocations[].leverage`: 1–50, default 1; above 1 makes a perp leg.
- `dca`: `[{ coin, amountUsd, every: "weekly" | "monthly" }]`, funded from the USDC/USDT sleeve; forces `rebalance: "none"`.

Limits:

- Simulation only: no orders, no Desk, no paper or testnet trades.
- Default stack $10,000 unless the user states an amount; inferred holdings are shown as assumptions.
- Perp legs ignore funding and fees, have no maintenance margin, and liquidate on the daily low/high (close when unavailable).
- Monte Carlo is skipped for branches with perp legs.
- The `simulate_paths` tool has a 40 s deadline; on timeout the model gets an error instead.

## Lab (heuristic research)

`/lab` and its tools search a metric universe for simple, human-readable
trading rules ("when `cm:CapMVRVCur` z(90) < −1.1 and `ht:funding` ≥ 0, go long
BTC"), score them as strategies net of slippage, validate them walk-forward and
on a holdout, and track the ones you save in a catalogue with live
performance, health checks and a Market Pulse. It rebuilds the methodology
Glassnode published for Alpha Lab over keyless data. Full spec and the tool
contract: [`docs/LAB.md`](docs/LAB.md). Results are historical research, not advice.

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
| `LAB_API_TOKEN` | comma-separated bearer tokens accepted on `/api/lab/*` and `/api/mcp` (any method), plus `GET /api/metrics/*`, `GET /api/sectors`, `GET /api/marketstate*` and `GET /api/intel/*` (the session cookie also works everywhere) |
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
