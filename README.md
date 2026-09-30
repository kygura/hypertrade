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

## Prop-trading contract

`PROP.md` is the operator's own rulebook for trading a Breakout evaluation
with this app as journal and enforcer: the firm's limits, the risk framework
derived from them, the setup ledger, the session protocol and the gates that
must clear before a fee is paid. The journal that enforces it is T13–T15 in
`TASKS.md`.

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
decisions) plus web search. It never places or approves anything; Jev and the
operator own the trading loop. Server: `src/server/llm/*`,
`src/server/routes/analyst.ts` (`POST /api/analyst/query`, SSE;
`GET /api/analyst/models`, the model catalog). UI:
`src/ui/components/analyst/ModelSelector.tsx`, in the Analyst page header.

Both providers — `anthropic` and `openai-compatible` — can be configured **at
the same time**; the model selector in the page header lets the operator
pick per question (persisted per-browser in `localStorage`). Env vars, in
precedence order:

- `ANALYST_PROVIDER` — `anthropic` (default) or `openai-compatible`. Names
  the **server default**: the provider/model used when a query omits
  `provider`/`model`/`effort`, and the only provider that reads the legacy
  `ANALYST_API_KEY`/`ANALYST_BASE_URL`/`ANALYST_MODEL` settings below.
- `ANALYST_API_KEY` / `ANALYST_BASE_URL` / `ANALYST_MODEL` — the **default
  provider's** key, base URL and model override (unchanged from before the
  selector existed). `ANALYST_BASE_URL` is required when the default is
  `openai-compatible`; optional override for anthropic.
- `ANALYST_ANTHROPIC_API_KEY` — anthropic's key when anthropic is *not* the
  default provider (or as an explicit alternative when it is). Setting this
  is what makes anthropic selectable alongside a different default provider.
- `ANALYST_OPENAI_API_KEY` / `ANALYST_OPENAI_BASE_URL` — same idea for
  `openai-compatible`.
- `ANALYST_MODELS` — `openai-compatible`'s selectable model catalog, since an
  arbitrary endpoint's models aren't known ahead of time:
  `id,id2=Label Two,id3` (comma-separated ids, optional `id=Label` pairs).
  Unset → falls back to a single entry from `ANALYST_MODEL`, but only when
  `openai-compatible` is the default provider (`ANALYST_MODEL` otherwise
  belongs to whichever provider *is* the default).
- `ANALYST_EFFORT` — anthropic effort level (`low`…`max`, default `medium`)
  used when a query doesn't pick one explicitly.

Unset/unconfigured is never a hard failure for the catalog:
`GET /api/analyst/models` always answers `200` — even with nothing
configured — as `{ default: {provider, model}, providers: [{ id, label,
available, reason?, models: [...] }] }`, so the UI can show *why* each
provider is unavailable (e.g. "set ANALYST_ANTHROPIC_API_KEY"). Anthropic's
model list (Fable 5.1 / Opus 5.5 / Sonnet 5 / Haiku 4.5, each with a tier and
whether it takes an `effort` level) is fixed in `src/server/llm/catalog.ts`;
`POST /api/analyst/query`'s `provider`/`model`/`effort` are validated against
this catalog and rejected with `400 { error, field }` (`field` is
`"provider"`, `"model"` or `"effort"`) rather than silently substituted.
`GET /api/analyst/status` and the legacy behaviour are unchanged: unset
default provider → `503 { "error": "analyst not configured" }` and the page
shows its offline state.

Web search is available only with the anthropic provider (server-side tool);
with `openai-compatible` the status endpoint and page mark it unavailable.
Each question is bounded to 8 tool rounds and 90 seconds.
