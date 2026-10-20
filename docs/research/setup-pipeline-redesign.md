# Proposal: conditional daily/weekly setup pipeline

Status: proposal (2026-10-20). Nothing here is built. It reads the current
routine, scanner, Lab and collectors, says what each one gives a perp trader
today, and proposes a redesign. In the redesign, code generates candidate
setups on daily and weekly bars, conditional on regime, and the LLM writes
the narrative.

The hard rule is unchanged. A setup is a conditional plan for a human:
trigger, entry zone, invalidation, targets and evidence, with risk in R. It
never carries size, leverage or an execution path.

---

## 1. What runs today and what it gives a perp trader

| Pipeline | Cadence | Timeframe | Output | Value to a perp trader |
|---|---|---|---|---|
| Platform scanner (`platform/scanner.ts`, `setups.ts`) | 60 s (worker) or hourly (tick) | 15 m / 1 h z-scores on a 24 h ring | `opportunities`, near-miss, Telegram "ready" | Intraday positioning extremes: crowded longs, negative-funding squeeze, deleveraging washout, vol breakout. Every idea is marked at 1/4/24/72 h, so it is the only pipeline with an honest track record. Uses HL data only. |
| Outcomes + ledger stats (`outcomesLoop.ts`, `stats.ts`) | 60 s | 1 h–72 h | `ledger_entries`, clustered stats | Answers "has this setup kind paid, net of costs?". After 30 clusters, edge switches from theoretical to measured. |
| Novelty (`noveltyLoop.ts`, `novelty.ts`) | Hourly, acts once per UTC day | Daily | `platform_novelty`, ≤ 3 pushes | Flags when funding, OI or volatility hit a full-history or joint extreme on a coin. This is the closest thing to a daily signal, and it is information only. |
| Lab (`lab/engine/*`, `service.ts`) | On demand + the 4 h routine | Daily | Catalogue, `market_pulse`, event study | Searches simple daily rules and validates them walk-forward with a holdout and deflated Sharpe. A rule is "live" only in the pull-only pulse and never reaches the scanner or the setups ledger. |
| Intel (`intel/*`) | 15 min, self-throttled | News / 6–24 h windows | Events, briefs, theses, flow alerts | Catalyst and narrative awareness, premise tracking. Flow detectors repeat the scanner's ideas on 6/24 h windows with separate thresholds. |
| Desk (`desk/*`) | 60 s | 1 h / 4 h % moves | LLM agent team, paper broker | Event-driven agent review of paper positions. Reads neither opportunities nor the Lab. |
| Routine (`ROUTINE.md`, `routine/*`) | 4 h | Daily / weekly (HTF view) | `data/marketstate`, `sectors`, `setups`, `lab`, `signals`, one ntfy push | Macro-plus-crypto narrative, HTF view, Lab maintenance. **Setups are proposed from scratch by the LLM, then gated by code.** |

### Observed outcomes

- **The routine setups ledger has never recorded a setup.** `data/setups/ledger.json`
  is empty (0 open, 0 closed). The HTF stance is `range` and every run ends in
  stand-aside. The gate is not too strict. The model proposes nothing because
  it is asked to find setups from scratch in a large prose pack, with nothing
  that enumerates candidates.
- **The signals section has returned 503 on every recent run** (`data/signals/2026-10-20.md`):
  near-miss, novelty and opportunities answer `platform_offline`. `ROUTINE.md`
  defaults `APP_URL` to the Vercel origin. Platform routes there have no worker
  context, and apparently no working DB context either. The scanner's output
  never reaches the routine.
- **Four outcome ledgers that don't talk:** platform `ledger_entries` (forward
  returns), routine `ledger.json` (R on 1 h candles), Lab `livePerf` (daily
  Sharpe), and the desk journal (fills). Each answers "did it work?" for its
  own ideas only.
- **Three regime notions, none shared as a gate:** `classifyRegime` (1 h
  price × OI quadrant), the Lab daily trend (MA50/ROC), and the routine HTF
  view (20W/50W SMA plus hl-cycles). The scanner fires all four setups in any
  regime.

### Data sources and how much they are used

| Source | Feeds a decision? | Notes |
|---|---|---|
| HL `metaAndAssetCtxs`, candles, funding history | **Yes.** Scanner, novelty, flow detectors, desk triggers, HTF features, Lab `ht:*` | The backbone. Daily candles default to 365 days, all timeframes only for BTC, ETH, SOL, HYPE and watched coins. |
| HL `l2Book` | Costs only | Spread/depth enter cost, not selection. |
| HL crawler + WS → liqmap | **No.** | `liqPressure` is computed and listed in `REFS`, but no setup reads it. It is the most expensive collector (HL weight budget) and feeds only the UI. It runs only on the worker. |
| Binance / Bitstamp klines | Yes (history depth) | Extends daily history below HL's listing date. Novelty needs ≥ 365 bars. |
| Coinalyze | Partly | Liquidations and spot/perp volume feed two Intel detectors. Cross-venue OI, funding and buy volume are fetched, then dropped (`intel/windows.ts:69-71`). Limited to ≤ 8 held or watched coins. |
| hl-cycles | Yes (routine) | Triggers the HTF refresh. On-chain BTC levels (STH cost basis, True Market Mean) are the best levels in the system. |
| FRED (API + CSV), Yahoo, F&G, DefiLlama, CoinGecko | LLM context, UI, Lab inputs | Fetched 2–3 times each across collect, Lab and routine. FRED API stores only the latest print. Routine fetches are not persisted. |
| Deribit DVOL | Lab only, and the live series is wrong | `collectors/cryptoContext.ts:66` builds the time window once at module load. A warm process re-reads the same 2 h window forever, so `deribit.btc_dvol` goes flat. |
| Coin Metrics, blockchain.com | Lab only | BTC/ETH by default. |
| Elfa | Display, LLM, Lab | The code itself notes there is no evidence of edge. |
| News / X / governance / docwatch | Intel alerts | Never touches a setup. |

**Summary.** For perp trading the system is strong at *describing* the tape:
positioning, funding crowding, extremes, macro and news context. It also
*scores* the intraday scanner honestly. It is weak at *producing* swing
setups. The daily/weekly path depends on an LLM inventing levels from a prose
pack, and the validated research (Lab) and the structural data (liqmap,
hl-cycles levels, cross-venue flow) never meet a setup definition.

---

## 2. Redesign: code generates candidates, the LLM curates

The scanner has the right pattern: setups as data, deterministic evaluation,
every idea marked to market. Build the same pattern on daily and weekly bars.
Gate it by one shared regime, and turn the LLM from proposer into curator.

```
collect (daily close)
   └─▶ daily features per coin (pure)
          └─▶ regime (pure, one shared)
                 └─▶ eligible families × universe → candidates (pure, setups as data)
                        └─▶ levels, R, costs, base rate (event-study replay)
                               └─▶ gate.ts (unchanged rules) → ranked shortlist
                                      └─▶ LLM: pick ≤ 2, write thesis/steelman, or veto with reason
                                             └─▶ one ledger: every candidate marked, taken or not
```

### 2.1 Cadence (default: daily + weekly)

| Run | When (UTC) | Does |
|---|---|---|
| `daily` | 00:10, after the daily close | Features, regime, candidates on `swing` families (≤ 14 d), ledger settle, brief. **The only run that creates swing setups.** |
| `weekly` | Monday 00:20 | HTF view refresh (deterministic first, LLM thesis on top), `position` families (≤ 45 d), per-family review from the ledger. |
| `pulse` | Every 4 h | Settle open setups, check machine triggers, cancel on a broken premise. **No new setups.** Intraday families are off by default. |

Config: `SETUP_HORIZONS=daily,weekly` (default), `intraday` opt-in. That is
the "conditional" part on time: a 4 h run can only change the status of what
daily/weekly runs created.

### 2.2 Daily features (pure, `routine/features.ts` or extend `htf.ts`)

Per coin in the universe: top 40 by 24 h notional, plus `PLATFORM_MY_MARKETS`.
Data comes from stored `candles` and `funding` (already backfilled), so this
needs no new source.

- **Trend/structure:** close vs 20D/50D/200D SMA and 20W, Lab `TRENDS` state,
  weekly higher-high/higher-low, Donchian 20/55 high/low, distance to each.
- **Volatility:** ATR(14), rv30, ATR percentile over 1 y (compression), and
  the 7d/30d rv ratio.
- **Positioning:** funding 7 d APR, `funding_z90`, OI change over 7 d,
  `oi_from_peak(20)` (both already in `novelty.ts`), premium.
- **Relative strength:** 14 d / 30 d return vs BTC, and the coin's rank
  within its sector (`market_sectors`).
- **Structure from the worker (optional, when present):** the largest
  liquidation cluster above and below mark within 1.5 ATR (liqmap) and its
  coverage.
- **BTC only:** hl-cycles levels with distance in ATR.

Reuse `novelty.ts` feature code and `htf.ts` SMA/vol helpers instead of
writing new ones.

### 2.3 One regime (pure, `routine/regime.ts`)

Inputs: BTC weekly trend (`htf.ts`), hl-cycles `regime.state` plus stress
conditions on, breadth (% of the universe above its 50D SMA), market funding
skew `z30`, and days to the next FOMC/CPI (`intel/calendar.ts`).

Output: one label from `trend_up | range | trend_down | stress`, plus an
`event_window` flag (≤ 2 days to a tier-1 print). A small table maps each
label to its eligible families (2.4). The HTF view's `regime`/`stance` comes
from this function. The LLM may annotate it but no longer sets it.

This becomes the shared regime. The scanner can later read it too, through
an `eligibleIn` field on `SetupSchemaZ`. That change is out of scope here.

### 2.4 Families as data

Same idea as `platform/setups.ts`: a zod schema, compiled once, with a parity
test. Each family declares `when[]` on daily features, `direction`,
`eligible` regimes, `horizon`, and level expressions in the Lab's
`LevelSchema` vocabulary (`{ref: entry|low|high|ma, n, atr}`). Lab
`eventStudy` can then replay the same definition, which is the parity
requirement from `CLAUDE.md`.

| Family | Direction | Eligible | Fires when (sketch) | Entry / invalidation / target |
|---|---|---|---|---|
| `trend_pullback` | with trend | `trend_up`, `trend_down` | Trend state up, close within 1 ATR of the 20D SMA or the last breakout level, funding 7 d APR not in the top decile, OI not at a 20 d peak | Zone at MA ± 0.5 ATR; invalidation below the 10-bar low − 0.25 ATR; targets at the prior high, then 3R |
| `compression_breakout` | either | `trend_*`, `range` | ATR percentile ≤ 20, daily close beyond the Donchian 20 high/low, OI 7 d change > 0, funding neutral | Zone at a retest of the broken level; invalidation back inside the range mid; target at range height projected |
| `range_fade` | against the edge | `range` only | Price at a 55 d range edge (≤ 0.5 ATR), funding crowded toward the edge (`funding_z90` ≥ 1.5 in the move's direction), no breakout close | Zone at the edge; invalidation one ATR outside; target at range mid |
| `crowded_carry_unwind` | against the crowd | any, `counter` alignment, conviction low | `funding_z90` ≥ 2, OI within 5% of its 20 d peak, 3 d return flat (< 0.5 ATR) | Mirrors the scanner's `crowded_long` on daily bars |
| `washout_reclaim` | long | `stress`, `trend_down` (counter) | `oi_from_peak` ≤ −25%, funding negative 3 d, daily close back above the prior day's high | Zone at the reclaim day; invalidation below the washout low |
| `rs_leader` | long | `trend_up` | Top-3 RS vs BTC in a sector with rising `mindshare` and OI build, trend up | As `trend_pullback`, with the sector named in evidence |
| `btc_level` | either | any | BTC daily close reclaims or loses an hl-cycles level (STH cost basis, True Market Mean, ETF cost basis) | Zone at the level; invalidation 1 ATR through it |
| `lab_rule` | rule's | rule's `regime` | A catalogue rule with verdict `robust` fires in `market_pulse` | Levels from the rule's `stop`/`target`, else 1.5/3 ATR |

The last row is the bridge the Lab lacks today. Validated rules become
candidates directly, and their walk-forward and holdout numbers become the
evidence line.

### 2.5 Candidate record and machine-checkable triggers

Each candidate carries:

- the family, coin, direction, horizon and regime label;
- the feature values that fired, so it can be replayed;
- computed levels and R (via `rMultiple`);
- cost at a reference notional (`l2Book`, as the scanner does);
- a **structured trigger**: `{tf: "1d" | "4h", op: "close_above" | "close_below" | "trade_into", level}`.

The structured trigger is the only change to the existing ledger.
`ledger.ts` today treats "zone traded" as triggered and ignores the trigger
text. With `trigger_rule`, `watching → armed` happens on the qualifying
close, and `armed → triggered` on the zone fill. Without it, behaviour stays
as now.

**Evidence** comes from `eventStudy` replaying the family on the universe's
history, with the candidate's own stop/target. It gives n, ISO-week clusters,
mean R and its 95 % interval, and the verdict
(`insufficient | rejected | clear`). The evidence line is facts only (PS4
format): `n 84 · clusters 41 · mean +0.31R [−0.02, +0.64] · edge basis
replay`. A family whose replay verdict is `rejected` emits nothing in this
regime.

### 2.6 Ranking and the gate

Order the shortlist by:

1. regime fit (`with` before `counter`);
2. the lower bound of the replay interval, then cluster count;
3. confluence: independent reads agreeing (positioning, Lab pulse lean,
   liquidation cluster beyond target, sector momentum, hl-cycles);
4. distance to trigger in ATR (closer first).

Then run the existing `gate.ts` unchanged: 2 new per run, 5 open,
R ≥ 2, zone ≤ 4 %, counter needs conviction low. The gate stays the
authority.

### 2.7 The LLM's new job

Input: the regime, the ranked shortlist (≤ 6) with features and evidence,
the open setups, and the context pack (macro, news, sectors).

Output, using `PulseOutputSchema` with one change: `new_setups[]` references
a candidate id plus `thesis`, `steelman` and `conviction`. Levels are copied
from the candidate by code, so the model cannot invent or move them. The
model may:

- pick 0–2 candidates;
- veto a candidate with a reason (an event window, a news catalyst, an Intel
  thesis contradiction);
- cancel open setups on a broken premise.

Stand-aside stays a valid answer. It now carries what *was* available and why
it was passed on, which is better information than "nothing found".

### 2.8 One ledger, every candidate marked

Record **every gate-passing candidate**, taken by the LLM or not, with
`picked: boolean`, and settle all of them with `advanceSetup`. Per family ×
regime, this gives:

- realized hit rate and R from live data (not replay);
- whether LLM curation adds value (picked vs not-picked R);
- replay vs live drift (decay), which mirrors the Lab's `catalogueHealth`.

Store it in Postgres next to `ledger_entries`, with a `kind: "swing"` and the
same clustering (`stats.ts` `groupStats`, cluster = ISO week). Keep
`data/setups/ledger.json` as the committed projection of *picked* setups, so
the app and the brief keep working. After `PLATFORM_EDGE_MIN_N` clusters, the
ranking in 2.6 swaps the replay interval for the live one, exactly as the
scanner does with `edgeBasis`.

### 2.9 Conditional emission (no nagging)

A run pushes only when one of these happens:

- a candidate was picked and passed the gate;
- an open setup changed status (`armed`, `triggered`, `invalidated`,
  `target_hit`, `expired`, `cancelled`);
- the regime label changed;
- a top-ranked candidate was vetoed (one line, with the reason).

Otherwise the run is silent, as in `ROUTINE.md` §6 today.

---

## 3. Data source changes

| Change | Why |
|---|---|
| Point the routine's `APP_URL` at the worker origin (Railway), or give the Vercel routes a DB context | Signals have read 503 for every recent run. Near-miss, novelty and opportunities never reach the brief. |
| Fix DVOL: build the Deribit URL per call | The live series is frozen on warm processes. |
| Use liqmap clusters in features (2.2) | The heaviest collector currently feeds only the UI. Clusters beyond a target or invalidation are real structure for perp levels. |
| Keep Coinalyze cross-venue OI and funding (stop dropping them) | HL funding vs aggregate funding divergence is a cheap daily positioning read, and the calls are already paid for. |
| Store routine-fetched FRED/Yahoo in `observations`, or move them into the collector, and drop the duplicate F&G/DefiLlama fetches | One fetch per source. History builds for the Lab and the regime. |
| Extend daily candle/funding backfill to the candidate universe (top 40 + my markets, ≥ 400 days) | Families and replay need daily history on every coin they scan, not only the four majors. |
| Leave Elfa, Coin Metrics and blockchain.com as Lab inputs | No evidence they belong in a setup until the Lab says so. |

---

## 4. Phasing

Each phase ships with its own runnable checks, per `CLAUDE.md`.

1. **Plumbing.** Fix `APP_URL` (or the Vercel DB context), fix DVOL, and
   extend backfill to the universe. Small, independent PRs.
2. **Features + regime.** `routine/features.ts` and `routine/regime.ts`, both
   pure, with unit tests on fixed candles. The HTF view reads the
   deterministic regime.
3. **Families as data + replay parity.** A schema plus the eight families,
   and a parity test asserting that live evaluation equals `eventStudy`
   replay on the same bars (as `eventStudy.test.ts` does for Lab rules).
4. **Candidates in the routine.** `bun run routine --mode daily|weekly`
   builds the shortlist. Change `PulseOutputSchema` to reference candidate
   ids. Add the structured trigger and the `armed` status to `ledger.ts`.
   Update `ROUTINE.md` §3.6/§4.4 to curate instead of propose.
5. **One ledger.** A Postgres table for all candidates (new migration), and
   picked vs not-picked stats in the brief and `/api/platform/ledger/stats`.
6. **Feedback.** Live-interval ranking after the minimum cluster count. A
   family is flagged (not removed) when live R falls below a quarter of its
   replay R over 30+ clusters, mirroring the Lab's decay rule.

Out of scope: sizing, leverage, order placement, and auto-approval. The desk
and the scanner's intraday opportunities stay as they are. Sharing the regime
with the scanner is a later, separate change.
