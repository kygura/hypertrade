# HYPERTRADE — Personal Market Terminal

A single deployable web application merging three prior projects (`../hyperion`, `../marketwatch`, `../marketstate`) into one personal tool, usable on laptop and mobile, deployed on Vercel.

## Product pillars

1. **Assets & Branches** — track a portfolio of crypto assets and simulate alternate allocation strategies ("branches"). A branch is a named, editable allocation strategy (e.g. "60/40 ETH-stables, rebalance monthly") evaluated against real historical price data and projectable forward under speculative scenarios.
2. **Backfill & Speculation** — historical price data is backfilled (CoinGecko daily OHLC, Hyperliquid candles) so branches show *what would have happened*, and forward projections show *what could happen* under user-set scenario assumptions (asset return/vol assumptions, rotation events).
3. **Sector Intelligence** — an autonomous layer tracking perp mechanics (open interest, aggregate funding skew, premium) plus a sector/narrative mindshare map. Sector taxonomy is NOT hardcoded: it is produced and re-defined by the cloud routine (see Routine Contract) and enriched server-side with quantitative per-sector metrics from Hyperliquid data. Goal: visualize where mindshare/liquidity is rotating before price follows.
4. **MarketState Briefing** — the existing marketstate Claude routine, upgraded: runs in the user's Anthropic cloud environment (managed from Claude Desktop), commits its output to this repo, and is triggerable from the app. The app renders the latest briefing and its history.

## Runtime shape (decided — do not relitigate)

- **Hosting**: Vercel. Git-connected; pushes to the repo redeploy the app. Routine outputs are committed files, so a routine run = fresh deploy with fresh data.
- **Frontend**: React 19 + Vite + TypeScript + Tailwind CSS v4 (CSS-native `@theme`, no tailwind.config). Recharts for charts (lightweight-charts for the markets drill-in chart). React Router. Fonts: Geist Mono via `geist` package (self-hosted woff2), monospace everywhere — inherited from Hyperion.
- **Backend**: Hono on Vercel Functions — one catch-all function at `api/index.ts` serving `/api/*`. Runtime: Node (Vercel default), code written to also run under `bun dev` locally.
- **Database**: Supabase Postgres (hosted; serverless has no disk). Accessed from API routes via `postgres` (postgres.js) with `DATABASE_URL`. No Supabase client SDK needed — plain SQL through a thin data layer.
- **Scheduling**: Vercel cron cannot run sub-daily on Hobby, so collection is an authenticated endpoint `POST /api/cron/collect` (header `x-cron-token: $CRON_TOKEN`) triggered by a GitHub Actions workflow on `schedule` (every 15 min) living in this repo (`.github/workflows/collect.yml`). A daily Vercel cron entry hits the same endpoint as fallback.
- **LLM**: routine work (briefings, sector maps) still happens in the user's cloud Claude routine, which writes results into `data/` and pushes. One exception, decided by the operator in phase 2: the **Analyst** (`/analyst`, `POST /api/analyst/query`) makes server-side LLM calls to answer natural-language questions over the app's data and the web. It is read-only market intelligence: its tools only read (briefings, sectors, metrics, series, Hyperliquid markets, engine strategies and decisions) and it has no tool that places, approves, rejects or configures anything. Jev stays the only model inside the Hyperion engine's loop (hyperion `docs/jev/SPEC.md`). The **Desk** (phase 3, below) is the second LLM surface and the first that acts: its agents propose trades into its own paper book through a deterministic governor. Any number of providers can be configured at once — `anthropic` (Messages API with streaming, client tools, Anthropic's server-side web search and refusal fallbacks; catalog: Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 4.5, `src/server/llm/catalog.ts`), the vendor presets `openai`, `google` (Gemini), `xai`, `deepseek`, `moonshot` (Kimi), `qwen` and `openrouter` (`src/server/llm/presets.ts`: Chat Completions with per-model reasoning controls; no web search), and the generic `openai-compatible` slot for any other `/chat/completions` endpoint — with `ANALYST_PROVIDER` (default `anthropic`) naming the server default; `POST /api/analyst/query` accepts an optional `provider`/`model`/`effort` per question, validated against `GET /api/analyst/models`'s catalog (400 with the offending field on a bad choice). A model/provider selector in the page header lets the operator pick per question; see README.md "Analyst" for the full env var precedence. Keys never leave the server. Bounds: 8 tool rounds, 90 s per question.
- **Auth**: single password (env `APP_PASSWORD`), login form → HMAC-signed session cookie (`SESSION_SECRET`), 30-day expiry, middleware guards all `/api/*` except `/api/health`, `/api/cron/collect` (token-guarded instead), `/api/auth/login` and `/api/auth/logout`. Frontend route guard redirects to `/login`.
- **Package manager**: bun. Single package (no workspaces): Vite app at repo root, `api/` for the function, `src/` for frontend, `src/shared/` for code imported by both sides.

## Directory layout (pinned — workers must follow)

```
app/
  api/index.ts            # Hono app, exported for Vercel; all routes under src/server/
  src/
    server/               # route handlers, auth, collectors, db access (imported by api/index.ts)
      db.ts               # postgres.js client + query helpers
      auth.ts             # login, session HMAC, middleware
      collectors/         # hyperliquid.ts, cryptoContext.ts, fred.ts (ported), elfa.ts (optional, keyed)
      routes/             # branches.ts, metrics.ts, sectors.ts, marketstate.ts, cron.ts, auth.ts
      sim/                # branch simulation engine
    shared/               # isomorphic: types.ts, schemas.ts (zod), stats.ts, baseline.ts, format.ts, hl-client.ts
    ui/                   # React app: main.tsx, App.tsx, routes/, components/, index.css (design tokens)
  data/
    marketstate/          # routine-written: latest.json + YYYY-MM-DD.json history
    sectors/              # routine-written: latest.json + YYYY-MM-DD.json history
  db/migrations/          # 001_init.sql ... (applied to Supabase)
  .github/workflows/collect.yml
  ROUTINE.md              # contract for the cloud routine (what to read, what to write, how to push)
  vercel.json             # rewrites: /api/* -> function; daily cron fallback
  SPEC.md DESIGN.md TASKS.md README.md .env.example
```

## Data model (Postgres)

Ported from marketwatch's "everything is a series" design:

- `series(id text primary key, source text, units text, description text)`
- `observations(series_id text references series, ts timestamptz, value double precision, primary key(series_id, ts))`
- `collector_runs(id bigserial primary key, collector text, started_at timestamptz, finished_at timestamptz, ok boolean, error text)`
- `candles(coin text, tf text, ts timestamptz, o double precision, h double precision, l double precision, c double precision, v double precision, src text, primary key(coin, tf, ts))` — chart and simulator history at every timeframe (`1m 5m 15m 1h 4h 1d 1w 1M`); `src` is the venue (`hl`, `binance`, `bitstamp`)
- `sync_state(coin text, series text, hl_floor timestamptz, ext jsonb, synced_at timestamptz, accessed_at timestamptz, error text, primary key(coin, series))` — per-series sync bookkeeping (series = a timeframe or `funding`)
- `funding(coin text, ts timestamptz, rate double precision, premium double precision, primary key(coin, ts))` — hourly Hyperliquid funding settlements
- `branches(id uuid primary key default gen_random_uuid(), name text not null, config jsonb not null, created_at timestamptz default now(), updated_at timestamptz default now())`
- `branch_results(branch_id uuid references branches on delete cascade, computed_at timestamptz, result jsonb, primary key(branch_id))` — latest simulation output cache

Series naming: `hl.total_oi_usd`, `hl.funding_skew`, `hl.premium.<coin>`, `hl.oi.<coin>` (top 20 by OI plus core, branch and recently charted coins — the chart's OI history), `hl.funding.<coin>`, `cg.total_mcap_usd`, `cg.btc_dominance`, `fng.value`, `llama.stablecoin_cap_usd`, `fred.<SERIES_ID>` (fred optional — degrade to `skipped:no-key` when `FRED_API_KEY` unset, marketstate pattern), `elfa.mentions_24h.<coin>`, `elfa.share_24h.<coin>`, `elfa.mentions_chg_24h.<coin>`, `elfa.mentions_24h_total` (elfa optional, same `skipped:no-key` pattern for `ELFA_API_KEY`; self-throttled to `ELFA_MIN_INTERVAL_HOURS`, see README "Social attention").

## Branch model (`branches.config` jsonb)

```jsonc
{
  "description": "optional prose",
  "startDate": "2024-01-01",
  "initialCapitalUsd": 10000,
  "allocations": [{ "coin": "ETH", "weightPct": 60 }, { "coin": "USDC", "weightPct": 40 }],
  "rebalance": "none" | "monthly" | "weekly" | "threshold5pct",
  "scenario": {                       // optional forward projection
    "horizonDays": 180,
    "assumptions": [{ "coin": "ETH", "annualReturnPct": 40, "annualVolPct": 70 }],
    "paths": 200                      // monte carlo paths; medians + p10/p90 band reported
  }
}
```

Simulation engine (`src/server/sim/`): daily resolution over `candles` (backfilled on demand by the chart sync engine, `src/server/market/candleSync.ts`: Hyperliquid daily bars, then Binance spot and Bitstamp below HL's listing), computes equity curve, max drawdown, CAGR, vs-HODL-BTC and vs-100%-USDC benchmarks; forward monte-carlo (GBM per assumptions) when `scenario` present. Results cached in `branch_results`, recomputed on config change or explicit refresh. USDC/USDT are constant-$1 assets.

## Routine Contract (summary — full detail in ROUTINE.md, which is itself a deliverable)

The cloud routine (managed on Claude Desktop, executed in Anthropic's cloud env, checked out on this repo) is asked to:

1. Read `ROUTINE.md`, `data/` history, and live sources (it has web access + this repo's marketstate prompt corpus, which gets copied into `ROUTINE.md`'s appendix or referenced).
2. Write `data/marketstate/latest.json` + dated copy — schema:
   `{ generated_at, headline, tldr, domains: [{ domain, summary, signals: [{label, value, direction}] }], thesis: { observe, infer, forecast, disclaimer }, risks: [string] }`
   (structure derived from marketstate's 8-message DESIGN.md; hedged-vocabulary rules carried into ROUTINE.md verbatim.)
3. Write `data/sectors/latest.json` + dated copy — schema:
   `{ generated_at, sectors: [{ id, label, mindshare_score /*0-1*/, momentum /*-1..1*/, rationale, tokens: [string], sources: [string] }], rotations: [{ from, to, confidence, trigger, note }] }`
   Sector list is the routine's own judgment each run — emergent taxonomy, not fixed.
4. Commit both with `chore(data): routine run <ISO date>` and push. The push redeploys Vercel.

App-side: `data/**/*.json` files are bundled at build time via static imports — `latest.json` directly, history through routine-maintained `data/*/index.ts` static-import index files (Vercel's bundler ships no directory scans) — no runtime GitHub fetching. "Trigger routine" button → `POST /api/routines/trigger` → if `ROUTINE_WEBHOOK_URL` set, POST `{source:"hypertrade", requested_at}` to it (user wires the webhook to their cloud routine launcher); always records the request; UI shows last trigger + last `generated_at` so staleness is visible.

## API surface

- `POST /api/auth/login` `{password}` → sets cookie; `POST /api/auth/logout`
- `GET /api/health` (public)
- `POST /api/cron/collect` (x-cron-token) — runs all collectors, writes observations
- `GET /api/metrics/summary` — latest value + delta + mean30/90 + z30 per series (SQL windows; z30 = (latest − mean30) / population stddev over the 30-window, null when fewer than 5 observations)
- `GET /api/metrics/series/:id?from&to&buckets` — downsampled observations
- `GET /api/hl/markets` — live pass-through snapshot of Hyperliquid universe (price/OI/funding), short in-memory cache
- `GET/POST /api/branches`, `GET/PUT/DELETE /api/branches/:id`, `POST /api/branches/:id/run` → simulation result
- `GET /api/candles/:coin?tf&before&limit` — one page of chart bars (`tf` ∈ `1m 5m 15m 1h 4h 1d 1w 1M`, default 1d; latest page when `before` omitted; `limit` ≤ 5000, default 1500) with funding/premium/OI joined per bar; syncs the head and backfills older layers on miss → `{coin, tf, bars: [{t,o,h,l,c,v,src,f,p,oi}], hasMore, error, funding: {from, complete}, oi: {from}}`
- `GET /api/perp/:coin` — live asset context (mark/oracle/mid/premium/funding/OI/volume/impact prices/max leverage), cross-venue predicted funding, OI-cap flag, 24h/7d/30d funding averages, 24h/7d OI change
- `POST /api/cron/backfill` (x-cron-token) — keeps core, branch and recently charted coins warm: daily history, a head sync of every timeframe, funding pages; prunes 1m (30d) / 5m (120d); deadline-bounded
- `GET /api/sectors` / `GET /api/marketstate` — serve latest committed data + quant enrichment (sectors joined with live per-token OI/funding aggregates)
- `POST /api/routines/trigger`
- `/api/engine/*` — authenticated proxy to the Hyperion strategy core (`${ENGINE_URL}/api/strategy/*`, bearer `ENGINE_TOKEN`); 503 `engine not configured`, 502 `engine unreachable` / `engine timeout`
- `POST /api/analyst/query` `{question, history?, provider?, model?, effort?}` → `text/event-stream` with events `text {delta}`, `reasoning {delta}`, `tool_call {id, name, input, server}`, `tool_result {id, name, ok, summary}`, `citations {citations}`, `error {error}`, `done {usage, model, provider, label?, rounds, stop, effort?}`; `GET /api/analyst/status` → provider, label, model, web search availability, tool list; `GET /api/analyst/models` → `{default: {provider, model}, providers: [{id, label, blurb, available, reason?, webSearch, models: [{id, label, note, tier, effort, efforts?, defaultEffort?}]}]}`, always 200. Server default unconfigured → falls back to the first ready provider; nothing configured → 503 `{ "error": "analyst not configured" }`; an explicit but invalid/unavailable `provider`/`model`/`effort` choice → 400 `{ error, field }`.

## UI views (design pass produces DESIGN.md; implementation follows it)

- `/login` — password gate
- `/` **Overview** — key metrics strip (net liquidity proxies, total OI, funding skew, fear/greed, BTC dominance), MarketState headline + TLDR card, sector heat summary, portfolio/branch equity sparkline
- `/branches` — list + create; `/branches/:id` — editor (allocation table, rebalance, scenario) + equity curve vs benchmarks + drawdown + forward projection fan chart
- `/sectors` — mindshare treemap/grid of routine-defined sectors sized by mindshare, colored by momentum; rotations list; per-sector drill-in with token-level OI/funding
- `/state` — full MarketState briefing (domains, thesis with Observe/Infer/Forecast, risks) + history browser + trigger button
- `/markets` — Hyperliquid universe table (price, 24h, OI, funding) with drill-in: live perp context, multi-timeframe chart (1m–1M, stitched deep history, funding/OI/premium panes), cross-venue funding
- `/strategies`, `/strategies/:id`, `/decisions`, `/decisions/:id`, `/governor` — the **ENGINE** console: companion to the Hyperion operator terminal for the Jev-driven strategy runtime (configure, dry-run, approve/reject proposals, governor and kill switch, venues). The Overview carries a compact ENGINE card.
- `/desk` — **DESK**: agentic portfolio desk (§ Desk). Header strip (venue, equity, day PnL, model, approval mode, kill switch), ask panel with agent lanes per run (PM + specialists, tool chips, reports) and the streamed answer, runs history with replay, proposals queue (approve/reject, governor verdict, sizing), book (paper + watched HL account, close), alerts feed.
- `/analyst` — **ANALYST**: thread + rail workspace (DESIGN.md §10.8). Model/provider selector in the header (`ModelSelector`, popover desktop / bottom sheet mobile, persisted per-browser, per-model effort levels), streamed markdown answers with the model's reasoning (when exposed), a tool timeline, citations, usage, copy / ask again; rail with the prompt library, provider setup status and the tool list; session persisted per browser; OfflineBlock when no provider is configured (503) or unreachable (502/network).

Design language: iterate on Hyperion (dark-only, Geist Mono, zero radius, dense terminal aesthetic, its exact color tokens as the base) but MUST additionally work on mobile — Hyperion never solved responsive; DESIGN.md must.

## Desk (phase 3)

An agentic portfolio desk inside the app: a PM agent runs a roster of specialist agents (flows, macro/fiscal, news, on-chain, risk, narratives) and can spawn ad-hoc ones, answers operator questions ("is this rally a bull trap or genuine flow, does macro and fiscal policy support it"), and in autonomous cycles proposes entries, exits and alerts. Code: `src/server/desk/`, `src/server/routes/desk.ts`, `src/ui/pages/Desk.tsx`, `scripts/desk-worker.ts`; README.md "Desk" has the detail.

- **Models**: the analyst's provider configuration (any vendor; web search on Anthropic), `DESK_MODEL` / `DESK_SPECIALIST_MODEL` overrides; PM effort high, specialists medium.
- **Governor** (`governor.ts`): every proposal is sized and checked by deterministic rules; re-checked at execution. Agents never set size.
- **Venue**: a paper book (`paper.ts`, default) or Hyperliquid **testnet** (`hl/broker.ts`, `DESK_VENUE=hl-testnet`): entries as one signed `normalTpsl` action (IOC entry + reduce-only stop and take-profit on the exchange), flattened if the stop is rejected; the governor uses the venue's marks and equity. Mainnet is refused. A Hyperliquid address can be watched read-only (`DESK_WATCH_ADDRESS`).
- **Approval**: `auto` (governor-passed entries execute) or `manual` (entries queue for the operator; Telegram buttons or the page). Exits never wait. Kill switch blocks entries.
- **Watch tick** (`watch.ts`): paper stops/targets, day-loss limit, deterministic triggers with alerts and cooldowns; wakes the team within a daily cap. From `collect.yml` (`desk` job, `vars.DESK_ENABLED`) or the worker.
- **Data** (`db/migrations/003_desk.sql`): `desk_runs`, `desk_events`, `desk_proposals`, `desk_paper_positions`, `desk_paper_fills`, `desk_alerts`, `desk_state`.
- **API**: `POST /api/desk/ask` and `/review` (SSE of run events), `GET /status /portfolio /runs /runs/:id /proposals /alerts`, `POST /proposals/:id/approve|reject /exit /kill /paper/reset`, `PUT /approval`, `POST /tick` (x-cron-token), `POST /telegram` (Telegram secret header).

## What is explicitly OUT of scope

- Hyperliquid mainnet execution. The Desk trades paper or testnet only; the ENGINE pages only proxy operator actions to the Hyperion core, which owns its own governor and venues.
- LLM calls anywhere except the Analyst and the Desk. Multi-user/accounts. Telegram delivery. The Go TUI.

## Environment variables

`DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET`, `CRON_TOKEN`, `FRED_API_KEY` (optional), `ELFA_API_KEY` / `ELFA_MIN_INTERVAL_HOURS` (optional), `ROUTINE_WEBHOOK_URL` (optional), `ENGINE_URL` / `ENGINE_TOKEN` (optional, engine console), `ANALYST_PROVIDER` / `ANALYST_MODEL` / `ANALYST_API_KEY` / `ANALYST_BASE_URL` / `ANALYST_EFFORT` / `ANALYST_ANTHROPIC_API_KEY` / `ANALYST_OPENAI_API_KEY` / `ANALYST_OPENAI_BASE_URL` / `ANALYST_MODELS`, and the vendor keys `OPENAI_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY` / `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY` / `OPENROUTER_API_KEY` (all optional, analyst — see README.md "Analyst" for precedence and per-preset overrides)

GitHub Actions repository secrets (Settings > Secrets and variables > Actions), used by `.github/workflows/collect.yml`:

- `APP_URL` — deployed origin, e.g. `https://hypertrade.vercel.app` (no trailing slash; a trailing slash is stripped anyway).
- `CRON_TOKEN` — must match the app's `CRON_TOKEN` env var, or the endpoint returns 401.

Both are required: the workflow fails its preflight step with a named error if either is unset.

## Definition of done

- `bun install && bun run build` green (typecheck included); `bun test` green (sim engine, baseline math, auth, collector parsers — fixture-based, no live network in tests).
- Local `vercel dev`-equivalent run serves UI + API; login works; a branch can be created, simulated against real backfilled candles, and rendered.
- `POST /api/cron/collect` populates observations against a provisioned Supabase instance.
- Deployed to Vercel with Supabase provisioned, envs set, and the URL responding behind the password gate.
