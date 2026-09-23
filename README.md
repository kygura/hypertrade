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
`src/server/routes/analyst.ts` (`POST /api/analyst/query`, SSE).

- `ANALYST_API_KEY` — provider key, server-side only. Unset: `503 { "error": "analyst not configured" }` and the page shows its offline state.
- `ANALYST_PROVIDER` — `anthropic` (default) or `openai-compatible`.
- `ANALYST_MODEL` — model id; defaults to the provider module's default (`claude-opus-5-5` for anthropic).
- `ANALYST_BASE_URL` — required for `openai-compatible` (the `/v1` base of a Chat Completions endpoint); optional override for anthropic.
- `ANALYST_EFFORT` — anthropic effort level (`low`…`max`, default `medium`).

Web search is available only with the anthropic provider (server-side tool);
with `openai-compatible` the status endpoint and page mark it unavailable.
Each question is bounded to 8 tool rounds and 90 seconds.
