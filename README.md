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
