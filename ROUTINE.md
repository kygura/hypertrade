# ROUTINE.md — hypertrade scheduled routine

This file is the whole runbook for the **one scheduled routine**, run every 4
hours: a stateless Claude Code cloud session that reads hypertrade's own data
and the public tape, runs the Lab, proposes gated setups, screens the signal
pipeline (near-misses, novelty, ready opportunities, thesis watch, Lab ideas),
writes `data/marketstate/`, `data/sectors/`, `data/setups/`, `data/lab/` and
`data/signals/`, pushes, and sends **one** ntfy push. It needs nothing else to
run end to end.

If you were opened for ordinary development work in this repo, this file is
not your task. Use `docs/SPEC.md`, `docs/design/README.md` and `docs/LAB.md`.
Don't touch `data/**` unless asked.

Order of a run: **preflight (§1) → collect (§2) → market read, setups and Lab
(§3) → signals sections (§3.7) → write outputs (§4) → validate, commit, push
(§5) → one delivery (§6).**

The app makes no LLM calls of its own for this. It reads only the files this
routine commits. The provider-agnostic pipeline (`bun run routine`, background:
`docs/fallback-routine.md`) shares the same setups ledger, gate and HTF view.

**Hard rule, unchanged:** this is market intelligence, not financial advice.
No trade recommendations, no position sizing, no "buy/sell X". Every
forward-looking statement is framed with explicit confidence language — see
the hedge vocabulary. Never state a future market outcome as fact.
Informational only: nothing here gates, approves, rejects or places anything,
and no leverage is mentioned. It applies to every file, the push and the final
message.

**Setups are in scope.** A setup is a conditional plan for a human, not an
order: a checkable trigger, an entry zone, an invalidation level with its
reason, 1–3 targets, and the evidence it rests on. Risk is expressed only in
R multiples, which code computes. No size, no leverage, no execution path.
`src/server/routine/gate.ts` decides what gets recorded; the human decides
what gets traded.

---

## 0. The bar: what a good run looks like

Each run should leave the reader knowing four things: **what changed since
the last run, why it matters, what would prove the read wrong, and what is
worth doing about it**: a gated setup, or a stated reason to stand aside,
plus the levels that would change the read. Restating today's levels with no
context isn't analysis, and a brief with nothing to act on isn't an alert.

Failures seen in past runs. Don't repeat them:

| Failure | Example | Do this instead |
|---|---|---|
| Alerts with nothing to act on | Briefs listed readings and z-scores, no level, no trigger, no plan | Every brief opens with Setups (§6): new, open, status changes, or the stand-aside reason, then the Watch levels. |
| Stale text stacks up | macro `summary` grew three "Update Oct 11 / Update Oct 12" tails on top of old text | Rewrite every `summary`, `rationale` and `thesis` field from scratch each run. Never append. |
| "Could not find" for data that is one curl away | "No yield/oil data found", "Brent unverified" | FRED serves daily series as keyless CSV (§2.4). Brent was $125 on Oct 6 in FRED while the brief called it unverified. |
| z-scores listed, never read | "OI z30 +0.8, funding z30 +0.7, F&G z30 +1.5" | Read them together with the positioning matrix (§3.1). Say what the combination means. |
| Equity/mega-cap data missing, so "dispersion not assessed" | tech domain carried no tickers | Yahoo's chart endpoint is keyless (§2.4). Six tickers, six calls. |
| Last run's calls never checked | Forecasts and rotation triggers vanished each day | Grade the previous run (§3.5) before writing anything new. |

If a source really is down, say which one, give the HTTP code, and put the
date of the newest value you used in the signal label (`"10Y yield (Oct 9)"`).

---

## 1. Preflight (every run, in this order)

1. **Environment.** Provided by the cloud environment: `LAB_API_TOKEN` (read
   bearer), `NTFY_TOPIC` (delivery; optional `NTFY_SERVER`, `NTFY_TOKEN`), and
   optionally `DATABASE_URL` (Lab trial log). `APP_URL` and `LAB_URL` default to
   the production origin below; the environment may override them.
   ```bash
   export APP_URL="${APP_URL:-https://hypertrade-ten.vercel.app}"
   export LAB_URL="${LAB_URL:-$APP_URL}"
   AUTH=(-H "authorization: Bearer $LAB_API_TOKEN")
   ```
   Missing `APP_URL`: say so in one line and stop, no push. Missing
   `LAB_API_TOKEN`: write "LAB_API_TOKEN not set in the environment" in the
   brief, skip §2.1 Lab, §2.2 app reads and the signals collect, and continue
   with the public sources. Missing `NTFY_TOPIC`: do the run, skip §6's push
   and list it as a gap. Never print `LAB_API_TOKEN`, `DATABASE_URL` or
   `NTFY_TOKEN`.
2. **Fresh checkout.** `git checkout master && git pull --ff-only` on
   `kygura/hypertrade`, then `bun install --frozen-lockfile`. Everything below
   reads this checkout. Then run the platform tick, so the near-miss, novelty
   and opportunity reads in §2 are fresh (a failed or skipped tick is a
   one-line gap in the brief, never a stop):
   ```bash
   if [ -n "$DATABASE_URL" ]; then PLATFORM_READY_TTL_MIN=120 bun run platform:tick || echo "platform tick failed"; else echo "platform tick skipped: DATABASE_URL unset"; fi
   ```
3. **Execution date.** `RUN_DATE=$(TZ=Atlantic/Canary date +%F)` and
   `RUN_TS=$(date -u +%FT%TZ)`, captured once at start. Every dated file this
   run writes uses `RUN_DATE`, even if the run crosses midnight. Runs 4 h
   apart share a date; a later run overwrites that date's files.
4. **Previous state.** The session is stateless. These committed files are
   its only memory:
   ```bash
   PREV_LAB=$(ls data/lab/????-??-??.json | sort | tail -1)
   PREV_MS=$(ls data/marketstate/????-??-??.json | sort | grep -v "$RUN_DATE" | tail -1)
   PREV_SEC=$(ls data/sectors/????-??-??.json | sort | grep -v "$RUN_DATE" | tail -1)
   PREV_SIG=$(ls data/signals/????-??-??.json 2>/dev/null | grep -v "$RUN_DATE" | sort | tail -1)
   ```
   - `PREV_LAB` holds `{ generated_at, pulse: {<ruleId>: {firing, asset,
     direction}}, catalogue_ids, hl_cycles: {regime_state, as_of} }`. If it
     is missing or has a `note` field (seed placeholder), there is nothing to
     diff against; treat every reading as new.
   - `PREV_MS` / `PREV_SEC` are the last run's MarketState and Sectors. You
     need them for the scorecard (§3.5) and for deltas.
   - `PREV_SIG` is the last signals snapshot. Empty = first run; everything
     counts as new for the last 24 h.
   - `data/setups/ledger.json` (open and closed setups, 90-day stats) and
     `data/setups/htf.json` (the higher-timeframe view; may not exist yet).
     The fallback pulse also writes these, which is why step 2 pulls first.

---

## 2. Collect

Collect everything first, then analyse. `mkdir -p /tmp/run` and save raw
responses there so you can re-read them without re-fetching.

### 2.1 Lab: search, save, prune, pulse

The Lab searches for simple trading rules, scores them
walk-forward and on a holdout, and catalogues the ones that clear its bar. The
CLI talks to the deployed app (because `LAB_URL` is set), so saves persist in
Postgres across runs. **Never pass `--local`**: that writes to an ephemeral
file that disappears with the container.

**a. Search: BTC and ETH, long and short (4 calls).** These are the
best-covered assets. The engine refuses anything with < 365 days of price.

```bash
M='["cm:CapMVRVCur","cm:NVTAdj","ht:funding","ht:oi","ht:premium","fng:value","llama:stablecoin_cap"]'
for A in BTC ETH; do for D in long short; do
  bun run lab lab_search --json "{\"asset\":\"$A\",\"direction\":\"$D\",\"metrics\":$M,\"trials\":40}" \
    > /tmp/run/search-$A-$D.json
done; done
```

Each returns `{runId, result}`. `result.rules[]` is ranked by walk-forward
objective. Each rule carries `verdict.level` (`robust | candidate | fragile
| weak | fails_holdout`) and `verdict.reasons`. `trialsRun < trials` with a
warning means the 50 s server deadline hit. That is not an error. A metric
warning (e.g. `cm:NVTAdj` 403 from Coin Metrics) is also not an error; report
it once.

**b. Save only `robust`.** The bar is the engine's own: walk-forward Sharpe
> 1, holdout Sharpe > 0 and tested, stability ≥ 0.5, deflated Sharpe ≥ 0.9.

```bash
bun run lab lab_catalogue_save --json '{"rule":<rule>,"name":"<short name, e.g. BTC MVRV washout>","note":"WF <x> / holdout <y> / DSR <z>","runId":"<runId>","origin":"agent"}'
```

- Cap: **2 saves per search, 8 per run.** If a search has more than 2
  robust rules, save the top 2 by walk-forward Sharpe and list the rest as
  "robust, over cap, not saved".
- Never auto-save `candidate` or weaker; those need a human-written
  note. List every `candidate`-or-better rule in the brief with
  the failing number from `verdict.reasons`.

**c. Prune: only `origin: "agent"` rules.**

```bash
bun run lab lab_catalogue_health --json '{}'        > /tmp/run/health.json
bun run lab lab_catalogue_list --json '{"live":false}' > /tmp/run/catalogue.json
```

`health` returns `{decayed, overlaps: [{a, b, jaccard}], gaps, live}`.
Neither `decayed` nor `overlaps` carries `origin`. Join by id against
`catalogue.entries[]`, which does.

| Health flag | Both/all ids `agent` | Any id `user` or `seed` |
|---|---|---|
| `decayed` (≥ 30 live days, live Sharpe < max(0, 0.25 × holdout)) | `lab_catalogue_remove {"id":…}` | Leave it. Report it. |
| `overlaps` (same asset, Jaccard ≥ 0.6) | Remove the one with lower live (else holdout) Sharpe | Remove neither. Report it. |

If catalogue entries don't expose `origin` at all, remove nothing this run
and say "catalogue entries missing `origin`; skipped auto-removal".
`gaps` is informational. A gap on BTC/ETH just means nothing robust has
been found yet.

**d. Pulse: what is firing now.**

```bash
bun run lab lab_market_pulse --json '{}' > /tmp/run/pulse.json
```

Returns `{asOf, assets: [{asset, longActive, longTotal, shortActive,
shortTotal, lean, rules: [{id, name, direction, firing, text}]}], warnings}`.
Compare each `firing` with `PREV_LAB.pulse[id].firing`. An id missing from
`PREV_LAB.pulse` is **new**, not flipped. A rule that is firing, or close to
firing, is setup material (§3.6).

### 2.2 App data (bearer-authenticated, read-only)

**Metrics with 30-day baselines.**

```bash
IDS="hl.total_oi_usd,hl.funding_skew,hl.oi.BTC,hl.oi.ETH,hl.oi.SOL,hl.oi.HYPE,hl.funding.BTC,hl.funding.ETH,hl.funding.SOL,hl.funding.HYPE,fng.value,cg.btc_dominance,cg.total_mcap_usd,llama.stablecoin_cap_usd,deribit.btc_dvol,fred.net_liquidity,fred.spread_2s10s,fred.VIXCLS,fred.DGS10,fred.DGS2,fred.DTWEXBGS,fred.DCOILWTICO,elfa.mentions_24h_total"
curl -sS "${AUTH[@]}" "$APP_URL/api/metrics/summary?ids=$IDS" > /tmp/run/metrics.json
```

Each series present returns `latest, previous, mean30, mean90, z30`. A
missing id means that collector has no key configured (FRED, Elfa). That's
expected; fill those from §2.4 instead. **Flag every `|z30| ≥ 2`**, the
app's own "unusual" threshold. On 401, write "app metrics
unavailable (401)" once and use §2.4 for everything.

**Sectors with live enrichment.**

```bash
curl -sS "${AUTH[@]}" "$APP_URL/api/sectors" > /tmp/run/sectors-live.json
```

This is last run's taxonomy plus live per-token OI/funding and, where Elfa is
configured, `social_share_24h`. Use it as the starting point. The taxonomy
is still your call each run (§4.3).

### 2.3 hl-cycles (keyless BTC regime dashboard)

```bash
curl -sS -m 20 https://hl-cycles.vercel.app/api/health.json  > /tmp/run/hlc-health.json
curl -sS -m 20 https://hl-cycles.vercel.app/api/vector.json  > /tmp/run/hlc.json
```

Use these fields from `vector.json`:

- `regime.state`, `regime.since`, `regime.allocation`, `regime.momentum`,
  `regime.conditions[]` (6 stress conditions; which are `on`).
- `levels[]`: on-chain price levels with `value`, `distancePct`, `status`
  (`holding`/`lost`). These are the levels that matter for BTC: STH cost
  basis, True Market Mean, realized price, Mean MVRV price, SMA200.
- `compass.headline` `{score, band, d7, d30}` and `compass.lenses[]`
  (macro, flows, behaviour, fundamentals, cycle, derivatives, rotation).
- `brief.sentences`, `brief.confirm`, `brief.invalidate`. Quote the
  confirm/invalidate conditions verbatim. Don't round their numbers away.
- `flips[]`: regime changes, with ms timestamps.

`asOf` and `regime.since` are **ms epoch**. Store `as_of` in the lab
snapshot as `YYYY-MM-DD`. If `health.lastRefresh` is > 2 h old, say the
cycle read is stale before using it. If either call fails, write
"hl-cycles unreachable" and move on.

### 2.4 Public sources (keyless, tested reachable)

Use these before `WebSearch`. They return numbers, not articles.

| Need | Call | Notes |
|---|---|---|
| Hyperliquid universe right now | `curl -sS -X POST -H 'content-type: application/json' -d '{"type":"metaAndAssetCtxs"}' https://api.hyperliquid.xyz/info` | `[meta, ctxs]`, zip `meta.universe[i]` with `ctxs[i]`. Gives mark, prevDayPx, OI (in coins, so × mark), funding (hourly). Also the symbol list for `tokens` checks. |
| US yields, curve, VIX, S&P, Nasdaq, oil, dollar | `curl -sS "https://fred.stlouisfed.org/graph/fredgraph.csv?id=<ID>&cosd=<30 days ago>"` | IDs: `DGS10 DGS2 DGS30 T10Y2Y DFF VIXCLS SP500 NASDAQCOM DJIA DCOILBRENTEU DCOILWTICO DTWEXBGS`. Lags 1–3 business days; label the date. `.` = no print that day. |
| Mega-caps, ETFs, indices | `curl -sS -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/<SYM>?range=1mo&interval=1d"` | `AAPL MSFT NVDA GOOGL AMZN META SMH SPY QQQ IWM %5EVIX` (`%5E` = `^`). Read `meta.regularMarketPrice` and `indicators.quote[0].close`. |
| Fear & Greed | `curl -sS "https://api.alternative.me/fng/?limit=31"` | 31 days gives you the trend. |
| Stablecoin supply | `curl -sS https://stablecoins.llama.fi/stablecoincharts/all` | Compare last vs 7 and 30 days back. |

`WebSearch` / `WebFetch` is still required for: economic calendar dates (CPI,
FOMC, NFP), geopolitics (mandatory live search every run, §4.2), earnings
dates, and sector narrative evidence. Prefer sources dated within the last
72 hours. If the best you can find is older, say how old.

### 2.5 Setups context (code-computed, keyless)

```bash
bun run routine --collect-only > /tmp/run/pack.txt
```

Prints the fallback's context pack: HL marks, OI and funding, the HTF
features computed from daily and weekly candles for BTC, ETH, SOL and HYPE
(SMAs, distances, weekly structure), hl-cycles levels, and data gaps. These
are the numbers the gate checks against, and the keys you cite in a setup's
`evidence`. No LLM key is needed for this.

### 2.6 Signals snapshot (one deterministic call)

```bash
mkdir -p data/signals
bun run signals:collect ${PREV_SIG:+--prev "$PREV_SIG"} --out data/signals/$RUN_DATE.json
```

The script writes the file itself (temp file + rename), so a failed run leaves
no partial JSON. If it exits non-zero, `rm -f data/signals/$RUN_DATE.*`, list
the signals sections as a gap and continue with the market read; a broken file
committed now would become next run's `--prev`. It assembles one JSON from the
server's own endpoints (`src/server/routine/signals.ts`; no logic is
duplicated here):

| Key | Source | Meaning |
|---|---|---|
| `nearMiss` | `GET $APP_URL/api/platform/near-miss` | `top` and up to 5 `all`: coin, setup kind, failed condition index, `value` vs `limit`, `relDistance` |
| `novelty` | `GET $APP_URL/api/platform/novelty` | `NOVEL:` entries detected since `since`; `kind` `new_extreme` or `joint_extreme`, `families`, `features`, `nearSetups` |
| `ready` | `GET $APP_URL/api/platform/opportunities?status=ready` + detail | each with its PS4 `evidence` line (n · clusters · interval · edge basis) |
| `thesisWatch` | `GET $APP_URL/api/intel/theses` history | premises whose latest check turned `contradicted`/`triggered` after a good one at the previous run |
| `lab` | Lab trial log (needs `DATABASE_URL`) | `trials` = authored ideas since the last run, each with its `rule` (`lab_event_study` rows are screens, not ideas); `universe` = `PLATFORM_MY_MARKETS`; `trials: null` = log not reachable |
| `changes`, `changed` | diff vs `--prev` | what is new; `changed: false` means nothing new in the signals |

A section that cannot be read does not abort the run: it is listed in
`gaps: [{source, code}]` (e.g. `HTTP 503`), contributes nothing new, and keeps
the previous run's value so it is not mistaken for a change. An unreadable
`--prev` is a gap too (`source: "prev"`); the run then treats everything as
new. Report each gap with its code; don't fill it from memory. If `gaps`
covers every platform section (worker down), say so and count signals as
unchanged.

---

## 3. Analyse

Do this before writing any JSON. Six passes, each producing notes you'll
reuse in the outputs and brief.

### 3.1 Crypto positioning: read price, OI and funding together

For BTC, ETH, SOL, HYPE and the market total, compare 24 h price change, OI
change (vs `previous` or vs `mean30`) and funding:

| Price | OI | Funding | Reading |
|---|---|---|---|
| up | up | rising / positive | New longs, leverage building. Fragile if funding z30 ≥ 2. |
| up | down | falling | Short covering. Rally may lack fresh demand. |
| down | up | falling / negative | New shorts pressing. Squeeze fuel if price stops falling. |
| down | down | any | Deleveraging, long liquidation. Often a washout when F&G drops fast too. |
| flat | up | positive and rising | Crowded carry. Watch for a flush. |

Then answer in one or two sentences: **who is leaning which way, and how
crowded is it?** Use `hl.funding_skew` and the per-asset funding z30 for
"crowded". That sentence goes into the crypto `summary` and is usually the
best `thesis.infer` material.

### 3.2 Cross-asset: is crypto trading on macro or on its own?

- Compare the direction of BTC with 10Y yield, DXY (`DTWEXBGS`), VIX and
  Nasdaq over 1 and 5 sessions. Same sign as risk assets = macro-driven;
  opposite = idiosyncratic. Say which, with the numbers.
- Liquidity read: `fred.net_liquidity` trend (if present), stablecoin supply
  7 d / 30 d change, 2s10s level and change. A steepening driven by the long
  end rising (bear steepener) reads differently from one driven by the
  front end falling. Name which.
- Oil above ~$100 is an inflation input. Tie it to the next CPI date.

### 3.3 Levels and distances

Turn every key level into a distance from the current price: hl-cycles
`levels[]` (already has `distancePct`), the `brief.invalidate` and
`brief.confirm` prices, the HTF view's `biases[].levels`, open setups' entry
zones and invalidations, and the conditions on any Lab rule that is close to
firing. "BTC is 5.7% above the True Market Mean ($79.2K); a daily close below
it is the first slip" is useful to a reader. "BTC is above key levels" is
not. The 2–5 levels nearest to price, with what a cross would mean, become
the brief's **Watch** list (§6).

### 3.4 Confluence and divergence

List the independent reads you have: positioning (3.1), macro (3.2),
hl-cycles regime and Compass, Lab pulse lean, Fear & Greed, sector
rotation. Then state:

- **Where they agree.** Three or more independent sources pointing the same
  way is your `base case` support, and the strongest setup material.
- **Where they disagree.** A disagreement is usually the most useful line in
  the brief. Example: hl-cycles says risk-on, the Macro lens says
  Restrictive, funding is flat. That is a market climbing without leverage
  against a tightening backdrop. Name it.

### 3.5 Scorecard: grade the previous run

Read `PREV_MS.thesis.forecast`, `PREV_MS.risks[]` and `PREV_SEC.rotations[]`.
For each checkable item, mark it **hit**, **missed**, **pending** (not yet
resolvable) or **uncheckable**, with the number that decides it. Examples:

- risk "Daily BTC close below ~$81.6K" → BTC closed at $83.9K: not triggered.
- rotation `memecoins → perp-dex-defi`, trigger "HL OI rises while PUMP OI
  falls" → total OI +2.1%, PUMP OI −6%: trigger met.

Setups don't need grading here: their status (triggered, invalidated,
target hit, expired) is settled by code against prices when §4.4 runs, and
the ledger's 90-day stats are the track record.

Put the scorecard in the brief (§6) and let it shape this run. A rotation
whose trigger failed twice should be dropped or rewritten, not carried
forward. Write this run's `trigger`s and `risks` so the next run can grade
them: a named metric, a threshold and a direction.

### 3.6 Setups: turn the read into plans

Start from the HTF view (`data/setups/htf.json`). It is **due for a
refresh** when the file is missing, its `valid_until` has passed, or its
`hl_cycles_state` differs from today's hl-cycles `regime.state`. When due,
write a new one (§4.4) before proposing anything: regime, stance, a 3–6
sentence thesis citing the weekly features and hl-cycles, per-major biases
with levels from §2.5, and `what_changes_it` as checkable conditions.
Stance `stand_aside` blocks every new setup until the next refresh.

Then look for setups where §3.1–3.4 line up. Good sources: a Lab rule firing
or one condition away from firing, positioning extremes (crowded funding
into a level, new shorts pressing into support), a reclaim or loss of an
hl-cycles level, a confluence of three or more reads. For each candidate:

- **Trigger**: what a human would see before acting ("4h close back above
  $82,000 after a sweep of $80,500"), not "if bullish".
- **Entry zone** at a level from §3.3, **invalidation** at the level whose
  loss breaks the thesis (and say why), **targets** at the next levels.
- **Steelman the other side** in one clause of the `thesis`: what the
  opposite trade sees.
- **Cancel** an open setup when its thesis broke before price did (a
  premise changed: regime flip, funding reset, catalyst passed). Say what
  broke. Status changes driven by price are code's job, not yours.

"Nothing worth doing" is a valid, common answer: give a concrete
`stand_aside_reason` ("BTC mid-range between STH cost basis $78.4K and True
Market Mean $83.1K; no level within 2%"). Never propose a setup to look
busy.

**The gate** (`gate.ts`, the authority if this list drifts) drops a proposal
that breaks any of these. Do the arithmetic before you propose:

- asset is in the live HL universe; mark not already beyond invalidation;
- long: invalidation < entry.low ≤ entry.high < targets ascending (short
  mirrored);
- entry zone ≤ 4% of its midpoint; invalidation 1–25% from the entry
  midpoint; reward to the first target ≥ 2R from the entry midpoint;
- `expires_at` ≤ 14 days out (`swing`) or ≤ 45 days (`position`);
- at most 2 new per run, 5 open in total, one open per asset and
  direction;
- `regime_alignment: "counter"` (fights the HTF view) only with
  `conviction: "low"`, and at most one counter setup open.

### 3.7 Signals: screen Lab ideas, read the delta

Signals are facts about thresholds and evidence, not predictions. For each
`lab.trials[]` entry that carries a `rule`, screen that rule on my markets
(needs `LAB_URL=$APP_URL`; never `--local`):

```bash
bun run lab lab_event_study --json '{"rule":<trial.rule>,"mine":true,"stopAtr":1.5,"targetAtr":3}'
```

Report `verdict` (`insufficient`/`rejected`/`clear`, a reject-only screen:
`clear` is never evidence of an edge) and the funnel bottleneck
(`funnel.steps[funnel.bottleneck]`: the condition where most coin-days die).
Older trials (logged before the rule was stored) have no `rule`: list them as
"not screenable (no rule logged)" with their logged verdict. Each screen
appends one `lab_event_study` row to the Lab trial log; those rows are excluded
from next run's idea list on purpose.

Then read the snapshot against the market read: a near-miss or ready item on a
coin that sits at a §3.3 level, or a novelty on a coin with an open setup, is
worth a clause in the market brief. Carry evidence lines and screen verdicts
verbatim; they already say `unvalidated` / `rejected` / `clear` honestly. Do
not upgrade them.

---

## 4. Write the outputs

### 4.1 MarketState and Sectors: shape

These are the real zod schemas (`src/shared/schemas.ts` is the source of
truth if this copy drifts). The API routes parse committed files against
them, so a drift breaks the app at request time, not at commit time. Both
use zod's default non-strict parsing: extra keys are stripped silently, so
never rely on one for anything the app reads.

`data/marketstate/latest.json`: `MarketStateDataSchema`

```
{
  generated_at: string                 // ISO timestamp, RUN_TS
  headline:     string                 // the single most important change since last run, with its number
  tldr:         string                 // regime → main change → main disagreement → next dated catalyst → short disclaimer; < ~90 words
  domains: [{
    domain:  string                    // "macro" | "equities" | "crypto" | "tech" | "geopolitics"
    summary: string                    // (1) what moved and by how much, (2) what it means, (3) what would change the read
    signals: [{ label: string, value: string, direction: string }]  // direction: "up"|"down"|"flat"
  }]
  thesis: {
    observe:    string                 // facts only, drawn from domains[]
    infer:      string                 // §3.1 positioning read + §3.4 disagreement
    forecast:   string                 // labelled base case + ≥ 1 low-confidence tail case, each with its confirm/break level
    disclaimer: string                 // fixed line, verbatim, §4.2
  }
  risks: [string]                      // 2–4 checkable conditions: metric + threshold + direction
}
```

`data/sectors/latest.json`: `SectorsDataSchema`

```
{
  generated_at: string
  sectors: [{
    id:              string            // kebab-case, your own choice each run
    label:           string
    mindshare_score: number            // 0..1 (zod-enforced)
    momentum:        number            // -1..1 (zod-enforced)
    rationale:       string            // the measured numbers that moved the score
    tokens:          [string]          // Hyperliquid symbols, only where listed (§4.3)
    sources:         [string]          // what grounded this read
  }]
  rotations: [{
    from:       string                 // a sector id above
    to:         string                 // a sector id above
    confidence: number                 // 0..1 by convention (not enforced), mostly well under 0.7
    trigger:    string                 // checkable next run: named metric, threshold, direction
    note:       string                 // hedge-language color
  }]
}
```

Rules on top of the shape:

- Rewrite every `summary`, `rationale` and `thesis` field from scratch.
  Data older than today names its date.
- `signals[].value`: plain number for index/stock points (`"559.30"`), `$`
  for crypto/commodities (`"$68,400"`), thousands separators at ≥ 10,000,
  signed `%`/`bp` for changes (`"+2.1%"`, `"+6bp"`), the window when not
  obvious (`"+2.1% 24h"`). Put the comparison in the value or label where it
  fits (`"$12.4B (z30 +0.8)"`, `"5.24% (Oct 9)"`).
- `risks[]`: a data-quality caveat is not a market risk. Put it in the
  relevant `summary`.

Files:
- `data/marketstate/latest.json` + `data/marketstate/$RUN_DATE.json`
- `data/sectors/latest.json` + `data/sectors/$RUN_DATE.json`

`latest.json` and the dated file always match. A second run on the same
date overwrites both.

### 4.2 Domain playbook and hedge vocabulary

Five domains, fixed set and order: **macro → equities → crypto → tech →
geopolitics.**

**macro**: Treasury yields (10Y, 2Y, 2s10s), Fed funds, CPI YoY vs prior,
unemployment, NFP, dollar direction (`DTWEXBGS`), WTI/Brent, gold.
Traditional markets only; Hyperliquid belongs to crypto. The bias
(hawkish/dovish/neutral) comes from rates and inflation taken together.
`summary` ends with one liquidity call (easing/tightening/neutral)
grounded in `signals`.

**equities**: market open or closed first (if closed, "as of last close").
SPY, QQQ, DIA, IWM, VIX level and direction. Put/call if findable (a
VIX-only regime read is fine; say so). Breadth and sector tilt. Earnings on
deck.

**crypto**: BTC, ETH, SOL spot (24 h and 7 d). HL total OI and funding
skew with their z30 (§2.2). ETH/BTC relative strength and which of the three
leads. Fear & Greed, BTC DVOL, stablecoin supply as a dry-powder proxy. The
§3.1 positioning read and the §3.2 macro-or-own read.

**tech**: AAPL, MSFT, NVDA, GOOGL, AMZN, META **individually**. Dispersion
is the point; never average them. SMH and whether semis breadth is wide or
concentrated (commonly NVDA). 2–3 AI-cycle, product or regulatory beats.
Earnings on deck among the six.

**geopolitics**: scheduled catalysts (central bank meetings, key prints,
elections, OPEC+) with dates, from `WebSearch`. Active tensions (conflicts,
sanctions, tariffs) are a **mandatory live web search every run, never
skipped, never served from memory**. One line per item on what it means for
the tape.

### Hedge vocabulary (carried over verbatim — do not invent substitutes)

Use these terms, exactly, in the `thesis` block:
`base case`, `tail case`, `low-confidence`, `we lean`, `risk skews`,
`consensus is pricing … / we read …`.

- **`thesis.observe`**: facts only. No interpretation.
- **`thesis.infer`**: how markets are pricing the known catalysts, and where
  this read diverges from consensus. Keep it visibly separate from
  `observe`.
- **`thesis.forecast`**: a labelled **base case** and at least one labelled
  **low-confidence tail case**, each with the level or event that would
  confirm or break it (§3.3). Where the read differs from consensus, say so:
  `consensus is pricing X; we read the risk as Y`. A probability may be
  hedged qualitatively ("a bit above even odds") but **never** given as a
  false-precision point estimate ("73%"). Every forward-looking clause
  carries a hedge word — no bare future-tense assertion of a market outcome.
- **`thesis.disclaimer`**: this exact string, every run:
  `"Not financial advice. Market intelligence only — a reasoned read of public data, not a recommendation to buy or sell anything."`

The same vocabulary applies to setup theses, rotation notes and the brief.

### 4.3 Sector rules

**Goal: show where mindshare and liquidity are rotating before price
follows**. The taxonomy is emergent: decide each run
which narratives actually hold attention (CT trending, CoinGecko/DefiLlama
trending, crypto news, the live OI/funding/social numbers from §2.2). A
sector can vanish or appear between runs.

- `mindshare_score` is a within-run ranking, not a cross-run number.
  `momentum` is building (+) or fading (−).
- `rationale` cites the measured numbers (OI, funding, 24 h change, social
  share) that moved the score. Not a restatement of the score.
- `tokens`: **Hyperliquid symbols only, only where listed.** Check every
  symbol against the live universe (§2.4). The app enriches sectors by
  case-sensitive match (`src/server/routes/sectors.ts`) and silently skips a
  miss, and the social join matches on the same symbols. Get them right.
- `sources`: compact method names (`"defillama TVL deltas"`,
  `"coingecko trending"`), not URLs.
- **Measured attention sits next to your score.** `/api/sectors` adds
  `social_share_24h` where Elfa is configured (`SOC` beside your `MS` in the
  grid). Keep `mindshare_score` your own judgment. Where the two differ by
  more than ~0.2, say so in the rationale and the brief. That gap is the
  information.
- `rotations[]`: `from`/`to` are ids above, `trigger` is checkable next run,
  `confidence` stays honest (most well under 0.7).

### 4.4 Setups: through the gate, never by hand

Never edit `data/setups/*.json` directly. Write your proposals to a file and
let the fallback pipeline settle open setups, apply cancels and the HTF
refresh, gate the proposals and rewrite the ledger:

```bash
bun run routine --mode pulse --input /tmp/run/setups.json --dry-run   # read the gate's verdicts
bun run routine --mode pulse --input /tmp/run/setups.json             # write data/setups/
```

The input is the pulse output shape (`PulseOutputSchema` in
`src/server/routine/schema.ts`):

```json
{
  "regime_read": "One or two sentences: where we stand.",
  "htf_view": null,
  "new_setups": [{
    "asset": "BTC", "direction": "long", "horizon": "swing",
    "thesis": "Why, with numbers, plus one clause steelmanning the short.",
    "regime_alignment": "with",
    "trigger": "4h close back above $82,000 after a sweep of $80,500",
    "entry": { "low": 81000, "high": 82200 },
    "invalidation": 79100,
    "invalidation_reason": "Daily close below the True Market Mean",
    "targets": [87000, 90500],
    "conviction": "medium",
    "evidence": ["hl-cycles.levels.true_market_mean", "hl.BTC.funding"],
    "expires_at": "<ISO UTC, within 14 days for swing>"
  }],
  "cancel": [{ "id": "<open setup id>", "reason": "What broke before price did" }],
  "stand_aside_reason": null,
  "brief": "Short delta-first text."
}
```

- `htf_view` is required when the view is due (§3.6), otherwise `null`. Its
  shape is `HtfViewDraftSchema`: `regime` (`risk_on|neutral|risk_off`),
  `stance` (`trend_long|range|trend_short|stand_aside`), `thesis`,
  `biases[]` (`{asset, bias, levels: [{label, price}], note}`, max 4),
  `what_changes_it[]` (1–5).
- `stand_aside_reason` is required when `new_setups` is empty.
- An input that fails the schema exits 1 and names the field. Fix and
  re-run. Gate drops are listed with their rule; fix the levels and re-run,
  or report the drop in the brief.
- The real run prints the brief block for setups: status changes, cancels,
  new setups with ids and computed R, gate drops, 90-day stats. Use it in
  §6. Code owns ids, status, R and timestamps.

### 4.5 Lab snapshot: `data/lab/$RUN_DATE.json`

The next run diffs against this file. If it's wrong, the next run's deltas
are wrong.

```json
{
  "generated_at": "<RUN_TS>",
  "pulse": { "<ruleId>": { "firing": true, "asset": "BTC", "direction": "long" } },
  "catalogue_ids": ["<every id from this run's lab_catalogue_list, after removals>"],
  "hl_cycles": { "regime_state": "<regime.state or null>", "as_of": "<YYYY-MM-DD or null>" }
}
```

One file per date. A second run on the same date overwrites it. Never
overwrite an earlier date. No `latest.json` for the lab. If the Lab was
skipped (no token), copy `pulse` and `catalogue_ids` from `PREV_LAB` and
add `"note": "lab skipped: LAB_API_TOKEN not set"`.

### 4.6 History indexes

Vercel's function bundler ships only files reachable by static `import`, so
a dated JSON file with no import is invisible to the deployed app. On a new
date, add one import line and one array entry to `data/marketstate/index.ts`
(`MARKETSTATE_HISTORY`) and `data/sectors/index.ts` (`SECTORS_HISTORY`),
following the existing lines:

```ts
import d20261019 from "./2026-10-19.json" with { type: "json" };
// …
  { date: "2026-10-19", data: d20261019 },
```

A second run on the same date already has its entry. Don't duplicate it.

### 4.7 Signals report: `data/signals/$RUN_DATE.md`

`data/signals/$RUN_DATE.json` was written by §2.6; leave it as is. Rewrite the
`.md` from scratch each run; never append. Sections appear only when they have
content, in this order. Every line: item, numbers, hedge word, source.

```
# Signals · <RUN_DATE> · since <since>

## What changed since last run
<one to three lines from `changes`: new near-miss leader, new novelty, ready added/removed, premises broken, new ideas. "Nothing changed." if changed=false>

## Near-miss
Top: <COIN> <setup> — condition <cond> failed: <value> vs limit <limit> (<relDistance×100>% away). Others: <up to 4, one clause each>.
(A near-miss is a fact about thresholds, not a prediction that the setup will fire.)

## Novelty
- <COIN> <new extreme | joint extreme> <families> — <feature id>: <value> vs history <histMin>…<histMax> (pctRank <r>); near setups: <…>; market-wide: <yes/no>

## Ready opportunities
- <COIN> <dir> <setupKind> · score <s> · <evidence line verbatim>

## Thesis watch
- <thesis text, shortened>: premise "<text>" stopped holding (supported → contradicted/triggered)

## Lab (my markets: <universe>)
- idea #<n> "<intent>" — logged verdict <v>; screen <verdict>; funnel bottleneck: <condition> (<survivors before → after>)

Data gaps: <gaps[] as source — code>, or omit
```

---

## 5. Validate, commit, push

1. Schema gate:
   ```bash
   bun -e "
   import { MarketStateDataSchema, SectorsDataSchema } from './src/shared/schemas.ts';
   import { LedgerSchema } from './src/server/routine/schema.ts';
   import ms from './data/marketstate/latest.json';
   import sec from './data/sectors/latest.json';
   import ledger from './data/setups/ledger.json';
   MarketStateDataSchema.parse(ms); SectorsDataSchema.parse(sec); LedgerSchema.parse(ledger);
   JSON.parse(require('fs').readFileSync('data/lab/$RUN_DATE.json','utf8'));
   console.log('ok');"
   ```
   Also check that `latest.json` and `$RUN_DATE.json` match byte for byte in
   both directories (`cmp`). Fix and re-run until clean. The error names the
   field and the expected type.
   The signals JSON must parse and the `.md` must exist.
2. `bun run typecheck && bun test ./src`.
3. Stage only `data/marketstate/ data/sectors/ data/setups/ data/lab/ data/signals/`.
   Commit: `feat(routine): marketstate + sectors + setups + lab + signals $RUN_DATE`.
   Conventional commits; no co-author or AI attribution lines.
4. Green → `git push origin master`. Red → push to `routine/$RUN_DATE`
   and name the failing check in the brief. Master must never go red from a
   data commit. If the push fails on the network, retry once; keep the local
   commit either way. If it is rejected as non-fast-forward (the fallback
   pulse pushed a ledger meanwhile), `git pull --rebase` and push again.
   If the session may only push to its own branch (a `claude-code/*` branch
   rather than `master`), push the commit there and open a PR into `master`
   with `mcp__github__create_pull_request`. The `routine-land` workflow merges
   it after typecheck and tests when it only touches `data/`, and the merge
   deploys to production. Do not call `mcp__github__enable_pr_auto_merge` and
   never merge it yourself. Put the PR link in the brief.
   A red check on a signals-only change follows the same rule.
5. Anything else on GitHub (PRs, check status) goes through the
   `mcp__github__*` tools. `gh` is blocked here.

---

## 6. Delivery: one brief, one push

The final chat message and the ntfy push carry the same brief, written once.
Action first, then deltas. Every line names the item, the evidence (numbers),
a hedge word, what would invalidate it, and the source. Sections appear only
when they have content, in this order, except **Setups**, which always
appears:

```
hypertrade · <RUN_DATE> · regime <state> (<since N days>) · HTF <regime>/<stance> · <commit sha or branch>

Read: <one or two sentences: the main change and the main disagreement (§3.4)>

Setups (conditional plans, not orders)
- NEW <id> <ASSET> <dir> <horizon> · trigger: <…> · entry <lo>–<hi> · invalidation <x> (<reason>) · targets <t1>/<t2> · <R>R · <conviction>
- <id> → triggered|invalidated|target_hit|expired (<r>R) — <note>
- Cancelled <id> — <what broke>
- Open <id> <ASSET> <dir> — mark <m>, <x>% from entry zone / invalidation
- Dropped by the gate: <ASSET> <dir> — <rule>
- Stand aside: <concrete reason>          (when no new setup)
- 90d: <closed> closed, hit rate <h>, avg <r>R

Watch
- <ASSET> <price> (<level name>, <±x>% away) — <what a cross means; which setup it arms or kills>

Scorecard (last run)
- <call> → hit|missed|pending — <deciding number>

Lab
- NEW robust: <name> <asset> <dir> — WF <x>, holdout <y>, DSR <z>, id <id>
- Found, not saved: <name> — <level>: <failing reason>
- Removed (agent): <name> — decayed, live Sharpe <x> vs holdout <y>
- Flagged, left alone (user/seed): <name> — <why>
- Flip: <name> now firing|stopped — <rule text>

Unusual (|z30| ≥ 2)
- <series> <value> (z30 <z>, mean30 <m>) — <what it means in one clause>

Positioning
- <asset>: <price/OI/funding pattern from §3.1> — <reading>

Sectors
- <sector>: MS <x> vs SOC <y> — <which one you trust and why>

hl-cycles
- regime <old> → <new> | new flip | levels lost/reclaimed — confirm: "<…>", invalidate: "<…>"

Signals (since <since>)
- Near-miss: <COIN setup: cond failed by X%>
- Novel: <COIN kind>
- Ready: <added/removed, evidence line>
- Premises broken: <…>
- Lab ideas: <#n, screen verdict>

Data gaps: <source — HTTP code / staleness>, or omit
```

Don't restate unchanged readings. If nothing changed and no setup is open,
send the header, the stand-aside line and the Watch list.

### The push (ntfy, through the desk notifier)

Only `NTFY_TOPIC` (plus optional `NTFY_SERVER`, `NTFY_TOKEN`) must be set. Send
**exactly one** push per run, after the commit succeeds, **only if** the
market read or the signals changed:

- a new setup passed the gate;
- an open setup changed status or was cancelled;
- a new `robust` rule was saved;
- a catalogue rule's `firing` flipped;
- an `origin: "agent"` rule was removed;
- any metric reached `|z30| ≥ 2`;
- hl-cycles `regime.state` changed, or the HTF view was refreshed;
- a previous-run risk from the scorecard was **hit**;
- signals `changed: true` (new near-miss leader, `NOVEL:` entry, ready added
  or removed, broken premise, new Lab idea).

None of these → **silent run**: commit the files, send nothing.

```bash
bun run signals:notify "hypertrade $RUN_DATE" "<≤ 8 short lines>"
```

Body: the header line, `Read:`, the Setups lines, then one line per signals
change (top near-miss, each new `NOVEL:`, ready added with its evidence line,
broken premises, new Lab ideas with screen verdict). Hedged, facts first, no
instructions. No retries (the notifier itself retries a 429 once). If
`signals:notify` exits 1 (no channel accepted the push), send the same brief
once through the session's own push-notification tool, if one is available, and
list the ntfy failure as a gap in the final message. Still exactly one
delivered push per run. Setting `NTFY_TOKEN` (an ntfy.sh access token) moves
the rate limit from the shared IP to the account. No reminders, no follow-ups.

### Final message

The brief above, followed by one line: commit sha or branch, whether a push
went out, data gaps.

---

## Hard rules

- The hard rule at the top applies everywhere: files, brief, push, final
  message. A setup is a conditional plan with a trigger and an invalidation,
  gated by code. Never write it as an instruction to buy or sell, never size
  it, never mention leverage or execution.
- Write only inside `data/**` (`marketstate`, `sectors`, `setups`, `lab`,
  `signals`). Never edit `src/`, `api/`, `db/` or docs as part of a routine run.
- `data/setups/` changes only through `bun run routine --input` (§4.4).
- Remove catalogue rules only when `origin` is `"agent"`.
- No orders, no signing keys, no Desk calls (`src/server/desk/*` is out of
  scope). App reads are GETs; `lab_event_study` and `lab_catalogue_*` write to
  the Lab, as described above.
- Never print or log `LAB_API_TOKEN`, `DATABASE_URL` or `NTFY_TOKEN`.
- When a source degrades mid-run, say so in the brief and in the affected
  `summary`. Don't fill gaps from memory.
- If a tool or hook blocks something this runbook needs, stop and report the
  block. Don't route around it.

## Repository map (background only; nothing here is needed to run)

- `src/shared/schemas.ts`: MarketState and Sectors schemas (source of truth).
- `src/server/routine/`: the setups pipeline (`gate.ts`, `ledger.ts`,
  `schema.ts`, `run.ts`) shared with the fallback, and `signals.ts` (signals
  snapshot assembly; I/O in `scripts/signals.ts`).
- `data/marketstate/`, `data/sectors/`: `latest.json`, dated copies,
  `index.ts`. `data/setups/`: `ledger.json`, `htf.json`. `data/lab/`: dated
  snapshots. `data/signals/`: dated `.json` + `.md`.
- Background reading: `docs/SPEC.md` (app contract), `docs/LAB.md`,
  `docs/fallback-routine.md`.
