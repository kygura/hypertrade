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
- **LLM**: routine work (briefings, sector maps) still happens in the user's cloud Claude routine, which writes results into `data/` and pushes. One exception, decided by the operator in phase 2: the **Analyst** (`/analyst`, `POST /api/analyst/query`) makes server-side LLM calls to answer natural-language questions over the app's data and the web. It is read-only market intelligence: its tools only read (briefings, sectors, metrics, series, Hyperliquid markets, engine strategies and decisions, the Lab's read-only tools) and it has no tool that places, approves, rejects or configures anything. Jev stays the only model inside the Hyperion engine's loop (hyperion `docs/jev/SPEC.md`). **Intel** (phase 5, § Intel) is the third: code detects and computes, the LLM only extracts structure from text and narrates what changed; it never predicts direction, sets targets or sends orders. The **Desk** (phase 3, below) is the second LLM surface and the first that acts: its agents propose trades into its own paper book through a deterministic governor. Any number of providers can be configured at once — `anthropic` (Messages API with streaming, client tools, Anthropic's server-side web search and refusal fallbacks; catalog: Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 4.5, `src/server/llm/catalog.ts`), the vendor presets `openai`, `google` (Gemini), `xai`, `deepseek`, `moonshot` (Kimi), `qwen` and `openrouter` (`src/server/llm/presets.ts`: Chat Completions with per-model reasoning controls; no web search), and the generic `openai-compatible` slot for any other `/chat/completions` endpoint — with `ANALYST_PROVIDER` (default `anthropic`) naming the server default; `POST /api/analyst/query` accepts an optional `provider`/`model`/`effort` per question, validated against `GET /api/analyst/models`'s catalog (400 with the offending field on a bad choice). A model/provider selector in the page header lets the operator pick per question; see README.md "Analyst" for the full env var precedence. Keys never leave the server. Bounds: 8 tool rounds, 90 s per question.
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
- `/` **Terminal** — the main screen (§ Intel): what changed since the last look against the operator's positions and watchlist, news mapped to positions, catalysts, exposure. Sub-routes `/journal`, `/theses`, `/query`, `/order`, `/watch`, `/overview`.
- `/overview` **Overview** (moved from `/`) — key metrics strip (net liquidity proxies, total OI, funding skew, fear/greed, BTC dominance), MarketState headline + TLDR card, sector heat summary, portfolio/branch equity sparkline
- `/branches` — list + create; `/branches/:id` — editor (allocation table, rebalance, scenario) + equity curve vs benchmarks + drawdown + forward projection fan chart
- `/sectors` — mindshare treemap/grid of routine-defined sectors sized by mindshare, colored by momentum; rotations list; per-sector drill-in with token-level OI/funding
- `/state` — full MarketState briefing (domains, thesis with Observe/Infer/Forecast, risks) + history browser + trigger button
- `/markets` — Hyperliquid universe table (price, 24h, OI, funding) with drill-in: live perp context, multi-timeframe chart (1m–1M, stitched deep history, funding/OI/premium panes), cross-venue funding
- `/strategies`, `/strategies/:id`, `/decisions`, `/decisions/:id`, `/governor` — the **ENGINE** console: companion to the Hyperion operator terminal for the Jev-driven strategy runtime (configure, dry-run, approve/reject proposals, governor and kill switch, venues). The Overview carries a compact ENGINE card.
- `/desk` — **DESK**: agentic portfolio desk (§ Desk). Header strip (venue, equity, day PnL, model, approval mode, kill switch), ask panel with agent lanes per run (PM + specialists, tool chips, reports) and the streamed answer, runs history with replay, proposals queue (approve/reject, governor verdict, sizing), book (paper + watched HL account, close), alerts feed.
- `/analyst` (SIMULATE mode) — **PATHS**: semantic simulation chat, see § Paths and DESIGN-chat.md.
- `/analyst` — **ANALYST**: thread + rail workspace (DESIGN.md §10.8). Model/provider selector in the header (`ModelSelector`, popover desktop / bottom sheet mobile, persisted per-browser, per-model effort levels), streamed markdown answers with the model's reasoning (when exposed), a tool timeline, citations, usage, copy / ask again; rail with the prompt library, provider setup status and the tool list; session persisted per browser; OfflineBlock when no provider is configured (503) or unreachable (502/network).

Design language: iterate on Hyperion (dark-only, Geist Mono, zero radius, dense terminal aesthetic, its exact color tokens as the base) but MUST additionally work on mobile — Hyperion never solved responsive; DESIGN.md must.

## Desk (phase 3)

An agentic portfolio desk inside the app: a PM agent runs a roster of specialist agents (flows, macro/fiscal, news, on-chain, risk, narratives) and can spawn ad-hoc ones, answers operator questions ("is this rally a bull trap or genuine flow, does macro and fiscal policy support it"), and in autonomous cycles proposes entries, exits and alerts. Code: `src/server/desk/`, `src/server/routes/desk.ts`, `src/ui/pages/Desk.tsx`, `scripts/desk-worker.ts`; README.md "Desk" has the detail.

- **Models**: Anthropic-first. With an Anthropic key the PM runs Claude Opus 5.5 and scouts Claude Sonnet 5.5 (Claude models in `DESK_ANALYST_MODEL` / `DESK_SCOUT_MODEL` override), regardless of `ANALYST_PROVIDER` / `DESK_SCOUT_PROVIDER`; `DESK_ANTHROPIC_FIRST=false` turns this off. Without an Anthropic key the PM (and `/analyst`) run on `DESK_ANALYST_MODEL` (any vendor) and scouts on the same provider unless `DESK_SCOUT_PROVIDER` / `DESK_SCOUT_MODEL` override them. PM effort high, scouts medium.
- **Governor** (`governor.ts`): every proposal is sized and checked by deterministic rules; re-checked at execution. Agents never set size.
- **Venue**: a paper book (`paper.ts`, default) or Hyperliquid **testnet** (`hl/broker.ts`, `DESK_VENUE=hl-testnet`): entries as one signed `normalTpsl` action (IOC entry + reduce-only stop and take-profit on the exchange), flattened if the stop is rejected; the governor uses the venue's marks and equity. Mainnet is refused. A Hyperliquid address can be watched read-only (`DESK_WATCH_ADDRESS`).
- **Approval**: `auto` (governor-passed entries execute) or `manual` (entries queue for the operator; Telegram buttons or the page). Exits never wait. Kill switch blocks entries.
- **Watch tick** (`watch.ts`): paper stops/targets, day-loss limit, deterministic triggers with alerts and cooldowns; wakes the team within a daily cap. From `collect.yml` (`desk` job, `vars.DESK_ENABLED`) or the worker.
- **Data** (`db/migrations/003_desk.sql`): `desk_runs`, `desk_events`, `desk_proposals`, `desk_paper_positions`, `desk_paper_fills`, `desk_alerts`, `desk_state`.
- **API**: `POST /api/desk/ask` and `/review` (SSE of run events), `GET /status /portfolio /runs /runs/:id /proposals /alerts`, `POST /proposals/:id/approve|reject /exit /kill /paper/reset`, `PUT /approval`, `PUT /settings` (review interval override), `POST /tick` (x-cron-token), `POST /telegram` (Telegram secret header).

## Lab (heuristic research)

Pillar: find simple, human-readable trading rules ("when `cm:CapMVRVCur` z(90) < −1.1 and `ht:funding` ≥ 0, go long BTC"), score them net of slippage, validate them walk-forward and on a one-shot holdout, and track the saved ones live. Full spec and tool contract: LAB.md (it wins on any detail). Code: `src/server/lab/`, `src/server/mcp/`, `src/server/routes/lab.ts`, `src/ui/pages/Lab.tsx`.

- **Tools**: one registry (`src/server/lab/tools.ts`) serves REST, MCP (HTTP and stdio), the CLI and the UI. The Analyst also gets its read-only tools (no `lab_search`, save or remove).
- **API**: `GET /api/lab/tools`, `POST /api/lab/tools/:name` → `{ok, result}` / `{ok: false, error, field?}`; `/api/mcp` is MCP over HTTP. Both accept the session cookie or `Authorization: Bearer <LAB_API_TOKEN>` (the token is valid on those paths only).
- **Route**: `/lab` — see LAB.md and DESIGN.md §10.9.
- **Data** (`db/migrations/004_lab.sql`): `lab_runs` (stored searches), `lab_rules` (the catalogue: rule, evaluation at save, archived_at). Collected history the lab reads lives in `observations` under `lab.*` series ids, written by `POST /api/cron/lab-collect` (own route and workflow job, lease-guarded against overlapping runs; daily Vercel cron fallback) and by `bun run lab sync --local`.
- **Honesty**: rank by walk-forward; the holdout never selects. Results are historical research, not advice.

## Paths — semantic simulation chat (phase 4)

The operator types a loose intention in chat — "what if I'd put 30% of my stack into SOL perps at 3x and DCA'd ETH weekly since January", "hedge my ETH with a short BTC position", "compare 60/40 ETH/USDC against 100% BTC since 2023" — and gets back simulated wealth paths: one or more branches, each with an equity curve against the BTC/USDC benchmarks, a drawdown, stats, and (for unlevered long-only branches with a scenario) a Monte Carlo fan. Any path can be saved as a regular branch with one click, or forked by a follow-up message. It is a **mode of the Analyst** (`/analyst`, toggle `ASK | SIMULATE`), not a new page; split it out only if it grows.

### Flow

```
chat text ──LLM (sim mode)──► simulate_paths tool call (JSON)
          ──zod (SimIntentSchema)──► SimIntent
          ──middleware adapter runIntent()──► normalized BranchConfigs + warnings
          ──runBranchConfig() (backfill → candles → simulate → montecarlo)──► results
          ──SSE `sim_result` event──► PathCard(s) in the thread
          ──compact stats as the tool result──► LLM narrates (hedged, with caveats)
SAVE AS BRANCH (user click) ──► existing POST /api/branches
```

### Decisions (pinned — do not relitigate)

1. **One engine.** `BranchConfigSchema` is extended additively; every new field is optional and the old shape still parses and simulates bit-for-bit identically (existing engine tests stay green unchanged). A saved intent is just a branch, so `/branches/:id` renders it.
   - `allocations[].side`: `"long" | "short"`, default `"long"`. `allocations[].leverage`: number, 1–50, default 1. An allocation with `side: "short"` or `leverage > 1` is a **perp leg**; stablecoins can be neither.
   - Perp leg accounting (engine-internal state per leg: `margin`, `entryPx`, `side`, `leverage`): `notional = margin × leverage`; `pnl = sign × notional × (px / entryPx − 1)`; leg value = `max(0, margin + pnl)`. **Liquidation**: when `margin + pnl ≤ 0` the leg is zeroed and stays zero (no re-entry until the next rebalance re-funds it from the rest of the portfolio). The check uses the day's **low for longs / high for shorts** when the candle carries `l`/`h` (DailyClose gets optional `l`, `h`), else the close. `// ponytail:` ceilings, stated in code and surfaced as warnings: no maintenance margin (liquidation at 100% margin loss), no funding payments, no fees/slippage.
   - Spot legs (long, leverage 1) keep the existing `qty` accounting. Portfolio value = Σ spot value + Σ stables + Σ perp leg value — never notional.
   - Rebalance with perp legs: realize each leg's PnL, set its margin to `weight × portfolio value`, re-enter at the current price.
   - `dca`: optional array `[{ coin, amountUsd, every: "weekly" | "monthly" }]`. Self-financing: each period (same bucket boundaries as the rebalance rules) it moves `amountUsd` from the portfolio's stablecoin sleeve (USDC, then USDT) into spot `coin`; when the sleeve is exhausted, it buys with what is left and then stops. No external cash is ever added, so CAGR stays honest. DCA into a coin that is not in `allocations` is allowed (the coin is held as a spot position from its first buy). A branch with `dca` should use `rebalance: "none"` (a rebalance undoes the DCA) — the adapter forces it and warns.
   - Discrete open/close dates per position are **out of v1** (`startDate` covers "since January").
2. **Chat backend = `mode: "sim"` on the Analyst route.** `POST /api/analyst/query` accepts `mode?: "ask" | "sim"` (default `ask`, unchanged behaviour). Sim mode reuses provider/model/effort choice and validation, SSE, the 90 s/8-round bounds and the abort handling; it swaps the system prompt (sim prompt, `src/server/llm/sim.ts`) and the tool set (the existing read-only market tools + `simulate_paths`). `runAnalyst` gains optional `system`, `tools` and `runTool` overrides; the analyst default path is untouched. A new event `sim_result` joins the `AnalystEvent` union.
3. **Intent shape** (`src/shared/intent.ts`, zod, the trust-boundary validator — the tool's hand-written JSON schema is only a hint to the model, zod is the authority; unknown keys rejected with `.strict()`):
   ```jsonc
   {
     "title": "SOL 3x perp + weekly ETH DCA since Jan",   // 1..120 chars
     "assumptions": ["stack assumed $10,000 (not stated)", "DCA $250/week funded from the USDC sleeve"],  // 0..12, what the model inferred from loose wording
     "branches": [                                       // 1..4 alternative paths, compared side by side
       { "name": "30% SOL 3x + ETH DCA", "config": { /* extended BranchConfig */ } }
     ]
   }
   ```
4. **Middleware adapter** — `src/server/sim/intent.ts`, `runIntent(intent, deps) → SimRunResult`. One deep module, the seam every test goes through; deterministic, no LLM, no network in tests (`deps` = `{ backfill(config), loadCandles(config), now(), maxLeverage?(coin) }`). Per branch it:
   - re-validates with zod (input may come from any caller);
   - normalizes weights that do not sum to 100 (scale proportionally, warn); coins uppercased; unknown coin / no candle data → that branch fails with a per-branch error, the others still run;
   - clamps leverage to the coin's Hyperliquid max leverage when `maxLeverage` is provided (warn), else the schema's 50;
   - forces `rebalance: "none"` when `dca` is present (warn);
   - **listing clamp**: moves `startDate` to the latest first-candle date across the branch's non-stable coins when the requested start precedes it (warn) — the engine's flat backward extrapolation would otherwise flatter CAGR;
   - drops `scenario` for branches with any perp leg (warn: "projection skipped — Monte Carlo models unlevered long-only portfolios"); otherwise runs `runMonteCarlo` exactly as `/branches/:id/run` does;
   - attaches engine-generated caveats (perp legs → "no funding, no fees, liquidation on daily lows/highs only"); the LLM never authors these.
   - Output per branch: `{ name, config (normalized), result?: BranchResult & { montecarlo? }, warnings: string[], error?: string }`.
   - The simulate step is shared with the branches route: `src/server/sim/run.ts` `runBranchConfig(config, deps)` (backfill → load candles incl. l/h → simulate → montecarlo) replaces the inline code in `routes/branches.ts` `POST /:id/run` (same responses, same caching).
5. **Trust boundary.** LLM output is untrusted input: it only ever reaches `runIntent` through zod. The sim tool set has no write tool — no DB writes, no Desk, no paper or testnet order, no governor call. Saving a branch is a user click on the card that calls the existing `POST /api/branches` (its own zod validation). The Desk bridge ("paper this leg") is **out of v1**. `simulate_paths` runs under its own deadline (`withDeadline`, 40 s) and returns `{error}` to the model on timeout or missing data rather than eating the whole 90 s question budget.
6. **"My stack"**: there is no reliable holdings source (the Desk's paper book is the desk's, not the operator's). Default `initialCapitalUsd` 10 000 unless the user states an amount; implicit holdings ("hedge my ETH") become explicit allocations. Every such inference goes in `assumptions` — the sim prompt requires it, and the card renders them.
7. **Tool result to the model** is compact (per branch: name, final value, total return, CAGR, max DD, vs BTC, warnings, error) — never the equity arrays. The full result goes only to the UI via `sim_result {id, intent, branches}`.
8. **Forks**: in sim mode, prior assistant turns sent back as `history` carry a compact trailer with each path's normalized config JSON, so "same but 5x" / "now without the DCA" modifies the previous intent instead of re-guessing it.
9. **Sim prompt rules**: the same hard rule, hedge vocabulary and disclaimer as the Analyst (`system.ts`); results are historical simulation, not advice; always call `simulate_paths` before quoting numbers; prefer 2–3 contrasting branches when the intention is open-ended ("hedge my ETH" → unhedged vs 50% hedge vs full hedge); ask a one-line clarifying question only when no reasonable default exists.

### API delta

- `POST /api/analyst/query` body gains `mode?: "ask" | "sim"`. New SSE event (sim mode only): `sim_result {id, intent: SimIntent, branches: [{name, config, result?, warnings, error?}]}`, emitted once per `simulate_paths` call, before that call's `tool_result`.
- `GET /api/analyst/status` unchanged. No new routes.

### UI delta

`/analyst` gains a mode `Segmented` (`ASK | SIMULATE`), sim example prompts in the rail, and **PathCard** results inline in the thread (one card per `sim_result`, branches compared within it): equity vs benchmarks (existing `EquityChart`, fan when present), drawdown, stats, assumptions and warnings visible (a path without visible assumptions is forbidden, principle 6), `SAVE AS BRANCH` per branch (→ `/branches/:id` link once saved) and `FORK` (prefills the composer). Layout, states and mobile behaviour: **DESIGN-chat.md** (binding for this feature, extends DESIGN.md). `/branches/:id` shows and preserves the new fields (side, leverage, DCA) so a saved path round-trips through the editor.

### Done

- `bun test` green, including: engine tests for short/levered/liquidated/DCA cases with hand-computed fixtures; adapter tests with fixture intents (normalization, listing clamp, leverage clamp, DCA→rebalance none, per-branch error isolation, scenario skip on perp legs); sim-mode loop tests with a fake provider (tool call → zod reject → error result; valid call → `sim_result` event + compact tool result; analyst default mode unchanged).
- `bun run typecheck` and `bun run build` green.
- With a provider configured and candles reachable, typing the example intents in `/analyst` SIMULATE mode renders PathCards; `SAVE AS BRANCH` creates a branch that opens and re-runs in `/branches/:id`.

## Intel — LLM trading tools (phase 5)

Source brief: "LLM Trading Tools — Spec" v0.1 (2026-10-13), all eight modules. This section is the binding version for hypertrade; where it differs from the brief, this section wins. Layout and states: **DESIGN-terminal.md** (binding for this feature, extends DESIGN.md).

**Principle.** Code detects and computes. The LLM turns unstructured text into structured events and explains what changed. It never predicts direction, sets price targets, or sends orders on its own. Every LLM output that reaches the screen or Telegram passes the claim validator (I4) first.

### I0. Decisions (pinned — do not relitigate)

1. **Main screen.** `/` is the Terminal. The old Overview moves to `/overview` unchanged. The terminal family is real routes (Telegram deep-links need URLs): `/` TERMINAL, `/journal`, `/theses`, `/query`, `/order`, `/watch`, `/overview`, with a shared sub-tab strip (Lab pattern, `LabTabs`). The nav's OVERVIEW slot becomes TERMINAL (mobile still 9 cells).
2. **Positions = three sources, unified at read time.** `manual` (stored in `intel_positions`, CRUD from the terminal), `hl` (the watched Hyperliquid address, `DESK_WATCH_ADDRESS`, read-only via `readHlAccount`), `desk` (the Desk's paper/testnet book via `DeskService.account()`, read-only). One `ExposurePosition` shape: `{id, source, asset, side, size, entryPx, markPx, stopPx|null, leverage, venue, notionalUsd, unrealizedPnl|null}`. A source that fails is reported in `sources: [{source, ok, error?}]`, never fatal. Watchlist = `intel_watchlist` (asset + tags); when empty it falls back to `DESK_WATCHLIST`.
3. **Snapshot store** `intel_snapshots(asset, ts, price, vol24h, funding, oi_usd, premium, basis, depth_bid_1, depth_ask_1, depth_bid_2, depth_ask_2, spread_bps)`, pk `(asset, ts)`. Written **inside the existing `POST /api/cron/collect`** from the same `metaAndAssetCtxs` fetch (no new job): assets = held ∪ watched ∪ top-20 by OI. Book depth (USD within ±1% / ±2% of mid) and spread (bps) come from HL `l2Book`, fetched only for held ∪ watched (≤ 25 coins, weight-guarded). `basis` = (mark − oracle)/oracle. Cadence is the collect cadence (15 min; the brief's 5 min default is not adopted — GitHub Actions jitter makes 5 min fictional). Held ∪ watched coins join `backfillCoins()` and the extra-OI coin set so candles exist for ATR, priced-in and journal stats. Raw ticks never reach the LLM. Retention: 90 days, pruned by the backfill job.
4. **Normalized deltas (per metric, pure, `src/server/intel/normalize.ts`).**
   - price, oi_usd: `z = Δ_h / (σ_1h · √h)`, σ_1h from hourly log changes over the last 7 days of snapshots (cold start: price from 1h candles, OI from `observations` `hl.oi.<coin>`); `h` is the real elapsed time (no cap: capping h while keeping the full Δ would inflate z by √(h/24)); the baseline snapshot is the latest one at or before the review (`after` only when none precedes it) and `h` is floored at 0.25 h.
   - funding, premium, basis: level z vs the 7-day mean/σ (not Δ; funding is hourly-stepped). Cold start: `funding` table / `hl.funding|premium.<coin>` observations.
   - vol24h, depth_*, spread_bps: `log(now / 7d median)` divided by the 7d σ of the same log ratio.
   - Fewer than 24 samples → `z = null` (metric skipped, not zero).
   - Level and ratio z measure a state, not a change, so besides `|z| ≥ INTEL_MIN_Z` such an item clears only if it crossed the threshold since the baseline (`|z_base| < INTEL_MIN_Z`, `z_base` = the baseline value's z against the same 7-day history) or `|z − z_base| ≥ 1`; price and OI are not gated.
5. **Materiality** = `|z| × exposure_weight × stop_proximity`. `exposure_weight` = position notional / Σ notional across all three sources (watchlist-only assets get a floor of 0.05). `stop_proximity` = `1 + 2 · max(0, 1 − dist_to_stop / (2 · ATR14_1h))` when a stop is known, else 1. Thresholds (env-tunable): `INTEL_MIN_Z` 2.0, `INTEL_TOP_K` 5. Nothing clears → the brief is **silent**.
6. **LLM access** — one helper, `completeStructured({tier, system, user, schema, jsonSchema, cacheKey?, promptVersion, signal})` in `src/server/intel/llm.ts`. Tier `cheap` (extraction, cluster labels, tagging) and `strong` (narration, graph refresh, thesis, copilot parse) reuse the Desk's model resolution (`deskProviderFactory`: specialist → cheap, pm → strong; `DESK_ANTHROPIC_FIRST`). No new model env vars. Mechanism: one `emit` client tool whose input schema is the target JSON schema; forced tool choice is unsupported, so the fallback is a fenced JSON block in text; one retry; then fail closed (`{error}`). Zod is the authority. Web search is **off** unless the call asks for it (new provider option; the Anthropic provider currently always registers it). Results cached in `intel_llm_cache` by `(cacheKey, promptVersion)`. Every call returns a trace `{promptVersion, tier, model, inputs, output, usage, ms}`; every alert/brief/report stores its trace. Daily cap `INTEL_LLM_DAILY_CAP` (default 200 calls) counted from the cache table; over cap → fail closed with a visible "LLM cap reached".
7. **Claim tagging** (`src/server/intel/claims.ts`, pure). Every LLM line is `{tag: "observed", text, source: {label, url?}, ts}` or `{tag: "hypothesis", text}`. Lines with neither tag, or `observed` without source+ts, are dropped before display and the drop is counted in the trace. Snapshot-derived facts use `source: {label: "snapshot", url: "/markets/<COIN>"}` + the snapshot ts. If every line is dropped, the UI renders the ranked diff table without prose.
8. **Exposure graph.** `intel_edges(src, dst, type, weight, source, last_verified, origin: seed|llm|user)`. Edge types exactly as the brief: `direct, settles_on, collateral, depends_on_stable, primary_venue, bridge, narrative, macro_beta`. Seed edges ship in code (`graph-seed.ts`) for the core universe (BTC, ETH, SOL, HYPE, the top-20 HL perps, major stables, L2s, LSTs, AI/meme narratives, DXY/Nasdaq macro beta). Daily LLM refresh (`POST /api/cron/intel/graph`) proposes edges for held ∪ watched assets, one asset per call, chunked under a lease and a 200 s budget; an edge without a source URL is not stored. Walk = code, 1–2 hops; path weight = Π(edge type weight) × 0.5^(hops−1). Type weights: direct 1.0, collateral 0.8, settles_on 0.6, depends_on_stable 0.6, bridge 0.5, primary_venue 0.4, narrative 0.4, macro_beta 0.3.
9. **Events** (`intel_events`, the brief's event schema plus `title`, `origin`, `scheduled_at|null`, `catalyst: {size?, direction_hypothesis?}|null`, `tag: observed|hypothesis`). Clusters (`intel_clusters`): group by normalized-title token-shingle Jaccard ≥ 0.5 within 48 h, extract once per cluster (cached), then merge clusters on entity overlap. `// ponytail:` no embeddings (no keyless embedding source).
10. **Ingest sources.** RSS/Atom feeds (`INTEL_RSS_FEEDS`, comma list, sensible keyless defaults; small regex parser, no XML dependency); Snapshot governance GraphQL (`hub.snapshot.org`, spaces mapped from assets in config) for proposals and vote end dates; static macro calendar (FOMC/CPI/NFP dates for the current and next year in `src/server/intel/calendar.ts`); LLM web-search headline sweep (strong tier with web search, at most hourly, `INTEL_WEBSEARCH=true` to enable); X list timeline behind `X_BEARER_TOKEN` + `INTEL_X_LIST_ID`; Telegram public channels via `t.me/s/<channel>` behind `INTEL_TG_CHANNELS` and a health flag (Vercel IPs are often refused — failure is recorded, not retried). Each source records a row in `collector_runs` (`intel:<source>`). LLM-swept items without a URL are `hypothesis`.
11. **Mapper.** Per new cluster: extract (cheap) → walk graph from its entities to held ∪ watched assets → for each exposed asset, explain (cheap, one claim-tagged line: position side + mechanism, e.g. "Long SOL. The exploit is on Jito, which affects LST collateral and could cause liquidations.", tagged `hypothesis` unless it is a restated sourced fact) → priced-in check (code: price and OI now vs the nearest snapshot at/after `first_seen`, else 1h candle; appended as "already −4.1%, OI −8%") → materiality = magnitude (low .3 / med .6 / high 1) × path weight × exposure_weight × stop_proximity → route: ≥ `INTEL_PUSH_MATERIALITY` (default 0.35) pushes to Telegram now, else batched into the next brief. Alerts dedupe on `(kind, cluster_id, asset)`.
12. **Feedback.** 👍/👎 per alert (`POST /api/intel/alerts/:id/feedback`). Aggregated per `(event type, edge type, hop depth)`. Weekly report (`intel_reports`, kind `feedback_weekly`) lists the worst buckets with counts and the suggested adjustment; **no auto-tuning of thresholds or weights in v1** — the operator edits them. One bounded exception: a bucket with ≥ 5 votes in 30 days and net ≤ −60% has its pushes demoted to batch (never dropped).
13. **Catalysts.** Scheduled events (`scheduled_at` set) from Snapshot, the macro calendar, the web-search sweep (unlocks, listings/delistings, mainnet/upgrades) and manual entry (`POST /api/intel/catalysts`). The LLM extracts asset, date, size, expected direction (always `hypothesis`). Alerts at T−24 h and T−1 h for held/watched exposure (dedupe on `(kind, event_id, asset, window)`), delivered by the ingest cron.
14. **Terminal brief.** `POST /api/intel/brief` (UI open): baseline = snapshot nearest the last UI review (6 h fallback) → diff all held ∪ watched assets → rank by materiality → merge batched alerts and catalysts within 24 h for the same assets → strong-tier narration of the top-k into 3–5 claim-tagged lines → store in `intel_briefs` → log a review in `intel_reviews`. Only a UI open or a Telegram deep-link click (`/?review=1`) logs a review. `POST /api/cron/intel/brief` builds the same brief with baseline = the previous **cron** brief, sends "N things changed that touch your positions" + top lines + link to Telegram when anything clears, and never marks reviewed. `GET /api/intel/brief/latest` returns the last stored brief without computing.
15. **Journal (module 4).** Fills from HL `userFills` (watched address) and `desk_paper_fills`. Round trips by code using HL `dir` ("Open Long"/"Close Long"…) and `closedPnl`; trade id = `<venue>:<coin>:<open fill tid>`. Code computes session (`INTEL_TZ`, default UTC: asia/eu/us/off by hour), market state at entry (funding z, OI z, 24 h change from snapshots/candles), hold time, R (only when a stop is known: desk always, HL only if a snapshot/manual stop exists), MAE/MFE from 1h candles. Optional one-line note per trade (`intel_trade_notes`). The LLM (cheap) tags setup type and summarizes the note. Code computes per-tag win rate, avg R, hold time, MAE/MFE and ranks by expectancy; the weekly report (strong) narrates the top-3 leaks and top-2 edges, each with trade ids, claim-tagged.
16. **Thesis stress-tester (module 5).** Free-text thesis → strong LLM extracts claims + assumptions, each mapped to a check from a fixed catalog: `metric_threshold {series, op, value}`, `price_vs_level {asset, op, level}`, `funding_sign {asset, sign}`, `oi_change {asset, window_h, op, pct}`, `event_exists {query, since_h}`, `unknown`. Code evaluates each → `supported | contradicted | unknown` with source + ts. Output also: invalidation levels/conditions and "what has to be true for this to be wrong". Saved in `intel_theses`; re-checked automatically when a brief flags a change on one of its assets (and on demand).
17. **NL queries (module 6).** LLM (strong) → screener DSL (zod, `src/shared/intel.ts`) over the snapshot store (+ `funding`, `candles`, `observations`). Code compiles the DSL to parameterized SQL. The DSL is shown and editable (JSON), the SQL is shown read-only. Runs inside `begin read only` with `statement_timeout` 5 s, `LIMIT ≤ 500`, range ≤ 90 days; uses a second `postgres()` client on `DATABASE_URL_READONLY` when set. No raw-SQL editing.
18. **Order copilot (module 7).** NL → order intent (strong, zod): asset, side, leverage, size (USD notional or % of book), entry (market | limit px), stop (`price | pct | prev_day_low | prev_day_high | atr_mult`), optional target. Code resolves the stop from candles, computes size, liquidation price (HL: maintenance margin = 1 / (2 · maxLeverage)), risk in % of book. Execution goes to the **Desk venue only** (paper by default, HL testnet when configured; mainnet refused). The governor is refactored, not bypassed: a pure `evaluateRisk(order, ctx)` is extracted from `evaluateOpen` (coin, side, stop, target?, riskPct, entryLimit), `evaluateOpen` = its confidence checks + `evaluateRisk` (existing governor tests unchanged), and `DeskService.submitOperatorOrder()` always goes preview → explicit confirm → execute, independent of approval mode, recorded with `decidedBy: "operator:copilot"`. Target optional for operator orders (R:R check skipped, warned). The preview shows the governor verdict, its clip and warnings. **No autonomous execution, ever.**
19. **Doc/contract watcher (module 8).** `intel_watches(kind: url | evm_contract | evm_wallet, target, chain, asset, label, last_hash, last_snapshot, checked_at, error)` and `intel_watch_changes`. Code detects change: `url` → fetch, strip tags, hash, line diff (`// ponytail:` JS-rendered/bot-blocked pages fail visibly); `evm_contract` → `eth_getCode` hash + EIP-1967 implementation and admin slots; `evm_wallet` → balance + nonce. Public RPC per chain in config (`INTEL_RPC_<CHAIN>` override). On change the LLM (cheap) summarizes what changed and why it matters (claim-tagged), and the change is routed through the mapper (graph walk from `watch.asset`) so only exposed assets alert. Runs from `POST /api/cron/intel/watch`.

### I1. Code layout

```
src/shared/intel.ts               zod schemas + API types for every intel endpoint (the contract both sides import)
src/server/intel/
  store.ts                        IntelStore interface + PgIntelStore + MemoryIntelStore (DeskStore pattern)
  positions.ts                    three-source unification
  snapshot.ts                     build snapshot rows (ctxs + l2Book) — called from collect
  normalize.ts  diff.ts           pure z-scores, materiality, ranking
  llm.ts  claims.ts               completeStructured, cache, trace, daily cap; claim validator
  graph.ts  graph-seed.ts         walk (pure), seed edges, LLM refresh
  cluster.ts  calendar.ts         pure clustering; static macro dates
  ingest/{rss,governance,websearch,x,telegram}.ts
  mapper.ts  pricedIn.ts  catalysts.ts  terminal.ts
  journal.ts  thesis.ts  screener.ts  copilot.ts  docwatch.ts
  notify.ts                       Telegram via the Desk notifier (createNotifier)
src/server/routes/intel.ts        createIntelRoutes(deps) → /api/intel/*
src/server/routes/cron.ts         + /cron/intel/{ingest,brief,graph,watch} (lease + budget each)
db/migrations/007_intel.sql
src/ui/pages/terminal/*           Terminal, Journal, Theses, Query, Order, Watch
src/ui/components/intel/*         panels and cards
src/ui/lib/intel.ts               typed client
```

### I2. API

All under `/api/intel`, session-cookie auth (GET also accepts the `LAB_API_TOKEN` bearer via `READ_PATH`, so the routine can read).

- `GET /positions` → `{positions: ExposurePosition[], sources, totalNotionalUsd}`; `POST /positions`, `PUT /positions/:id`, `DELETE /positions/:id` (manual only; 400 on others).
- `GET /watchlist`, `PUT /watchlist` `{items: [{asset, tags}]}`.
- `POST /brief` → `Brief {id, createdAt, since, items: DiffItem[], alerts, catalysts, lines: Claim[], silent, trace?}`; `GET /brief/latest`; `GET /reviews?limit`.
- `GET /alerts?since&kind`, `POST /alerts/:id/feedback` `{vote: 1|-1}`.
- `GET /events?since&type`, `GET /catalysts?days=14`, `POST /catalysts` (manual), `DELETE /catalysts/:id` (manual only).
- `GET /graph?asset` → edges touching an asset + 2-hop paths to held/watched; `POST /graph/edges` (user edge), `DELETE /graph/edges` (user only).
- `GET /journal?days=30` → `{trades, stats: TagStats[], sources}`; `PUT /journal/:tradeId/note`; `POST /journal/tag` (tags untagged trades); `GET /journal/report/latest`, `POST /journal/report`.
- `GET /theses`, `POST /theses` `{text}` → extracted + checked; `POST /theses/:id/check`; `DELETE /theses/:id`.
- `POST /query/parse` `{question}` → `{dsl, sql, params}`; `POST /query/run` `{dsl}` → `{sql, columns, rows, ms}`.
- `POST /order/preview` `{text}` | `{intent}` → `{intent, resolved: {stopPx, entryPx, size, notionalUsd, liqPx, riskPct, riskUsd}, verdict, warnings}`; `POST /order/confirm` `{intent, previewHash}` → executes on the Desk venue (409 when the preview is stale: marks moved > 0.5% or > 60 s).
- `GET /watches`, `POST /watches`, `DELETE /watches/:id`, `GET /watches/:id/changes`, `POST /watches/:id/check`.
- Cron (x-cron-token): `POST /cron/intel/ingest` (sources + mapper + catalyst alerts, every 15 min after collect), `POST /cron/intel/brief` (every `INTEL_BRIEF_HOURS`, default 6), `POST /cron/intel/graph` (daily), `POST /cron/intel/watch` (hourly). All leased, budgeted (≤ 200 s), and gated in the workflow by repo var `INTEL_ENABLED`.

### I3. Done

- `bun test` green, with fixture tests for every pure module (normalize, diff/materiality, claims, graph walk, cluster, rss/governance parsers, calendar, pricedIn, journal round trips + stats, thesis check evaluation, screener compile incl. injection/limits, copilot stop/liq/size resolution, docwatch change detection), `completeStructured` against a scripted provider (tool path, JSON-block fallback, retry, fail closed, cache hit, daily cap), the governor refactor (existing tests unchanged + `evaluateRisk` cases), `submitOperatorOrder` (never executes without confirm, mainnet refused), and route tests through `createIntelRoutes` with a MemoryIntelStore.
- `bun run typecheck`, `bun run build`, `bun run check:api` green.
- `/` renders the Terminal with every panel showing a named state (skeleton / empty / offline / error) when the DB or LLM is absent; with a DB and a provider configured, opening `/` produces a brief (or "nothing cleared the threshold"), manual positions can be added, and the other six routes render.

### I4. Out of scope (Intel v1)

Embeddings; feedback auto-tuning; mainnet orders; any order without an operator confirm click; raw-SQL editing; spot balances from the watched address; JS-rendered doc pages.

## Flow — quant gaps of "Flow + Scout" (phase 6)

Source brief: "Flow + Scout: Spec" (2026-10-14). Intel (phase 5) already covers most of it: snapshots, review log, exposure graph, news mapper, claim tags, Telegram push, feedback, the Terminal. This phase adds only the missing pieces. § Intel I0 stays binding; where this section adds to it, this section wins. The Terminal stays the main screen (`/`). Phase 7 (§ Scout) adds research and the scorer gaps on top.

### F0. Decisions (pinned)

1. **Flow collector.** New long table `intel_flow(asset, venue, metric, value, ts)`, pk `(asset, venue, metric, ts)`, migration `009_flow.sql`, behind `IntelStore`. Written inside `POST /api/cron/collect` beside the snapshot, for the coin set defined below. Rows are non-HL venues (or `agg` for a Coinalyze aggregate, which may include HL — labelled "provider aggregate" in the UI) only; volume and liquidation metrics are **per 15-min interval** values, never rolling 24 h; HL OI/funding stay in `intel_snapshots` and are never duplicated here. Metrics: `oi_usd`, `funding`, `long_short_ratio`, `liq_long_usd`, `liq_short_usd`, `perp_volume_usd`, `perp_buy_volume_usd`, `spot_volume_usd`. Source (F0.1a, from `docs/research/flow-sources.md`): **Coinalyze only**, behind `COINALYZE_API_KEY` (free, 40 calls/min). Perp metrics use the aggregated symbol (`<COIN>USDT_PERP.A`, venue `agg`); spot volume uses the aggregated spot symbol when `/spot-markets` lists one, else the spot symbol of the first exchange in a fixed liquidity ranking that lists the coin (venue = that exchange code). `/spot-markets` carries no volume, so the ranking is static (ponytail note in `coinalyze.ts`); the symbol map is resolved once from `/future-markets` + `/spot-markets` and cached in memory per invocation. Interval `15min`, `from` = the last stored ts per (asset, metric) or 24 h back. Endpoints: `open-interest-history` (`c`), `funding-rate-history` (`c`), `liquidation-history` (`l`, `s`), `long-short-ratio-history` (`r`), `ohlcv-history` (`v`, `bv`). Coins = held ∪ watched, capped at `INTEL_FLOW_MAX_COINS` (default 8, by notional then watch order); multi-symbol calls (≤ 20 symbols each), paced under the rate limit, ≤ 60 s budget inside collect. No key → `flow: {ok: false, error: "no_source"}`. Binance/Bybit direct APIs are not used (US-blocked from Vercel `iad1`). A source that fails or has no key records a `collector_runs` row (`intel:flow:<venue>`) and is skipped, never fatal. 90-day retention, same as snapshots. Exchange inflows are **out of scope**: no free source.
2. **Fixed windows** (`src/server/intel/windows.ts`, pure). For each snapshot metric and each flow metric, Δ over 1 h, 6 h and 24 h, plus z = Δ against the trailing 30-day distribution of **non-overlapping** Δs of the same window length (stride = window length, so samples are independent). σ is robust (MAD × 1.4826) with a per-metric floor (funding: 1e-6/h, so hourly-stepped funding cannot explode z). A window endpoint counts if a sample exists within ±20 min of the grid point. Lookback 30 days for 1 h/6 h (min 48 / 20 samples), 90 days for 24 h (min 30); below → `z = null`, and detectors that need that z report `degraded` (expected for the first ~14 days of flow data). These run alongside the I0.4 last-review baseline and don't replace it.
3. **Regime flips and threshold crossings** (same module, pure). Flips: funding sign change, basis sign change (inversion), OI up while price down over the window (both |z| ≥ 1). Crossings come from env `INTEL_THRESHOLDS`, a comma list of `metric>value` or `metric<value`; the default is `funding>0.0000625`, which is 0.05%/8 h expressed hourly. A flip or crossing is an event, emitted only on the transition, not while the state holds.
4. **Flow detectors** (`src/server/intel/flows.ts`, pure, deterministic). Each takes window results plus snapshots and flow rows and emits `{detector, asset, window, numbers: Record<string, number>, ts}`:
   - `crowded_long` / `crowded_short`: funding level |z| ≥ 2 with its sign, OI 24 h z ≥ 1, price 24 h |z| < 1.
   - `negative_funding_oi_build`: funding < 0, OI 24 h z ≥ 1, price 24 h z ≥ −0.5 (shorts adding into a price that is not falling; a precondition for a squeeze, not a squeeze).
   - `deleveraging`: OI 6 h Δ ≤ −`INTEL_DELEV_OI_PCT` (default 8%) and liquidations 6 h z ≥ 2. Without liquidation data it is reported as `degraded`, never as a false negative.
   - `spot_led` / `perp_led`: price 6 h |z| ≥ 2; gap `g = z6h(spot_volume_usd) − z6h(perp_volume_usd)`; `g ≥ 1` → spot_led, `g ≤ −1` → perp_led. No spot data → skipped.
   - `liquidity_thinning`: depth ±2% (bid + ask) below its 30-day 10th percentile; score = 1 + (p10 − depth)/p10 × 4 (same 30-day baseline as the trigger).
   - Exchange inflow spike: not built (F0.1).
   Detector score = max |z| among its triggering conditions (liquidity_thinning: the depth z). Hits become `intel_events` with `kind: "data"`, `tag: "observed"`, source = the actual provider of the data used (`{label: "snapshot"}` for HL-only detectors, `{label: "<venue>"}` otherwise) + ts, Detector materiality = score × exposure_weight × stop_proximity, ranked in its own list (no `INTEL_MIN_Z` gate — the detector's own conditions are the gate) and merged into the brief like batched alerts; push to Telegram when ≥ `INTEL_PUSH_MATERIALITY`. One event per (detector, asset) until its conditions clear. Thresholds are starting values, env-tunable; calibration comes from feedback (I0.12).
5. **Number validator** (`src/server/intel/numbers.ts`, pure). It applies to every LLM line before display or sending: brief narration, mapper impact lines, journal, thesis and docwatch summaries. It extracts each numeric token, normalising `%`, `$`, `K/M/B`, signs, thousands separators and `bps`. Code precomputes every derived value the LLM may cite (percent changes, distances, ratios) into the payload, rounded, in display units (funding as %/8 h, spread in bps); the prompt says to reuse them, never compute. Numbers inside payload text fields (titles, diffs, thesis text) count as payload numbers. Tokens inside identifiers (L2, ATR14, EIP-1967, BTC2) and window labels (1h/6h/24h/7d) are exempt. A line passes only if every number matches a number in the call's input payload within rounding: relative 0.5%, or one unit of the last printed decimal. Exempt: dates, times, ordinals ≤ 31 inside a date phrase, and the 1/2/5 list markers. A failing line is dropped like an untagged claim and counted in the trace as `numbersRejected`. Same layer: a line with a buy/sell/enter/exit **imperative** (not nouns like "sell-off", "exit liquidity") or a price target ("target", "TP", "will reach") is dropped and counted as `adviceRejected`. Zero hallucinated numbers is enforced by code, not by the prompt.
6. **Telegram.** On the existing Desk bot: Vercel uses the existing webhook route (`routes/desk.ts`), the desk worker's polling stays as the fallback when no webhook secret is set; both call `handleTelegramUpdate`, which already handles callbacks and the chat-id check (`desk/telegram.ts:42–63`). Intel deps (store + brief builder) are injected at both call sites; the existing callback branch gains an `fb` verb; `sendIntel` takes `actions` built from the stored alert id (the Desk notifier already renders `Alert.actions` as an inline keyboard), so alerts are stored before they are sent:
   - `/digest` builds the same brief as `POST /api/intel/brief`, replies with its lines plus the `/?review=1` link, and logs a review with `via: "telegram_digest"` (zod enum in `src/shared/intel.ts` + an ALTER of the `intel_reviews` CHECK in `009_flow.sql`). Narration is bounded (≤ 20 s); on timeout or cap the reply carries the ranked raw-number items.
   - Every Intel alert message carries inline 👍/👎 buttons (`callback_data: "fb:<alertId>:1|-1"`). The callback writes the same feedback as `POST /api/intel/alerts/:id/feedback`, answers the callback, and edits the buttons to show the vote.
   - Only the configured chat id is accepted.
7. **Spend cap in dollars.** `INTEL_LLM_DAILY_USD` (default 2.00) is computed from stored usage × a per-model price table in `llm.ts`. Unknown model → priced at the strongest tier's rate. It is checked alongside the existing call cap; whichever trips first wins. Over cap → fail closed exactly as today. Alerts and the brief still go out with raw numbers and no prose, and show "LLM cap reached ($x.xx / $y.yy)".
8. **UI (Terminal family).** Binding layout in DESIGN-terminal.md § Flow.
   - **Heatmap** panel on `/`: rows are held ∪ watched assets, columns are metrics, with a window switch (since review / 1 h / 6 h / 24 h). Each cell is a signed z, with null shown as empty. A cell click opens the asset page.
   - **Detector chips** on the Terminal.
   - **Asset page** `/asset/:coin`: snapshot and flow time series with event markers (detector hits, flips, news alerts, catalysts) and the asset's exposure graph (edges plus 2-hop paths to held/watched, typed and weighted).
   - Every panel has the named states (skeleton / empty / offline / error).

### F1. API delta

- `GET /api/intel/heatmap?window=review|1h|6h|24h` → `{rows: {asset, held, materiality}[]` (sorted by materiality), `metrics` (fixed order: price, oi_usd, funding, basis, premium, vol24h, depth_2 (bid+ask), spread_bps, long_short_ratio, liq_usd (long+short), perp_volume_usd, spot_volume_usd), `cells: {asset, metric, z|null, delta|null}[]`, `flags: FlowFlag[]`, `flow: {ok, error?}` (`error: "no_source"` vs per-cell null = too few samples), `asOf}`. `FlowFlag = {id, asset, kind: detector|flip|crossing, name, window, numbers: Record<string, number>, score, degraded: boolean, ts}`.
- `GET /api/intel/asset/:coin?days=7` → `{snapshots, flow, events: AssetEvent[], catalysts, graph: {edges, paths}}`, where `AssetEvent = {ts, kind: flow|alert|catalyst, title, tag: observed|hypothesis, numbers?, claim?: Claim, url?}` (flow = a FlowFlag, alert carries its Claim).
- `GET /api/intel/flows?since` → detector/flip/crossing events.
- Types live in `src/shared/intel.ts`, and the route tests go through `createIntelRoutes`.

### F2. Done

- Fixture tests for `windows`, `flows` (every detector: fires, quiet, degraded), `numbers` (accept/reject table including advice language), the flow collector parsers, the dollar cap, the Telegram callback and `/digest` handlers, and the new routes.
- `bun test`, `bun run typecheck`, `bun run build`, `bun run check:api` green; the existing tests are unchanged.
- `/` shows the heatmap and detector chips. `/asset/:coin` renders timeline and graph. Every new panel has named states without a DB.

### F3. Out of scope (Flow)

Exchange inflow detector; on-chain flows/TVL; feedback auto-tuning (I0.12 stands); a new venue for orders. (Research mode moved in by phase 7 below.)

## Scout — research on the Terminal (phase 7)

Source: the same "Flow + Scout" brief, § 4.3 and § 3.4. The operator asked (2026-10-14) for the whole brief to live on the main screen. Phase 6 left research on the Desk; this phase brings it to `/` and closes the scorer gaps. § Intel and § Flow stay binding; this section wins where it adds to them.

### S0. Decisions (pinned)

1. **Research contract** (`src/shared/intel.ts`). `ResearchResult = {id, trigger, asset: string|null, question, status, explanation, evidence: {claim, url, ts: string|null, type: "observed"|"hypothesis"}[], confidence: "low"|"medium"|"high", openQuestions: string[], searches, costUsd, model, createdAt}`. `trigger` is `"manual"` or `"flag"` (a FlowFlag id in `flagId`). `status` is `running | found | no_cause | capped | failed`. `no_cause` is a valid answer, and its explanation is exactly "No public cause found." followed by what was checked. `observed` evidence needs an `HttpsUrlSchema` url. `hypothesis` evidence may omit the url and is never phrased as fact.
2. **Engine** (`src/server/intel/research.ts`). One `completeStructured` call on the large tier with `webSearch: true`. Budget: at most 8 web searches, passed per call as `maxUses` through the step options (not the shared provider default). No page-fetch tool is added: hosted search excerpts are the only fetched text, which keeps the SSRF surface closed. The brief's "4 fetches" is dropped on purpose. Deadline: `RESEARCH_DEADLINE_MS` = 45 s, kept under the function's max duration. Input payload: the asset's latest snapshot numbers, the flag's `numbers` when the trigger is a flag, the held or watched exposure, and news-cluster headlines for the asset from the last 24 h, so the model doesn't re-find known news. Fetched text is wrapped with `untrusted()`. Validation runs the § F0.5 validator on `explanation` and every claim. **Provenance is checked in code.** The provider surfaces the URLs and excerpts of its search results (`web_search_tool_result`). An `observed` claim survives only if its url is one of those URLs and each of its numbers appears in that result's excerpt. Otherwise it is downgraded to `hypothesis` (url kept only if seen). A provider that exposes no results downgrades every claim. Anthropic returns result bodies encrypted, so the only readable excerpt for a URL is the `cited_text` of citations pointing at it. The prompt asks the model to state its evidence in cited prose before it calls `emit`. An `observed` claim needs at least one citation for its url, ≥ 50 % of its content words present in that cited text, and each of its numbers printed in it at the same value, sign and unit. Anything less becomes `hypothesis`. Search results can't be wrapped with `untrusted()` (they are provider tool results), so the system prompt states that they are untrusted data. `found` needs at least one surviving `observed` claim. With only hypotheses left, the status is `no_cause` and the hypotheses are kept as evidence. The 8-search budget covers the whole run, retries included. Every provider call records its usage, search fees included, against the § F0.7 cap whether it succeeds or fails. Numbers in `explanation` must match the payload or a surviving observed claim. Advice language is dropped. If every claim is dropped, the status is `no_cause`. If the provider has no web search, the result is `failed` with "provider has no web search", the same pattern as the graph refresh. It respects the § F0.7 dollar cap: over cap → `capped`, with no LLM call.
3. **Triggers.**
   - **Manual:** `POST /api/intel/research {question, asset?}` (authed). It is synchronous within the deadline and allows one in flight, using a `running` row in `intel_research` that goes stale after deadline + 15 s, not a process-local flag (409 otherwise), and `INTEL_RESEARCH_DAILY` (default 10) per UTC day applies (429 after).
   - **Automatic:** inside `POST /cron/intel/ingest`, as its own last stage, started only when the remaining budget is > `RESEARCH_DEADLINE_MS`. It runs for FlowFlags whose materiality is ≥ the alert threshold and that have no news alert on the same asset in the last 6 h, highest first. At most `INTEL_RESEARCH_AUTO_DAILY` (default 3) per UTC day, deduplicated by flag id, inside the route's existing time budget.
   - Telegram `/ask` is unchanged (Desk).
4. **Storage.** Table `intel_research` (migration `010_research.sql`) behind `IntelStore` (Pg and Memory, parity-tested), with 90-day retention. Methods: `insertResearch`, `listResearch({asset?, since?, limit})`, `researchCountSince(since, trigger?)`, `researchForFlag(flagId)`.
5. **Thresholds.** Two env thresholds on one materiality scale:
   - `INTEL_PUSH_MATERIALITY` (existing, 0.35) is the alert threshold: Telegram push, plus eligibility for automatic research.
   - `INTEL_DIGEST_MATERIALITY` (new, default 0.10) is the digest threshold. Items below it are logged but not shown in the What-changed digest or `/digest`.
6. **Confluence.** There is one seam, `materiality(parts, k)` in `diff.ts`, which returns `surprise × exposure × proximity × confluence(k)`, where `confluence(k) = min(1.5, 1 + 0.25 × (k − 1))`. The four inline formulas (diff, flowEvents, mapper, catalysts) call it. `k` counts the distinct signal sources on the asset within the window: snapshot z moves, flow detectors, flips/crossings, and news alerts. **The item's own source is excluded**, so a flag never boosts itself. `k` is computed before alerts are routed, because routing reads materiality at insert time. The factor is exposed on the item (`confluence: number`) so the UI can show it.
7. **Graph diff-review.** A graph refresh never deletes edges for an asset whose rebuild failed or returned nothing. Each refresh records a diff per asset (`added`, `removed`, `changed`, `refused`) in its summary and in `collector_runs`. `refreshGraph` already never deletes, so the only new behaviour is this: edges that a successful rebuild no longer proposes are removed, unless they are `seed` or `manual` (a set diff plus one store delete method).
8. **UI** (binding layout in DESIGN-terminal.md § 16):
   - **Research panel** on `/`: an ask box (question + optional asset) and the latest results, newest first, with status, explanation, evidence rows tagged OBS/HYP with link and ts, confidence and open questions.
   - **Detector chips:** a "research" action when a flag has no result yet, or "see research" when it does.
   - **`/asset/:coin`:** research results join the timeline as events.
   - **Digest items** show their confluence factor when it is > 1.
   - Every new panel has the named states.
9. **Cleanup.** The UI client functions `intel.events` and `intel.flows` have no callers and are removed. Their server routes stay because they are tested.

### S1. API delta

- `POST /api/intel/research {question: string(3..500), asset?: string, flagId?: string}` → `ResearchResult`. A chip-started run keeps `trigger: "manual"` (it counts toward `INTEL_RESEARCH_DAILY`) and stores `flagId`, so `researchForFlag` finds it whatever the trigger. Errors: 409 when a run is in flight, 429 when the daily limit is reached. Over the dollar cap it returns 200 with `status: "capped"`.
- `GET /api/intel/research?asset&limit=20` → `{items: ResearchResult[], usedToday, limit}`.
- `FlowFlag` gains `researchId: string|null`, joined at read time through `researchForFlag`. The stored flag JSON is never mutated. `AssetEvent.kind` gains `research`, and such events carry `research: ResearchResult`.

### S2. Done

- Fixture tests:
  - `research.ts`: found, no_cause, capped, no web search, an invented URL downgraded to hypothesis, a number missing from its excerpt downgraded, a number in the explanation that is in neither the payload nor the evidence dropped, an advice line dropped, and the `running` lock going stale.
  - `confluence`.
  - The threshold split.
  - Graph diff-review: a failed rebuild keeps edges.
  - Routes: 409, 429 and capped.
  - Store parity.
- `bun test` (including the pre-existing `analyst.test.ts` default-provider failure, fixed), `bun run typecheck`, `bun run build` and `bun run check:api` are green.
- `/` shows the Research panel, and every state renders without a DB.

## What is explicitly OUT of scope

- Hyperliquid mainnet execution. The Desk trades paper or testnet only; the ENGINE pages only proxy operator actions to the Hyperion core, which owns its own governor and venues.
- LLM calls anywhere except the Analyst (incl. its SIMULATE mode), the Desk and Intel (§ Intel). Multi-user/accounts. Telegram delivery outside the Desk notifier and Intel alerts. The Go TUI.
- Paths v1: the Desk/paper bridge, per-position open/close dates, funding and fee modelling, Monte Carlo for levered or short branches.

## Environment variables

`DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET`, `CRON_TOKEN`, `FRED_API_KEY` (optional), `ELFA_API_KEY` / `ELFA_MIN_INTERVAL_HOURS` (optional), `ROUTINE_WEBHOOK_URL` (optional), `ENGINE_URL` / `ENGINE_TOKEN` (optional, engine console), `ANALYST_PROVIDER` / `DESK_ANALYST_MODEL` / `ANALYST_API_KEY` / `ANALYST_BASE_URL` / `ANALYST_EFFORT` / `ANALYST_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` / `DESK_ANTHROPIC_FIRST` / `ANALYST_OPENAI_API_KEY` / `ANALYST_OPENAI_BASE_URL` / `ANALYST_MODELS`, and the vendor keys `OPENAI_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY` / `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY` / `OPENROUTER_API_KEY` (all optional, analyst — see README.md "Analyst" for precedence and per-preset overrides). Intel tuning (all optional, defaults in README.md "Intel"): `COINALYZE_API_KEY`, `INTEL_FLOW_MAX_COINS`, `INTEL_DELEV_OI_PCT`, `INTEL_THRESHOLDS`, `INTEL_LLM_DAILY_USD`, `INTEL_PUSH_MATERIALITY`, `INTEL_DIGEST_MATERIALITY`, `INTEL_RESEARCH_DAILY`, `INTEL_RESEARCH_AUTO_DAILY`.

GitHub Actions repository secrets (Settings > Secrets and variables > Actions), used by `.github/workflows/collect.yml`:

- `APP_URL` — deployed origin, e.g. `https://hypertrade.vercel.app` (no trailing slash; a trailing slash is stripped anyway).
- `CRON_TOKEN` — must match the app's `CRON_TOKEN` env var, or the endpoint returns 401.

Both are required: the workflow fails its preflight step with a named error if either is unset.

## Definition of done

- `bun install && bun run build` green (typecheck included); `bun test` green (sim engine, baseline math, auth, collector parsers — fixture-based, no live network in tests).
- Local `vercel dev`-equivalent run serves UI + API; login works; a branch can be created, simulated against real backfilled candles, and rendered.
- `POST /api/cron/collect` populates observations against a provisioned Supabase instance.
- Deployed to Vercel with Supabase provisioned, envs set, and the URL responding behind the password gate.
