# Fallback routine: provider-agnostic setups pulse and daily brief

Status: spec for the GitHub Actions routine that runs without Claude Code.
It reuses the app's own LLM layer (`src/server/llm/`, Kimi via the
`moonshot` preset by default) and runs from `.github/workflows/routine.yml`.

The Claude Code scheduled routine (`CLAUDE.md`) keeps working while it
exists. This pipeline adds two things it never had: a frequent **setups
pulse** and a persistent **HTF view**. It can also take over the daily
MarketState/Sectors write (`--mode daily`) once `ROUTINE_FALLBACK=true`.

## Principles

1. **Code measures, the model interprets.** Every number the model sees is
   fetched and computed in code (collect + HTF features). The model never
   fetches. Status of a setup (triggered, invalidated, target hit, expired)
   is decided by code against prices, never by the model.
2. **Restraint is enforced, not requested.** The prompt asks for restraint;
   `gate.ts` enforces it. A setup that breaks a rule is dropped and the
   reason is logged in the run output.
3. **HTF first.** Every run reads the HTF view before proposing anything.
   Setups that fight the view are allowed only as low-conviction
   counter-trend ideas, at most one open at a time.
4. **"Nothing worth doing" is a valid, common answer.** A run with zero new
   setups and no status change sends no notification.
5. **Setups are conditional plans for a human, not orders.** No position
   size, no leverage, no execution path. Risk is expressed in R multiples.

## Modes

`bun run routine --mode <pulse|daily|htf> [--dry-run]`

| Mode | Cron (UTC) | Writes | Gate |
|---|---|---|---|
| `pulse` | `17 */4 * * *` | `data/setups/ledger.json`, `data/setups/htf.json` (when refreshed) | runs whenever an LLM key is present |
| `daily` | `40 6 * * *` | pulse outputs + MarketState, Sectors, `data/lab/<date>.json` | repo variable `ROUTINE_FALLBACK == 'true'` |
| `htf` | manual dispatch | `data/setups/htf.json` | forced refresh; proposes no setups |

`pulse` refreshes the HTF view itself when the view is missing, older than
7 days, or the hl-cycles `regime.state` differs from the view's
`hl_cycles_state`. So the HTF view stays current even while `daily` is
dormant.

`--dry-run`: collect, call the model, validate, print the brief and the
would-be file diffs; write nothing, send nothing.

Without an LLM key the run exits 0 with a notice ("no LLM provider
configured"), so a missing secret never turns the schedule red.

## Pipeline per run

1. **Load state**: `data/setups/ledger.json`, `data/setups/htf.json`,
   latest `data/marketstate`, `data/sectors`, `data/lab` files.
2. **Collect** (`collect.ts`), every fetch with a timeout; a failure becomes
   a `gaps[]` entry `{source, status, detail}`, never a crash:
   - Hyperliquid `metaAndAssetCtxs`: mark, prevDayPx, OI (USD), funding for
     the whole universe; keep BTC, ETH, SOL, HYPE plus the top 25 by OI.
   - Hyperliquid `candleSnapshot` daily (400 d) and weekly (3 y) for BTC,
     ETH, SOL, HYPE, and hourly (`1h`) candles since each open setup's
     `updated_at` for every asset with an open setup (status checks need
     the high/low path, not only the mark; hourly bars keep the "which came
     first" ambiguity of one bar small).
   - hl-cycles `vector.json` + `health.json` (regime, levels, compass,
     brief confirm/invalidate).
   - FRED CSV: DGS10, DGS2, T10Y2Y, VIXCLS, DTWEXBGS, DCOILBRENTEU,
     NASDAQCOM. Retry once on a fresh connection (`connection: close`) on a
     transport error.
   - Yahoo chart: SPY, QQQ, NVDA, ^VIX (1mo daily).
   - Fear & Greed (31 d), DefiLlama stablecoin total (now, −7 d, −30 d).
   - App (only when `APP_URL` and `LAB_API_TOKEN` are set):
     `/api/metrics/summary` (ids from CLAUDE.md §2.2), `/api/sectors`,
     `POST /api/lab/tools/lab_market_pulse`, `lab_catalogue_list`.
   A gap's `detail` is a short reason written by the code (`HTTP 503`,
   `response is not JSON`), never response text. Strings from outside
   sources (hl-cycles, Lab rules, gaps) reach the model only inside
   `untrusted()`; HL symbols and the hl-cycles regime state are
   shape-checked at parse.
3. **HTF features** (`htf.ts`, pure, unit-tested) per major: close vs
   20W/50W SMA and 200D SMA, distance from 52-week high/low, 30-day
   realised vol (annualised), 4-week return, weekly trend label
   (`up | down | range` from SMA slope and price position). Deterministic.
4. **Update open setups** (`ledger.ts`, pure, unit-tested) against the
   candle path since `updated_at`, in time order:
   - `watching` → `triggered` when a candle trades into the entry zone.
   - `watching` → `invalidated` ("never filled") when price crosses the
     invalidation level first.
   - `watching`, one candle reaching invalidation that also traded the
     entry zone and did not open beyond invalidation → filled and stopped
     (−1R). Targets are not checked on the candle that triggers.
   - `triggered` → `invalidated` (stopped, −1R) when invalidation trades.
   - `triggered` → `target_hit` when the first target trades (record R).
   - Same candle touches both invalidation and target → invalidation wins
     (conservative).
   - Any open setup past `expires_at` → `expired` (a triggered one is
     marked to the last close in R; a cancelled triggered one to the mark).
   Keep closed setups for 90 days in `closed[]`, then drop them. The ledger
   file is rewritten only when something besides the check timestamps
   changed, so a quiet pulse leaves no commit.
5. **Model call** via `completeStructured` from `src/server/intel/llm.ts`
   with an in-memory cache and the provider chain below. Input: HTF view,
   HTF features, the condensed context pack, open and recently closed
   setups with their outcomes, the gaps list. Output (zod-validated):
   - `regime_read`: one or two sentences, where we stand.
   - `htf_view` (only when a refresh is due).
   - `new_setups[]` (0–3 proposals).
   - `cancel[]`: `{id, reason}` for open setups whose thesis broke before
     price did.
   - `stand_aside_reason` when `new_setups` is empty.
   - `brief`: short delta-first text.
   - In `daily` mode also MarketState + Sectors per `src/shared/schemas.ts`
     and ROUTINE.md §c–e (separate call, `kimi-k3`).
6. **Gate** (`gate.ts`, pure, unit-tested) each proposal:
   - asset exists in the live HL universe;
   - the mark is not already beyond the invalidation level
     (`already_invalid`);
   - direction-consistent levels: long ⇒ invalidation < entry.low ≤
     entry.high < targets ascending; short mirrored;
   - entry zone width ≤ 4% of its midpoint; invalidation distance from
     entry mid between 1% and 25%;
   - R:R to first target, computed in code from entry mid, ≥ 2.0;
   - `expires_at` ≤ 14 days (`swing`) or 45 days (`position`);
   - no other open setup on the same asset and direction;
   - counter-regime (`regime_alignment: counter`) ⇒ conviction `low`, and
     at most one counter-regime setup open;
   - HTF stance `stand_aside` ⇒ no new setups at all;
   - caps: at most 5 open setups, at most 2 new per `pulse`, 3 per `daily`.
   Rejected proposals are listed in the run output with the failing rule.
   `htf` mode skips this step: it asks for no setups and ignores any.
7. **Write** ledger/view (and daily files), print the brief, write the
   GitHub step summary.
8. **Notify** (Telegram, plain text, split under 4000 chars) only when:
   a setup was added, changed status or was cancelled; the HTF view was
   refreshed with a regime change; or `daily` ran.
9. **Commit** (workflow): pulse/htf stage `data/setups/*.json` only. A
   daily commit runs `bun run typecheck && bun test src` first; green goes
   to the default branch, red is committed anyway and pushed to
   `routine/<RUN_DATE>` (no deploy there), then the job fails. The run
   date comes from the run itself (`run_date` step output).

Exit codes: 0 without an LLM key; 1 when `ROUTINE_LLM` has no usable
entry, every provider failed, or the daily stage failed (pulse outputs
computed before the failure are still written).

## Data shapes (`src/server/routine/schema.ts`)

```ts
Setup {
  id: string            // `${asset}-${direction}-${YYYYMMDD}-${n}`
  asset: string         // HL symbol, case-sensitive
  direction: "long" | "short"
  horizon: "swing" | "position"
  thesis: string        // why, citing measured numbers
  regime_alignment: "with" | "counter"
  trigger: string       // the checkable condition to act on
  entry: { low: number; high: number }
  invalidation: number
  invalidation_reason: string
  targets: number[]     // 1–3, in profit order
  rr: number            // computed by code, never taken from the model
  conviction: "low" | "medium" | "high"
  evidence: string[]    // context keys, e.g. "hl-cycles.levels.sth_cost_basis"
  status: "watching" | "triggered" | "invalidated" | "target_hit" | "expired" | "cancelled"
  status_note: string | null
  r_result: number | null   // realised R when closed after a trigger
  triggered_at: string | null  // when the entry zone first traded
  created_at: string; updated_at: string; expires_at: string
}
Ledger { updated_at: string; open: Setup[]; closed: Setup[];
         stats: { closed_90d: number; triggered_90d: number; hit_rate: number | null; avg_r: number | null } }
         // triggered_90d counts setups with triggered_at; avg_r averages those with a realised R
HtfView {
  generated_at: string; valid_until: string
  hl_cycles_state: string | null
  regime: "risk_on" | "neutral" | "risk_off"
  stance: "trend_long" | "range" | "trend_short" | "stand_aside"
  thesis: string              // the long-term view, 3–6 sentences
  biases: { asset: string; bias: "long" | "short" | "neutral"; levels: { label: string; price: number }[]; note: string }[]
  what_changes_it: string[]   // checkable: metric, threshold, direction
}
```

## Provider chain

`ROUTINE_LLM` = comma-separated `provider:model[@effort]`, tried in order on
failure (missing key, HTTP error, invalid output after retry). Default
`moonshot:kimi-k3@high,moonshot:kimi-k2.6`. Any preset in
`src/server/llm/presets.ts` works (`openrouter:…`, `deepseek:…`,
`openai-compatible:…`, `anthropic:…`). Spend cap per run:
`ROUTINE_MAX_USD` (default 1.00), using `usageCost` from intel/llm.ts.

## Secrets and variables (Actions)

| Name | Kind | Needed by |
|---|---|---|
| `MOONSHOT_API_KEY` (or any key the chain names) | secret | all modes |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | secret | notifications (optional) |
| `APP_URL`, `LAB_API_TOKEN` | secret | app metrics, sectors, Lab pulse (optional; without them the run uses public sources only and says so) |
| `ROUTINE_LLM`, `ROUTINE_MAX_USD` | variable | optional overrides |
| `ROUTINE_FALLBACK` | variable | `true` enables `daily` |

## Deploys

`data/setups/**` changes alone must not redeploy the app.
`vercel.json` `ignoreCommand` skips the build when nothing outside
`data/setups/` changed. `daily` touches `data/marketstate` and
`data/sectors`, so it still deploys.

## Out of scope

Lab search/save/prune (stays with the Claude routine or a human), Desk,
order placement, position sizing, signing keys.
