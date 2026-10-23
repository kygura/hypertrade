# Routine pipeline: board scan, setups and the daily brief

Status: the contract for `bun run routine`, the code path behind the
scheduled routine. The Claude Code session (`ROUTINE.md`) runs the same
pipeline and stands in for the model call with `--input`; without a session
the pipeline calls the app's own LLM layer (`src/server/llm/`: Claude Opus
5.5 by default, Kimi via the `moonshot` preset when the Anthropic call
fails). The scheduled workflow that ran it (`routine.yml`) was removed; the
cron and Actions sections below describe how it ran and apply again if it is
restored.

## Principles

1. **Code measures, the model interprets.** Every number is fetched and
   computed in code: the board, the tripwires, the level menu. The model
   names structure (which market, which side, which levels by key, why) and
   reads what one-dimensional thresholds miss. It never fetches, never
   computes, never writes a price.
2. **Proactive, not restless.** The board nearly always has something
   leaning, so every run names the most imbalanced markets and what would
   arm them, and a setup is proposed wherever an imbalance meets a level.
   Restraint is enforced by `gate.ts` (R, zone, caps, one per market and
   side), not by a default of standing aside.
3. **The ledger grades the hypotheses.** Status (triggered, invalidated,
   target hit, expired) is decided by code against prices. Template ids and
   timeframes ride on every setup, so outcomes can be grouped per setup type.
4. **Facts in, numbers checked out.** Text the model writes (theses,
   triggers, watchlist notes) is dropped when it cites a number the board
   did not show (`numbersBacked`, `src/server/intel/numbers.ts`).
5. **Setups are conditional plans for a human, not orders.** No position
   size, no leverage, no execution path. Risk is expressed in R multiples.

## Modes

`bun run routine [--mode <scan|daily>] [--dry-run] [--collect-only] [--context <file>] [--input <file>] [--push-out <file>]`

| Mode | Cadence | Collects | Writes |
|---|---|---|---|
| `scan` (default) | every 4 h | HL, the board, hl-cycles, app metrics and Lab pulse (when keyed), calendar | `data/setups/ledger.json` (when something moved), `data/board/history.json`, `data/board/latest.json` |
| `daily` | once a day | the above plus FRED, Yahoo, Fear & Greed, stablecoins, the majors' HTF candles | scan outputs + MarketState, Sectors, `data/lab/<date>.json` |

- `--collect-only` prints the scan rules (the system prompt), the board and
  the context, then stops. With `--context <file>` it saves the collection.
- `--input <file>` replaces the model call with a scan output written by an
  external agent; with `--context` it resolves against the saved board and
  collects nothing. A context older than 2 h is refused. `daily` does not
  take `--input`.
- `--push-out <file>` writes the push text there (empty on a quiet run)
  instead of sending it to Telegram.
- `--dry-run`: collect, call the model, validate, print the brief and the
  would-be files; write nothing, send nothing.

Without an LLM key (and without `--input`) the run exits 0 with a notice
("no LLM provider configured"), so a missing secret never turns a schedule
red.

## Pipeline per run

1. **Load state**: `data/setups/ledger.json`, `data/setups/htf.json`,
   `data/board/history.json`, `data/board/latest.json`. A ledger or view that
   exists but does not parse stops the run. The board files are derived
   data: an unreadable one is a note and starts over.
2. **Collect** (`collect.ts`), every fetch with a timeout; a failure becomes
   a `gaps[]` entry `{source, status, detail}`, never a crash:
   - Hyperliquid `metaAndAssetCtxs` for the whole universe and
     `predictedFundings` (Binance, Bybit and HL next funding).
   - **Board** (`collectBoard`): the top 30 live markets by 24 h notional
     volume above a $5M OI floor, plus BTC, ETH, SOL, HYPE and
     `PLATFORM_MY_MARKETS` wherever listed. Per market: 4h candles (30 d),
     daily candles (365 d; weeks are built from them), hourly funding (7 d).
     Three markets in flight; the HL weight guard paces the rest (about
     2–3 min for 33 markets).
   - Hourly candles since each open setup's last check (status needs the
     high/low path).
   - hl-cycles `vector.json` + `health.json`, the intel calendar's next FOMC,
     CPI and NFP, app metrics and Lab pulse when `APP_URL` and
     `LAB_API_TOKEN` are set.
   - `daily` only: FRED CSV (DGS10, DGS2, T10Y2Y, VIXCLS, DTWEXBGS,
     DCOILBRENTEU, NASDAQCOM), Yahoo (SPY, QQQ, NVDA, ^VIX), Fear & Greed,
     DefiLlama stablecoins, the majors' daily (400 d) and weekly (3 y)
     candles.
   A gap's `detail` is a short reason written by the code, never response
   text. Strings from outside sources reach the model only inside
   `untrusted()`; HL symbols and the hl-cycles regime state are
   shape-checked at parse.
3. **Board** (`board.ts`, pure). Per market and timeframe, on completed bars
   only (a forming bar is not a close): ATR14 and ATR%, SMA20/50, mark vs
   SMA20 in ATRs, trend (`up` = close > SMA20 > SMA50 with SMA20 up ≥ 0.25
   ATR over 5 bars; `down` mirrored; else `range`), the prior range
   (20 bars on 4h and 1d, 12 on 1w), the mark's position in it, breakout
   and sweep of the last bar, volume ratio, ATR5/ATR20. Positioning: funding
   now, 24 h and 7 d annualised, its 7 d percentile, Binance/Bybit funding
   and the HL spread to it, premium, OI and OI/volume, OI change in
   contracts over 4 h / 24 h / 7 d from the committed history, price change
   over the same windows, and the 24 h price × OI quadrant. Then relative
   strength vs BTC and a robust cross-sectional z (median/MAD) for funding,
   OI change and 24 h return. HL funding carries a fixed interest component:
   neutral reads ~10.95% annualised.
   The **level menu** per market: `mark`, `4h.high20/low20/sma20`,
   `1d.pdh/pdl/high20/low20/sma20/sma50/sma200`,
   `1w.pwh/pwl/high12/low12/sma20`. A setup may use no other price.
4. **Tripwires** (`tripwires.ts`, pure): commonplace setups as data, each a
   list of hard conditions over a board row. `funding_fade` (short),
   `negative_funding_build` (long), `post_liquidation_reclaim` (long),
   `range_breakout`, `failed_breakout` and `htf_pullback` (both sides).
   All conditions met = a hit; all but one numeric condition, within one
   limit-width of its limit = a near-miss. Missing data fails a condition.
   Thresholds live in `TRIPWIRES`; they are starting points for the ledger
   and the Lab event study to grade, not claims of an edge.
5. **Update open setups** (`ledger.ts`, pure, unit-tested) against the
   hourly path since `updated_at`, in time order:
   - `watching` → `triggered` when a candle trades into the entry zone.
   - `watching` → `invalidated` ("never filled") when price crosses the
     invalidation level first.
   - `watching`, one candle reaching invalidation that also traded the
     entry zone and did not open beyond invalidation → filled and stopped
     (−1R). Targets are not checked on the candle that triggers.
   - `triggered` → `invalidated` (stopped, −1R) when invalidation trades.
   - `triggered` → `target_hit` when the first target trades (record R).
   - Same candle touches both invalidation and target → invalidation wins.
   - Any open setup past `expires_at` → `expired` (a triggered one is
     marked to the last close in R; a cancelled triggered one to the mark).
   Closed setups are kept 90 days.
6. **Scan** (model call via `completeStructured`, or `--input`). The prompt
   (`SCAN_SYSTEM`, `scanUser` in `prompts.ts`) carries the board one market
   per line, the tripwires with every condition's value, open and recently
   closed setups, last run's watchlist, hl-cycles, catalysts, unusual app
   metrics, firing Lab rules and gaps. Output (`ScanOutputSchema`):
   - `read`: where the board leans and the largest imbalance.
   - `watchlist[]` (≤ 6): `{asset, kind, skew, timeframe, note, arms,
     evidence}`; `kind` from a fixed list of commonplace imbalances
     (`crowded_longs`, `shorts_pressing`, `short_covering`,
     `venue_divergence`, `compression`, …).
   - `setups[]` (≤ 3): `{asset, direction, template, timeframe, imbalance,
     thesis, trigger, entry: {low, high}, invalidation, invalidation_reason,
     targets, conviction, evidence}` where every price is a reference
     `{level: <menu key>, atr?: <signed multiple>}` and a target may be
     `{level: "R", r: <multiple>}`.
   - `passes[]`: every tripwire hit not written up, with why.
   - `cancel[]`: `{id, reason}` for open setups whose premise broke.
   - `brief`: short, delta-first text.
7. **Resolve** (`scan.ts`, pure): level keys and ATR offsets (the 4h ATR for
   a 4h setup, else the 1d ATR) become prices at 5 significant figures; R
   targets are measured from the entry midpoint; `regime_alignment` is
   `counter` when the setup fights the market's weekly trend (daily when
   the market is too young), and a counter setup's conviction is capped at
   low; `expires_at` comes from the timeframe (4h: 3 days, 1d: 7, 1w: 10).
   A draft is dropped as `unknown_asset`, `level_missing` or
   `unbacked_number`; a watchlist item off the board or citing an unshown
   number is dropped too. Hits neither set up nor passed are listed as not
   addressed.
8. **Gate** (`gate.ts`, pure, unit-tested) each resolved proposal:
   - the operator's HTF view (`data/setups/htf.json`), while `valid_until`
     has not passed, with stance `stand_aside` ⇒ no new setups; a missing
     or lapsed view blocks nothing;
   - asset in the live HL universe; mark not already beyond invalidation;
   - long ⇒ invalidation < entry.low ≤ entry.high < targets ascending;
     short mirrored;
   - entry zone ≤ 4% of its midpoint; invalidation 1–25% from it;
   - R to the first target ≥ 2.0, computed by code;
   - `expires_at` ≤ 10 days (`swing` is the only horizon);
   - no other open setup on the same asset and direction;
   - counter-trend ⇒ conviction low, at most one counter setup open;
   - caps: at most 5 open, 2 new per `scan`, 3 per `daily`.
   Accepted setups carry `setup_id` (the template, or null), `timeframe`
   and `levels_source: "menu"`.
9. **Write**: the ledger when something besides check timestamps changed;
   a board snapshot every run (`[mark, OI in contracts, hourly funding]`
   per market, 8 days kept, a re-run within 30 min replaces it); the scan
   record; in `daily`, MarketState, Sectors (tokens checked against the live
   universe), the history indexes and the Lab snapshot.
10. **Notify** only when something is new: a setup accepted, an open setup
    changed status or was cancelled, a tripwire hit the last run did not
    have, or `daily` wrote its files. Telegram (plain text, split under
    4000 chars), or the push text to `--push-out` for the Claude routine's
    ntfy push. A watchlist change alone never pushes.

Exit codes: 0 without an LLM key; 1 when `ROUTINE_LLM` has no usable entry,
every provider failed, the input is invalid, the context is stale, or the
daily stage failed (scan outputs computed before the failure are still
written); 2 for `daily` with `--input`.

## Data shapes

`src/shared/setups.ts` (persisted setups), `src/server/routine/schema.ts`
(model shapes), `src/server/routine/board.ts` and `run.ts` (board files).

```ts
Setup {
  id: string            // `${asset}-${direction}-${YYYYMMDD}-${n}`
  asset: string         // HL symbol, case-sensitive
  direction: "long" | "short"
  setup_id: string | null  // tripwire template (SETUP_IDS); null = an imbalance no template covers
  levels_source: "code" | "menu" | "model"  // menu = model-picked keys resolved by code
  horizon: "swing"
  timeframe: "4h" | "1d" | "1w" | null      // the trigger's bar; null on older ledgers
  thesis: string; regime_alignment: "with" | "counter"; trigger: string
  entry: { low: number; high: number }; invalidation: number; invalidation_reason: string
  targets: number[]     // 1–3, in profit order
  rr: number            // computed by code
  conviction: "low" | "medium" | "high"
  evidence: string[]    // board keys, e.g. "HYPE.pos.fundingAnnPct"
  status: "watching" | "triggered" | "invalidated" | "target_hit" | "expired" | "cancelled"
  status_note: string | null; r_result: number | null; triggered_at: string | null
  created_at: string; updated_at: string; expires_at: string
}
Ledger { updated_at; open: Setup[]; closed: Setup[]; stats: { closed_90d; triggered_90d; hit_rate; avg_r } }
BoardHistory { updated_at; snapshots: { t: string; rows: Record<coin, [mark, oiContracts, fundingHourly]> }[] }
ScanRecord {   // data/board/latest.json
  generated_at; read; watchlist: WatchItem[]
  hits, near: { asset; setup_id; direction; gap? }[]
  new_setups: string[]; rejected: { asset; direction; rule; detail }[]
  passes: { asset; template; direction; reason }[]; unanswered: string[]; brief
}
HtfView {   // data/setups/htf.json: the operator's optional stance
  generated_at; valid_until; hl_cycles_state
  regime: "risk_on" | "neutral" | "risk_off"
  stance: "trend_long" | "range" | "trend_short" | "stand_aside"
  thesis; biases[]; what_changes_it[]
}
```

## Provider chain

`ROUTINE_LLM` = comma-separated `provider:model[@effort]`, tried in order on
failure (missing key, HTTP error, invalid output after retry). Default
`anthropic:claude-opus-5-5@high,moonshot:kimi-k3@high,moonshot:kimi-k2.6`:
Claude first; an Anthropic account out of credits answers with an HTTP
error, so the run moves on to Kimi without any change. To pin another
model, set the `ROUTINE_LLM` repository variable (Settings → Secrets and
variables → Actions → Variables); clearing it restores the default. Any preset in
`src/server/llm/presets.ts` works (`openrouter:…`, `deepseek:…`,
`openai-compatible:…`, `anthropic:…`). Spend cap per run:
`ROUTINE_MAX_USD` (default 1.00), using `usageCost` from intel/llm.ts.

## Secrets and variables (Actions)

| Name | Kind | Needed by |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | default model (optional: without it the chain starts at Kimi) |
| `MOONSHOT_API_KEY` (or any key the chain names) | secret | fallback; all modes when Anthropic is absent |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | secret | notifications (optional) |
| `APP_URL`, `LAB_API_TOKEN` | secret | app metrics, sectors, Lab pulse (optional; without them the run uses public sources only and says so) |
| `ROUTINE_LLM`, `ROUTINE_MAX_USD` | variable | optional overrides |
| `PLATFORM_MY_MARKETS` | variable | markets always on the board (default `BTC,ETH,HYPE,SOL,XPL,LIT,ZEC`) |
| `ROUTINE_FALLBACK` | variable | `true` enables `daily` |

## Deploys

`data/setups/**` and `data/board/**` changes alone must not redeploy the
app. `vercel.json` `ignoreCommand` skips the build when nothing outside
them changed. `daily` touches `data/marketstate` and `data/sectors`, so it
still deploys.

## Out of scope

Lab search/save/prune (stays with the Claude routine or a human), Desk,
order placement, position sizing, signing keys.
