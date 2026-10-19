# FEATURES — signal evidence ideas

Seven ideas for annotating signals with evidence instead of verdicts. They originated in a retired sibling prototype (perpsignal), a signal-only system for Hyperliquid perps on daily bars. Each section stands on its own: problem, mechanism, rationale, where it hooks into hypertrade, and its status. Tasks live in TASKS.md § Phase 9.

Ground rules that apply to every section:

- **Signal tools annotate and inform.** Nothing here places an order, sizes a trade, blocks the operator, or nags about discipline. Alerts state facts.
- **The LLM translates and argues.** It may turn the operator's words into a rule, or argue the other side. It never creates, scores or upgrades a signal, and it never runs in a scheduled loop that decides anything.
- **Evidence, not verdicts.** Numbers carry their sample size and interval. "Not shown to lose" is never written as "proven".

| # | Idea | Status in hypertrade | Hook | Task |
|---|---|---|---|---|
| 1 | Setup-schema compiler | Partly covered (Lab rules); authoring from intent in scope | `src/server/lab/tools.ts`, `service.ts` | PS1 |
| 2 | Event-study screen | In scope | `src/server/platform/stats.ts`; new Lab tool | PS2, PS3 |
| 3 | Replay parity | Covered for both existing engines; required of any new one | `lab/engine/evaluate.test.ts`, `platform/scanner.test.ts` | inside PS3 |
| 4 | Novelty detector | In scope | new `src/server/platform/novelty.ts` + daily loop | PS5 |
| 5 | Evidence line + trial counter | Partly covered (ledger stats); alert text and counter in scope | `src/server/platform/alerts.ts`, Lab store | PS1, PS4 |
| 6 | Thesis watch | Partly covered (thesis stress-tester); transitions, drift, alert in scope | `src/server/intel/thesis.ts` | PS6 |
| 7 | Macro label, static calendars, ntfy, relative liquidity | Calendars and liquidity covered; ntfy and macro label in scope | `src/server/desk/notify.ts`, `platform/scanner.ts` | PS7 |

---

## 1. Setup-schema compiler (intent → schema → one engine)

### Problem

Hardcoded setups are rare by design, so an operator with a new intuition waits for a developer to write it. Code written by hand for live use and again for backtesting drifts apart, so the backtest stops describing what live does. Letting an LLM decide live is worse: it is unauditable and cannot be backtested.

### Mechanism

A setup is **data**: a JSON document validated by zod, built only from a fixed vocabulary of named features. One deterministic engine compiles it into a pure predicate. The live run and the backtest call that same predicate.

**Feature vocabulary.** Each feature is named, typed and unit-tagged, and evaluated on the last closed daily bar. Refs are `name`, `name(args)` or `name(args).field`. Integer lookbacks run 1..400.

| Feature | Kind | Unit | Definition |
|---|---|---|---|
| `close`, `open`, `volume` | num | price / USD | bar values (volume in USD notional) |
| `high(n)`, `low(n)` | num | price | highest high / lowest low over the last n bars |
| `ma(n)` | num | price | simple mean of closes |
| `ma_slope(n,k)` | num | % | `ma(n)` now vs `ma(n)` k bars ago |
| `ret(n)` | num | % | `close / close[−n] − 1` |
| `off_high(n)`, `off_low(n)` | num | % | close vs n-bar high / low |
| `atr` | num | price | mean true range over 14 bars |
| `ma_reach_atr(n)` | num | ATR | how many ATRs the bar's adverse extreme stayed beyond `ma(n)` (low for longs, high for shorts) |
| `funding_apr(n)` | num | % | mean daily funding over n bars as APR (`hourly rate × 24 × 365 × 100`) |
| `funding_z90` | num | z | the day's mean hourly funding vs the previous 90 days; null below 60 funded days |
| `oi_change(n)` \* | num | % | OI in coins (USD OI / close) now vs n bars ago |
| `oi_from_peak(n)` \* | num | % | OI in coins vs its n-bar peak; null unless all n are known |
| `oi_history` \* | num | days | days with OI known |
| `rv_pctile` | num | 0–1 | 20-day realized vol (stdev of daily log returns), percentile over 365 bars |
| `rv5to60` | num | ratio | 5-day realized vol / 60-day realized vol |
| `vol_regime` | cat | low, normal, high | `rv_pctile` < 0.25 low, > 0.75 high |
| `market` | cat | bull, bear, neutral, stress | market regime from BTC vs MA50, MA50 slope and breadth above MA50; persists 3 closes except `stress` |
| `trend`, `trend_w` | cat | up, down, range | daily trend (persisted 3 bars); weekly = close vs 10-week MA and 4-week ROC agree |
| `flush(lookback,sigma,volMult)` | bool + fields | — | a bar in the lookback with log return ≤ −sigma × 20-day stdev and volume ≥ volMult × prior 20-day mean; fields `.mid .low .high .sigma .vol_x .date .funding_nonpos` |

\* needs OI history.

**Schema shape.**

```ts
interface SetupSchema {
  id: string; version: number;          // identity is id@version; any threshold change bumps version
  intent: string;                        // the operator's words, verbatim
  direction: "long" | "short" | "trend"; // trend has both branches; the coin's daily trend picks one
  long?: Branch; short?: Branch;
  horizonDays: number;                   // 1..365
  permits: { market: MarketRegime[]; coinTrend?: Trend[] };
  gateExemptions: string[];              // authored setups may only skip vol_of_vol and funding_sanity
  minRr: number; cooldownDays: number;
  evidence?: Record<string, string>;     // what the alert shows; default = every compared feature
}
type Branch = { conditions: Condition[]; stop: Expr; target: Expr; invalidation: Expr };
type Node =
  | { f: string; op: "<" | "<=" | ">" | ">=" | "crosses_above" | "crosses_below"; to: number | string }
  | { f: string; in: string[] } | { f: string; not_in: string[] } | { is: string }
  | { all: Node[] } | { any: Node[] } | { within: number; cond: Node };   // within: true on any of the last n bars (≤ 60)
type Condition = (Node & { id: string }) | { requires: Condition; then: Condition };
type Expr = number | string | { "+": [Expr, Expr] } | { "-": [Expr, Expr] } | { "*": [Expr, Expr] };
```

Validation rejects unknown features, wrong arity, wrong kind (a category in a comparison), unknown category values, duplicate condition ids, more than 32 nodes per branch, and `within` nested deeper than 3. There is no free code and no math beyond `+ − ×`.

**Engine.** `compile(schema)` returns `(metrics, regimes) → Check`, where `Check = { dir, conds: [{ id, pass, value?, limit? }], evidence, stop, target, invalidation }`. Every condition reports its value and limit, so a reader sees how close a coin came. Gates, sizing, cooldown, per-run caps and the backtest consume `Check` and never look inside the schema. Each schema also renders as plain English (`funding_apr_7d: 7d mean funding APR ≤ −10%`), which is what the operator approves.

**Authoring.** One command takes the operator's intuition and returns one schema. A second mode reads today's market summary and proposes up to 3 of the simplest schemas that fit it. For each candidate the tool shows the readable conditions, the historical screen (section 2), the trial number (section 5) and the coins that match today, then asks `approve? [y/N]`. Only a `rejected` screen refuses approval. A new version is a new trial. Nothing goes live without approval. The authoring prompt demands the fewest conditions that capture the intent (2–3), round thresholds, no threshold tuning, and no near-duplicate filters.

### Rationale

- One predicate for live and backtest removes a whole class of drift bugs (see section 3).
- A fixed vocabulary is what makes LLM output safe to run: the model can only recombine audited features, and anything else fails validation before a human even sees it.
- The LLM sits at authoring time only, as a translator from words to a rule the operator then reads in plain English and approves. That keeps the alpha in the operator's head and the machine auditable.
- Minimal schemas guard against curve fitting: each extra condition is a degree of freedom the screen cannot see.

### Hypertrade hook and status

**Partly covered.** The Lab already treats a rule as data over a feature vocabulary: `RuleSchema` (`src/server/lab/types.ts:95`) is asset, direction, horizon and one or two conditions over `metric|transform|window` features, and one engine serves backtest and live (`ruleFiresAt`, `src/server/lab/engine/evaluate.ts:152`, used by `marketPulse`, `src/server/lab/service.ts:413`). LLM clients can already drive the Lab through MCP.

**In scope (PS1):** an authoring tool `lab_author_rule` in `src/server/lab/tools.ts` and `service.ts`. It turns intent text into 1–3 `Rule` candidates through `completeStructured` (`src/server/intel/llm.ts:111`), validates every feature id against the metric catalogue, evaluates each with the existing explicit-rule evaluation, records each candidate in the global trial counter (section 5), and writes nothing. The operator saves through `lab_catalogue_save`, which stays the approval step.

**Out of scope for now:** stop/target/invalidation expressions, categorical regime conditions, and `within`/`crosses` on Lab rules. The platform's four intraday setups are schemas since PS-B1 (`src/server/platform/setups.ts`, compiled into the scanner's one predicate).

---

## 2. Event-study screen (reject only, clustered by ISO week)

### Problem

A Sharpe test on daily positions is the wrong test for rare setups that open on an event and close on a stop, a target or a horizon. Pooling events across coins makes it worse: one BTC flush fires ten alts on the same day, and overlapping 7–14 day holds share the same market move. Counted as independent, they shrink the standard error and make noise look significant. A screen that *grants* status on a few lucky signals passes zero-edge setups about half the time.

### Mechanism

**Replay.** Walk every historical day. Per coin, apply the same universe floor, health gates, regime permissions, setup predicate, sizing, per-run cap and cooldown as live. Each trailing window is 400 bars. A coin is in the universe that day only with daily notional volume ≥ $5M.

**Play-out.** Entry is the plan mid (the signal close; the market trades 24/7, so the next open is the same price). Walk up to `horizonDays` bars:

- stop hit: exit at the worse of the stop and the bar's open (gaps fill badly);
- stop and target in the same bar: **stop wins** (flagged `ambiguous`);
- target hit: exit at target;
- otherwise exit at the close of the horizon bar;
- data ends before the trade does: the event is dropped.

**R per event**, net of everything:

```
R = dir × (exitPx − entryMid) / |entryMid − stop|
    − feeRoundTripPct / stopPct
    − (2 × slippagePctPerSide + fundingPaidPct) / stopPct
fundingPaidPct = Σ over held bars of dir × (that day's mean hourly funding × 24) × 100
```

Defaults: round-trip fee 0.09%, slippage 0.05% per side. A long pays positive funding and a short receives it.

**Cluster.** Key each event by the Monday of the ISO week of its signal bar. A week's mean R is one observation. Expectancy is the mean over weeks of the weekly means. W = the number of weeks with at least one event.

**Verdict.**

```
upper95 = expectancy + t(0.95, W−1) × sd(weekly means) / √W      (sample sd; one-sided Student t)
W < 30                      → insufficient
W ≥ 30 and upper95 < 0      → rejected     (clearly a loser)
otherwise                   → clear        ("not shown to lose", never "proven")
```

Printed as facts, not used in the verdict: events, W, expectancy, upper95, train expectancy and holdout expectancy (holdout = the last 30% of the period by time), the period, and the trial number. Every output carries the survivorship note: the replay uses today's surviving coins, so it flatters the past.

**Statuses.** A setup is `active` (evaluated and alerts) or `rejected` (never evaluated). A `rejected` screen sets `rejected`. Every other outcome leaves the setup `active` from the day it is approved.

### Rationale

- **R units** make a 3% stop on a meme coin and a 1% stop on BTC comparable, and charging funding matters because funding-extreme setups trade against the very carry they collect or pay.
- **ISO-week clustering.** Same-day alt events are one market move, and 7–14 day holds overlap. A week is the smallest bucket that contains one hold and keeps the events inside it from leaking into the next. Coarser buckets throw away observations.
- **30 weeks.** Below that the sample sd is unstable, the t quantile is wide, and the test cannot tell a loser from noise. `insufficient` says so instead of guessing.
- **Reject only.** A backtest can only reward patterns that already existed, and an idea inspired by recent markets cannot be tested fairly on the period that inspired it. So the screen is allowed to say only one thing with confidence: this lost money, clearly.
- **No Bonferroni.** A multiple-testing correction controls false *claims of an effect*. This screen claims no effect: `clear` grants nothing, because every approved setup alerts anyway. An earlier version required a Bonferroni-deflated bar to pass, and its only effect was to throw away real ideas. Multiple testing is still visible, as a fact: the global trial counter (`idea #n of N`, section 5) tells the operator how much luck to expect. Contrast the Lab, whose `robust` verdict does grant status after testing thousands of variants: deflating there (deflated Sharpe against effective trials) is correct.
- **Why the vault was dropped.** A sealed holdout works only if it is sealed before any idea is formed on it. Here the holdout period had already been seen when the setups were designed, so it gave false assurance, and a holdout of a few weeks has almost no power anyway. The train/holdout split survives as two printed numbers.
- **Why promotion/demotion was dropped.** Promoting on mean R ≥ 0 over 5–10 live signals passes a zero-edge setup about half the time, which is a coin flip dressed as evidence.

### Hypertrade hook and status

**In scope, two parts.**

- **PS2, platform ledger stats.** `groupStats` (`src/server/platform/stats.ts:9`) computes a t-interval over individual outcomes, and the scanner switches `edgeBasis` to `ledger` once `n ≥ PLATFORM_EDGE_MIN_N` (`src/server/platform/scanner.ts:179`). Platform ideas cluster exactly as described above: one move fires many coins, and 1h–72h horizons overlap. Add a cluster count and compute the interval over cluster means. The cluster key is the epoch-aligned bucket `floor(createdAtMs / max(1 day, horizonMs))`, the intraday analogue of the ISO week. `edgeBasis` then requires `clusters ≥ PLATFORM_EDGE_MIN_N`.
- **PS3, Lab event study.** A new tool `lab_event_study` takes a Lab `Rule` plus `{ coins?, stopAtr, targetAtr }`, replays it across the HL perp universe on daily candles and funding (the `ht` provider data), and returns the pooled, week-clustered screen above. It ships with a parity test (section 3).

---

## 3. Replay parity (live path = backtest path)

### Problem

If live evaluation and the backtest are separate code paths, a backtest result describes a system that does not run.

### Mechanism

Both paths call one pure predicate over the same metrics (section 1). A parity test runs the backtest over frozen history and asserts that the events it produces equal, event for event, a baseline captured from the live path (or from the previous implementation when porting). Coin, date, direction, exit, exit date and R must match, with an empty diff and identical counts. When hand-written setups were first ported to schemas, 239 of 239 events matched before the hand-written versions were deleted. A later replay bug (gate exemptions ignored in replay) was caught by the same test and fixed with a new baseline of 241 events. Run the test against the full cached history and skip it where the cache is absent (CI).

A cheaper variant needs no cache: for k at several points in a long synthetic series, evaluate the live predicate on data truncated at k and assert it equals the historical in-zone flag at k. That proves no look-ahead.

### Rationale

Parity is the cheapest guarantee that a screen number means something. It also catches look-ahead: a feature that reads future bars passes in backtest and breaks live.

### Hypertrade hook and status

**Covered for both existing engines.** The Lab has the truncation test ("in-zone days never depend on later data", `src/server/lab/engine/evaluate.test.ts:131`). The platform has score determinism from stored inputs (`src/server/platform/scanner.test.ts:156`, `src/server/platform/score.test.ts:10`). **Required of any new engine:** PS3 ships with a parity test asserting that `lab_event_study` entry days equal the rule's live firing days (`ruleFiresAt` on truncated data) for the same coin, after cooldown.

---

## 4. Novelty detector

### Problem

History is useless exactly when a market does something it has not done before, and that is when the operator's judgement matters most. Setups can only fire on patterns someone anticipated.

### Mechanism

Once per newly closed daily bar, check every coin that passes the liquidity and data-sufficiency gates against **its own full history** (every closed bar since listing, current bar excluded; at least 365 bars).

**Monitored features, by family.** Features within one family measure one fact.

| Family | Features |
|---|---|
| funding | `funding_z90`, `funding_apr(7)` (only when all 7 days have funding) |
| oi | `oi_from_peak(20)`, `oi_change(7)` (only with ≥ 365 days of OI history) |
| price/activity | `ret(7)`, `rv5to60`, `vol_x` = the bar's volume / mean volume of the prior 20 bars |

Definitions are as in section 1. A non-OI feature needs ≥ 90 past measurable values, or it is skipped with a note.

**Hits.**

- **New extreme:** a feature strictly beyond its historical min or max (equal is not beyond).
- **Joint extreme:** features from **two or more families** beyond their own 1st/99th percentile on the same bar. Percentiles use linear interpolation over the sorted history.

**Entry** (one per coin per bar, id `${barDate}:${coin}`; reruns add nothing):

```ts
{ id, detectedAt, barDate, coin, kind: "new_extreme" | "joint_extreme",
  families: ("funding" | "oi" | "price")[],
  features: [{ id, value, histMin, histMax, p1, p99, bars, pctRank }],  // every feature beyond its p1/p99
  nearSetups: string[],        // setups that signalled, cooled down or near-missed on this coin; [] = none
  marketWide: boolean,         // BTC
  pushed: boolean, suppressed?: "cooldown" | "run_cap",
  notified: [{ at, channels }] }
```

`pctRank` = % of history below the value, ties counting half (0 or 100 = new extreme). Keep 365 days of entries.

**Push rules.** Every hit is stored. **Only new extremes are pushed**; joint-only hits stay in the journal and UI. Push cooldown is 3 days per coin, either side of the bar. At most 3 pushes per run, ranked by more new extremes, then more features, then OI rank. A late run that backfills several bars gives the budget to the newest bar first. Undelivered pushes are retried for 3 days. BTC is labelled market-wide.

**Alert wording.** Information only, never a signal, never a plan or size:

```
NOVEL: <coin> — <feature ids> — no setup covers this        (or: near: <setup ids>)
new extreme on bar <date> · market-wide (BTC)
<feature> <value> (history <min> to <max>, pct rank <p>)
```

Priority is by alert type, never by evidence: novelty sits one level below a signal. A novelty entry is the natural prompt for authoring a new rule (section 1).

**Measured rate.** Replay the detector over the last 365 days and print entries/day and pushes/day, so the push rate is a fact. Before push-only-new-extremes, a replay measured about 0.4–0.8 pushes/day.

### Rationale

- A per-coin full-history baseline answers "has this coin ever been here", which a 7- or 14-day z-score cannot.
- Families stop one fact from counting twice (funding z and funding APR move together).
- Pushing only new extremes keeps the phone quiet. Joint extremes are interesting context, but not worth an interruption.

### Hypertrade hook and status

**In scope (PS5).** Not covered: intel deltas use 7-day baselines (`src/server/intel/normalize.ts`) and platform features use a 24-hour ring and a 14-day funding percentile (SPEC.md § Platform P0.9). Hook: a pure `src/server/platform/novelty.ts`; a daily `novelty` loop in the loop definitions of `scripts/server.ts` that acts once per new closed UTC day; daily inputs from the `candles` table (1d, via `ensureHistory`), the `funding` table and the `observations` series `hl.oi.<COIN>`, the same data the Lab `ht` provider reads (`src/server/lab/providers/ht.ts`); persistence in the next free migration plus `PlatformStore` (memory and Postgres); pushes through the platform notifier (`src/server/platform/alerts.ts`). OI features stay skipped until 365 days of OI exist, and the skip is noted, never hidden.

---

## 5. Facts-only evidence line and global trial counter

### Problem

A signal with no track record looks as confident as one with a long record. A badge ("validated", "shadow") hides the sample size, and a conviction score invents precision.

### Mechanism

Every alert and every UI row carries one line of facts:

```
live 4 · +0.31R (−0.9…+1.5) · screen 12 wk +0.46R clear · idea #9 of 9
```

- **live:** resolved signals of this `id@version` raised since `approvedAt` (target, stop, expired or invalidated; `missed`, a signal that never filled, never counts), their mean R, and a 90% interval `mean ± 1.645 × sd / √n`. The interval is omitted below 3 signals. `live 0` when none.
- **screen:** independent weeks, mean R and verdict from section 2. The upper bound stays in the detailed output, not the line. `screen none` until screened.
- **idea #n of N:** n = the trial that first recorded this `id@version` (`#?` if none). N = the global trial count.
- The line is frozen into each signal at raise time. Readers also get the live count as a number, so they can sort without parsing.

**Global trial counter**, persistent and append-only, never reset. Each entry is `{ n, at, setup: "id@version", source: "seed" | "backtest" | "author", intent?, verdict }`. Every schema screened at authoring time increments it, approved or not. A backtest counts an `id@version` once, the first time it is studied. If the store fails validation, tools stop rather than restart the count.

### Rationale

The trial count is how the operator judges luck: the ninth idea tried that looks good is weaker evidence than the first. It is context, not a threshold, so it never blocks anything. Showing n and an interval lets the operator weigh a signal without the tool pretending to know more than it does.

### Hypertrade hook and status

**Partly covered.** The ledger already computes, per setup kind and horizon, n, hit rate, mean net return and a 95% t-interval, null below n = 5 (`src/server/platform/stats.ts:9`), and the opportunity detail shows them (SPEC.md § Platform P0.14).

**In scope (PS4):** the Telegram `Ready:` alert (`src/server/platform/alerts.ts:65`) gains the facts line `ledger 24h: n 37 · 11 clusters · +0.42% (−0.3…+1.1) · edge unvalidated`, built from PS2's clustered stats and showing the horizon used. The counter lives in the Lab store, written by PS1's authoring tool. Catalogue entries authored through it show `idea #n of N`.

---

## 6. Thesis watch (premise tracking)

### Problem

An operator holds a position for reasons. Those reasons can quietly stop being true while P&L still looks fine, and P&L-driven alerts push toward the wrong habits. The operator wants to know when a premise *stops holding*, stated as fact, with no advice.

### Mechanism

1. The operator writes a thesis in free text, with premises and an optional invalidation level.
2. The LLM extracts each premise into a check from a fixed catalogue (same idea as section 1: data, not code). A premise outside the catalogue (macro, flows, narrative) becomes a free-text premise, checked against dated events in the store or left `unknown`. It is never guessed.
3. Every scheduled run re-evaluates every premise with code: status `supported | contradicted | unknown` plus the number, its source and timestamp. No LLM call on recheck.
4. Append each evaluation to the thesis's history, so drift over time is visible, not only a binary flip.
5. When a premise moves `supported → contradicted`, or an invalidation condition moves `clear → triggered`, send one alert:

```
Premise no longer holds: <premise text>
<check in words>: now <value> (<source>, <timestamp>)
```

Wording rules: facts only. No "consider closing", no P&L, no urgency words. The invalidation level is a reference shown alongside, never enforced. On request, or attached to a transition, the LLM may add a steelman of the opposite view, tagged as hypothesis. A novelty hit (section 4) on a thesis asset is mentioned in the next thesis check.

Premises skip the screen and the trial counter: they describe the operator's reasoning, not a tradeable rule. The watch runs alongside setups and novelty, not instead of them.

### Rationale

P&L-blind premise tracking keeps the operator honest about *why*, without the tool policing *what* they do. "No longer holds" is the exact fact, while "broken" or "failed" carries a judgement.

### Hypertrade hook and status

**Partly covered.** The thesis stress-tester (`src/server/intel/thesis.ts`) already extracts claims and assumptions into a fixed check catalogue (`metric_threshold`, `price_vs_level`, `funding_sign`, `oi_change`, `event_exists`, `unknown`; `src/shared/intel.ts:625`), evaluates them in pure code (`evaluateCheck`, `thesis.ts:88`), stores invalidation conditions and "wrong if" lines, and rechecks on demand (`checkThesis`, `thesis.ts:363`) or when a brief flags one of the thesis's assets (`recheckForAssets`, `thesis.ts:371`, wired at `src/server/intel/terminal.ts:299`).

**In scope (PS6):** detect transitions in `checkThesis` by comparing with the stored statuses; append per-check history (next free migration: a `history jsonb` column on `intel_theses`); send the alert above through `sendIntel` (`src/server/intel/notify.ts:37`); recheck every thesis on each cron brief, not only flagged assets.

---

## 7. Macro label, static calendars, ntfy channel, relative liquidity

### Mechanism and rationale

- **Macro window is a label, never a gate.** When a FOMC decision or CPI release falls on the signal bar's close day or one calendar day either side, the signal and alert carry `macro: "CPI in 1 day"` (or `FOMC today`, `CPI 1 day ago`; several joined with ` · `). If the calendar does not cover the next 14 days, the label reads `macro calendar stale`. Nothing is blocked: no evidence shows a ±1 day window matters for multi-day horizons, and an earlier version that gated on it failed closed for every coin when the calendar API key was missing.
- **Static calendars as the no-key fallback.** FOMC decision dates and CPI release dates are stored in code from the Fed and BLS schedules, refreshed yearly. A keyed calendar API may add more releases, but the static dates win on duplicates and work with no key.
- **ntfy channel.** POST to `<server>/<topic>` with headers `Title`, `Priority` (quiet 2, info 3, warn 4, critical 5) and optional `Click` (deep link) and `Authorization: Bearer <token>`, body capped at 4000 chars. Header values must be printable ASCII, so strip everything else and cap at 250 chars. Env: `NTFY_TOPIC`, optional `NTFY_SERVER` (default `https://ntfy.sh`) and `NTFY_TOKEN`. Like every channel, a failure is reported and never fails the caller. ntfy needs no bot setup and reaches the phone with real priorities.
- **Relative liquidity gate.** A coin passes when its 24h volume ranks in the top 40% of live perps, on top of an absolute universe floor ($5M daily notional). A relative rank adapts to market-wide volume cycles, where a fixed dollar floor goes stale. At the operator's position size ($1k–2k) the floor alone makes any size filter moot.

### Hypertrade hook and status

- **Static calendars: covered.** `src/server/intel/calendar.ts:48` holds FOMC, CPI and NFP dates for 2026–2027 with release times. Catalyst alerts fire at T−24h and T−1h (SPEC.md § Intel I0.13).
- **Relative liquidity: covered.** The platform assigns liquidity tiers by universe tercile of 24h notional volume and sets thresholds per tier (`liquidityTiers`, `src/server/platform/features.ts:126`).
- **In scope (PS7):** an ntfy channel in `createNotifier` (`src/server/desk/notify.ts:57`), which every alert path shares, and a macro label tag on platform opportunities, computed in `src/server/platform/scanner.ts` from `calendarEvents` (`src/server/intel/calendar.ts:86`). It is a tag only: no score or status effect.

---

## Other ideas from the same prototype

- **Near-miss ("why not").** Per coin: every health gate passed and exactly one setup condition failed, numeric and within 10% (relative) of its limit; the closest wins. Price-level conditions (close vs MA) never count, because 10% of price is not "near". Shown as the top near-miss (`GET /api/platform/near-miss`: top plus per-coin list); novelty `nearSetups` includes it. Informational only.
- **Condition funnel.** For an authored rule, count coin-days surviving each condition in order and mark the step with the largest relative drop, to show where an idea dies. *Backlog (PS-B3), after PS1.*
- **Narrative with a caution flag.** One capped LLM call per passing signal (why now, what invalidates it, counter-thesis) may attach a caution flag and never changes the signal. *Covered:* the platform research stage and bear case (SPEC.md § Platform P0.11, `src/server/intel/research.ts`).

---

## Appendix: authored setups and trial history

Daily bars, Hyperliquid perps. Thresholds are as authored. "Screen" is the last recorded result. The four planner-seeded setups were screened on 2026-10-13 over 47 coins (2023-05-12 → 2026-10-12) under an **earlier** screen that counted independent signal dates and applied a Bonferroni bar. The revised reject-only screen of section 2 was never re-run on them, so no current-rule verdict exists.

| # | Setup (`id@version`) | Dir | Conditions, in words | Stop / target / invalidation | Horizon | Last screen |
|---|---|---|---|---|---|---|
| 1–8 (seed) | `negative_funding_squeeze@1` | long | 7d mean funding APR ≤ −10%; funding z90 ≤ −1.5; 7d return ≥ 0; close > MA20. Any market regime except stress. | stop 7d low − 0.25 ATR; target close + 3 ATR; invalidated on a daily close below the 7d low; min R:R 1.5; cooldown 7d | 7d | insufficient (9 events) |
| 1–8 (seed) | `crowded_long_fade@1` | short | 7d mean funding APR ≥ 40%; funding z90 ≥ 2; 7d return ≤ +3%; close ≥ 3% below the 20d high; not (market bull and coin trend up). Exempt from the funding cap. | stop 20d high + 0.25 ATR; target close − 3 ATR; invalidated on a daily close above the 20d high; min R:R 1.5; cooldown 7d | 7d | 0 events (blocked by the $5M floor on 63 candidate days, the bull+up block on 54, the R:R floor on 26) |
| 1–8 (seed) | `capitulation_reclaim@1` | long | a flush bar in the last 5 days (log return ≤ −2.5σ of 20d, volume ≥ 2× its 20d mean); funding ≤ 0 every day since the flush; close back above the flush bar's midpoint. Any regime; exempt from the vol-stability gate. | stop flush low − 0.25 ATR; target close + 4 ATR; invalidated on a close below the flush low; min R:R 1.5; cooldown 10d | 10d | insufficient (18 events) |
| 1–8 (seed) | `trend_pullback_oi_reset@1` | trend | long side: market bull, MA20 > MA50, weekly trend up, vol regime not high, bar's low within 0.5 ATR of MA20, close ≥ MA20, OI ≥ 10% below its 20d peak (needs 30 days of OI), 7d funding APR ≤ 15%. Short side mirrored (bear, down, close ≤ MA20, funding ≥ −15%). | stop close ∓ 1.5 ATR; target close ± 4 ATR; invalidated on a close beyond MA50; min R:R 2; cooldown 14d | 14d | rejected under the earlier bar (212 events, 141 dates, +0.23R train, +0.08R holdout); positive means, so the revised rule would likely not reject it |
| 9 | `crowded_long_fade_any_regime@1` | short | same as `crowded_long_fade` but allowed in every market regime, bull with coin trend up included; still exempt from the funding cap. Authored 2026-10-13 from intent. | as `crowded_long_fade` | 7d | insufficient (31 events, 24 dates, −0.08R train, −1.02R holdout). Not approved; the evidence supported keeping the regime block. |

Trial counter at retirement: **N = 9**. The seed entry (n = 8) counts the four planner setups tested twice: once, then again after the liquidity and funding-cap gate changes. Entry 9 is the authored variant above.
