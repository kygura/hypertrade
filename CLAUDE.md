# CLAUDE.md — hypertrade market-intelligence routine

This file is the runbook for the **scheduled routine**: a stateless cloud
session that reads hypertrade's own data, runs the Lab, writes
`data/marketstate/`, `data/sectors/` and `data/lab/`, pushes to `master`, and
sends a short delta brief.

If you were opened for ordinary development work in this repo, this file is
not your task. Use `SPEC.md`, `DESIGN.md` and `LAB.md`. Don't touch `data/**`
unless asked.

## How this file relates to ROUTINE.md

- `ROUTINE.md` still owns the **output contract**: the JSON schemas (§c), the
  five-domain playbook (§d), the hedge vocabulary and fixed disclaimer (§d),
  the sector rules (§e) and the zod validation command (§f). Read it in full
  once per run and follow those parts exactly.
- Where the two disagree, **this file wins**. ROUTINE.md predates the app's
  read API, so these parts of it are out of date:
  - §(a) "no database access, no rolling baselines, no z-scores". The routine
    now reads the app's 30-day baselines through `LAB_API_TOKEN` (§2 below).
  - §(b) step 3 "dated file = UTC date". Use the execution date from step 0.
  - §(b) step 6 commit message. Use the one in §5 below.

---

## 0. The bar: what a good run looks like

Each run should leave the reader knowing three things: **what changed since
the last run, why it matters, and what would prove the read wrong.** Restating
today's levels with no context isn't analysis.

Failures seen in past runs. Don't repeat them:

| Failure | Example (Oct 11–12 runs) | Do this instead |
|---|---|---|
| Stale text stacks up | macro `summary` grew three "Update Oct 11 / Update Oct 12" tails on top of old text | Rewrite every `summary`, `rationale` and `thesis` field from scratch each run. Never append. |
| "Could not find" for data that is one curl away | "No yield/oil data found", "Brent unverified" | FRED serves daily series as keyless CSV (§2.4). Brent was $125 on Oct 6 in FRED while the brief called it unverified. |
| z-scores listed, never read | "OI z30 +0.8, funding z30 +0.7, F&G z30 +1.5" | Read them together with the positioning matrix (§3.1). Say what the combination means. |
| Equity/mega-cap data missing, so "dispersion not assessed" | tech domain carried no tickers | Yahoo's chart endpoint is keyless (§2.4). Six tickers, six calls. |
| Last run's calls never checked | Forecasts and rotation triggers vanished each day | Grade the previous run (§3.5) before writing anything new. |

If a source really is down, say which one, give the HTTP code, and put the
date of the newest value you used in the signal label (`"10Y yield (Oct 9)"`).

---

## 1. Setup (every run, in this order)

1. **Fresh checkout.** `git checkout master && git pull --ff-only` on
   `kygura/hypertrade`. Everything below reads this checkout.
2. **Execution date.** `RUN_DATE=$(TZ=Atlantic/Canary date +%F)` and
   `RUN_TS=$(date -u +%FT%TZ)`, captured once at start. Every dated file
   this run writes uses `RUN_DATE`, even if the run crosses midnight.
3. **Previous state.** The session is stateless. These committed files are
   its only memory:
   ```bash
   PREV_LAB=$(ls data/lab/????-??-??.json | sort | tail -1)
   PREV_MS=$(ls data/marketstate/????-??-??.json | sort | grep -v "$RUN_DATE" | tail -1)
   PREV_SEC=$(ls data/sectors/????-??-??.json | sort | grep -v "$RUN_DATE" | tail -1)
   ```
   - `PREV_LAB` holds `{ generated_at, pulse: {<ruleId>: {firing, asset,
     direction}}, catalogue_ids, hl_cycles: {regime_state, as_of} }`. If it
     is missing or has a `note` field (seed placeholder), there is nothing to
     diff against; treat every reading as new.
   - `PREV_MS` / `PREV_SEC` are the last run's MarketState and Sectors. You
     need them for the scorecard (§3.5) and for deltas.
4. **Environment.**
   ```bash
   export APP_URL="https://hypertrade-ten.vercel.app"
   export LAB_URL="$APP_URL"
   AUTH=(-H "authorization: Bearer $LAB_API_TOKEN")
   ```
   If `LAB_API_TOKEN` is unset, write "LAB_API_TOKEN not set in the
   environment" in the brief, skip §2.1 Lab and §2.2 app reads, and continue
   with the public sources. Never print the token.

---

## 2. Collect

Collect everything first, then analyse. `mkdir -p /tmp/run` and save raw
responses there so you can re-read them without re-fetching.

### 2.1 Lab: search, save, prune, pulse

The Lab (`LAB.md`) searches for simple trading rules, scores them
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
- Never auto-save `candidate` or weaker. LAB.md requires a human-written
  note for those. List every `candidate`-or-better rule in the brief with
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
`PREV_LAB.pulse` is **new**, not flipped.

### 2.2 App data (bearer-authenticated, read-only)

**Metrics with 30-day baselines.**

```bash
IDS="hl.total_oi_usd,hl.funding_skew,hl.oi.BTC,hl.oi.ETH,hl.oi.SOL,hl.oi.HYPE,hl.funding.BTC,hl.funding.ETH,hl.funding.SOL,hl.funding.HYPE,fng.value,cg.btc_dominance,cg.total_mcap_usd,llama.stablecoin_cap_usd,deribit.btc_dvol,fred.net_liquidity,fred.spread_2s10s,fred.VIXCLS,fred.DGS10,fred.DGS2,fred.DTWEXBGS,fred.DCOILWTICO,elfa.mentions_24h_total"
curl -sS "${AUTH[@]}" "$APP_URL/api/metrics/summary?ids=$IDS" > /tmp/run/metrics.json
```

Each series present returns `latest, previous, mean30, mean90, z30`. A
missing id means that collector has no key configured (FRED, Elfa). That's
expected; fill those from §2.4 instead. **Flag every `|z30| ≥ 2`**, the
app's own "unusual" threshold (DESIGN.md §10.2). On 401, write "app metrics
unavailable (401)" once and use §2.4 for everything.

**Sectors with live enrichment.**

```bash
curl -sS "${AUTH[@]}" "$APP_URL/api/sectors" > /tmp/run/sectors-live.json
```

This is last run's taxonomy plus live per-token OI/funding and, where Elfa is
configured, `social_share_24h`. Use it as the starting point. The taxonomy
is still your call each run (ROUTINE.md §e).

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
FOMC, NFP), geopolitics (mandatory live search every run per ROUTINE.md §d),
earnings dates, and sector narrative evidence. Prefer sources dated within
the last 72 hours. If the best you can find is older, say how old.

---

## 3. Analyse

Do this before writing any JSON. Five passes, each producing notes you'll
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
`brief.confirm` prices, and the conditions on any Lab rule that is close to
firing. "BTC is 5.7% above the True Market Mean ($79.2K); a daily close below
it is the first slip" is useful to a reader. "BTC is above key levels" is
not.

### 3.4 Confluence and divergence

List the independent reads you have: positioning (3.1), macro (3.2),
hl-cycles regime and Compass, Lab pulse lean, Fear & Greed, sector
rotation. Then state:

- **Where they agree.** Three or more independent sources pointing the same
  way is your `base case` support.
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

Put the scorecard in the brief (§6) and let it shape this run. A rotation
whose trigger failed twice should be dropped or rewritten, not carried
forward. Write this run's `trigger`s and `risks` so the next run can grade
them: a named metric, a threshold and a direction.

---

## 4. Write the outputs

### 4.1 MarketState and Sectors

Follow ROUTINE.md §(c)–(e) for shape and vocabulary. On top of that:

- **`headline`**: the single most important change since last run, with
  its number. Not a list of readings.
- **`tldr`**: regime → the main change → the main disagreement (§3.4) →
  the next dated catalyst → short disclaimer. Under ~90 words.
- **Each `domains[].summary`**: (1) what moved and by how much, (2) what it
  means, from §3, (3) what would change the read. Written fresh. Data older
  than today names its date.
- **`signals[]`**: put the comparison in the value or label where it fits
  (`"$12.4B (z30 +0.8)"`, `"5.24% (Oct 9)"`). `direction` stays
  `up|down|flat`.
- **`thesis.observe`**: facts only. **`infer`**: the §3.1 positioning read
  plus the §3.4 disagreement. **`forecast`**: `base case` + at least one
  `tail case`, each with the level or event that would confirm or break it
  (§3.3). No point-estimate probabilities.
- **`risks[]`**: 2–4 items, each a checkable condition (metric +
  threshold), not a theme. A data-quality caveat is not a market risk.
  Put it in the relevant `summary`.
- **Sectors**: `rationale` cites the measured numbers (OI, funding, 24 h
  change, social share) that moved the score. Where your `mindshare_score`
  and the live `social_share_24h` disagree by more than ~0.2, say so in the
  rationale and the brief. ROUTINE.md §e: "that gap is the information."
  Check every symbol in `tokens` against the live HL universe from §2.4.

Files:
- `data/marketstate/latest.json` + `data/marketstate/$RUN_DATE.json`
- `data/sectors/latest.json` + `data/sectors/$RUN_DATE.json`
- On a new date, add the import line and array entry to
  `data/marketstate/index.ts` and `data/sectors/index.ts` (ROUTINE.md §b
  step 4). Don't duplicate an existing date.

### 4.2 Lab snapshot: `data/lab/$RUN_DATE.json`

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

---

## 5. Validate, commit, push

1. Schema gate (ROUTINE.md §f):
   ```bash
   bun -e "
   import { MarketStateDataSchema, SectorsDataSchema } from './src/shared/schemas.ts';
   import ms from './data/marketstate/latest.json';
   import sec from './data/sectors/latest.json';
   MarketStateDataSchema.parse(ms); SectorsDataSchema.parse(sec);
   JSON.parse(require('fs').readFileSync('data/lab/$RUN_DATE.json','utf8'));
   console.log('ok');"
   ```
   Also check that `latest.json` and `$RUN_DATE.json` match byte for byte in
   both directories (`cmp`). Fix and re-run until clean.
2. `bun install --frozen-lockfile && bun run typecheck && bun test`.
3. Stage only `data/marketstate/** data/sectors/** data/lab/**`. Commit:
   `feat(routine): marketstate + sectors + lab snapshot $RUN_DATE`.
4. Green → `git push origin master`. Red → push to `routine/$RUN_DATE`
   and name the failing check in the brief. Master must never go red from a
   data commit. If the push fails on the network, retry once; keep the local
   commit either way.
   If the session may only push to its own branch (a `claude-code/*` branch
   rather than `master`), push the commit there, open a PR into `master` with
   `mcp__github__create_pull_request`, then call
   `mcp__github__enable_pr_auto_merge`. GitHub merges it when the required
   `build` check passes, and the merge deploys to production. If enabling
   auto-merge is refused (the repo setting or branch protection is off), leave
   the PR open and put its link in the brief. Never merge it yourself.
5. Anything else on GitHub (PRs, check status) goes through the
   `mcp__github__*` tools. `gh` is blocked here.

---

## 6. The brief (final chat message)

Delta-first. Every line names: the item, the evidence (numbers), a hedge word
from ROUTINE.md §d, what would invalidate it, and the source. Sections appear
only when they have content, in this order:

```
hypertrade · <RUN_DATE> · regime <state> (<since N days>) · <commit sha or branch>

Read: <one or two sentences: the main change and the main disagreement (§3.4)>

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

Data gaps: <source — HTTP code / staleness>, or omit
```

If nothing changed in any category, send one line saying so and the regime.
Don't restate unchanged readings.

### Push notification

Send exactly one, with the top three lines of the brief, **only if** at least
one of these happened this run:

- a new `robust` rule was saved;
- a catalogue rule's `firing` flipped;
- an `origin: "agent"` rule was removed;
- any metric reached `|z30| ≥ 2`;
- hl-cycles `regime.state` changed;
- a previous-run risk from the scorecard was **hit**.

No notification otherwise.

---

## Hard rules

- **Market intelligence, not financial advice** (ROUTINE.md). No trade
  recommendations, no position sizing, no "buy/sell X". Every forward-looking
  statement carries a hedge word. A robust rule, a flip, a |z| ≥ 2 reading or
  a regime change is evidence to report, not a signal to act on. This
  applies to the chat brief too.
- Write only inside `data/**` (`marketstate`, `sectors`, `lab`). Never edit
  `src/`, `api/`, `db/` or docs as part of a routine run.
- Remove catalogue rules only when `origin` is `"agent"`.
- No orders, no signing keys. Desk (`src/server/desk/*`) is out of scope.
- Never print or log `LAB_API_TOKEN`.
- When a source degrades mid-run, say so in the brief and in the affected
  `summary`. Don't fill gaps from memory.
- If a tool or hook blocks something this runbook needs, stop and report the
  block. Don't route around it.
