# ROUTINE.md — hypertrade scheduled routine

This file is the whole runbook for the **one scheduled routine**, run every 4
hours: a stateless Claude Code cloud session that scans the most active
Hyperliquid perps on their 4h, 1d and 1w bars, reads where positioning is
imbalanced, and writes conditional setups through code's gate. It writes
`data/board/` and `data/setups/` every run, `data/marketstate/`,
`data/sectors/` and `data/lab/` once a day, runs the Lab search once a week,
pushes, and sends **one** ntfy push only when something is new.

If you were opened for ordinary development work in this repo, this file is
not your task. Use `docs/SPEC.md`, `docs/design/README.md` and `docs/LAB.md`.
Don't touch `data/**` unless asked.

Order of a run: **preflight (§1) → collect the board (§2) → read it (§3) →
write the scan and gate it (§4) → daily and weekly extras (§5) → validate,
commit, push (§6) → one delivery (§7).**

**Hard rule, unchanged:** this is market intelligence, not financial advice.
No trade recommendations, no position sizing, no "buy/sell X". Every
forward-looking statement is framed with explicit confidence language — see
the hedge vocabulary. Never state a future market outcome as fact.
No leverage. A setup is a conditional plan for a human: a checkable trigger,
an entry zone, an invalidation with its reason, targets, and the evidence.
Nothing here gates, approves, rejects or places anything. It applies to
every file, the push and the final message.

**Who does what.** Code measures; you interpret.

| Code (`src/server/routine/`) | You |
|---|---|
| The board: top-30 perps by 24 h volume plus majors and "my markets"; per market 4h/1d/1w structure, funding vs its own week and vs Binance/Bybit, OI change, premium, relative strength, cross-sectional z (`board.ts`) | Where the board leans and the largest imbalance (`read`) |
| Tripwires: commonplace setups as hard thresholds, hits and near-misses (`tripwires.ts`) | The imbalances thresholds miss: weak signals that agree, price vs positioning, timeframe and venue disagreements, outliers (`watchlist`) |
| The level menu per market; resolving your level keys to prices; R; alignment with the weekly trend; expiry from the timeframe (`scan.ts`) | Setups where an imbalance meets a level, with levels picked **by key** from the menu (`setups`) |
| The gate (`gate.ts`), status against prices (`ledger.ts`), the brief and the push text (`run.ts`) | A reason for every tripwire hit you pass on (`passes`); cancels when a premise broke (`cancel`); the delta-first `brief` |

The app makes no LLM calls for this. The same pipeline runs without a Claude
session (`bun run routine`, which calls the model itself; background:
`docs/fallback-routine.md`). This session stands in for that model call
through `--input`.

---

## 0. The bar: what a good run looks like

Each run leaves the reader knowing **which markets are leaning, how hard,
what would turn each into a plan, and which plans are on**: new setups where
an imbalance meets a level, every tripwire hit answered, the open setups'
status, and what would prove the read wrong.

Failures seen in past runs. Don't repeat them:

| Failure | Example | Do this instead |
|---|---|---|
| Standing aside by default | 2 weeks of 4-hourly runs, 0 setups ever, while the gate allowed them | A board of 30+ perps nearly always has something leaning. Propose when the structure is clean: a setup is a hypothesis with an invalidation, and the ledger grades it. Never propose one without both an imbalance and a level. |
| Generic market reads every 4 h | Five domains of macro prose, rewritten each run, nothing to act on | The 4 h job is the board. The macro narrative is once a day (§5). |
| Readings listed, never read together | "OI z30 +0.8, funding z30 +0.7" | Read price, OI and funding together and across 4h/1d/1w; say what the combination means. |
| Invented levels | Round numbers with no source | Prices come only from the level menu, by key; code resolves them. |
| The same Lab searches every 4 h | Four identical searches on near-identical data: a multiple-testing layer the deflated Sharpe does not see | Lab search is weekly (§5). |

If a source is down, the board says which (gaps at the bottom of
`board.txt`). Name it in the brief; don't fill it from memory.

---

## 1. Preflight (every run, in this order)

1. **Environment.** Provided by the cloud environment: `LAB_API_TOKEN` (read
   bearer) and `NTFY_TOPIC` (delivery; optional `NTFY_SERVER`, `NTFY_TOKEN`).
   The session reads everything over HTTPS and never opens a database
   connection: a cloud session has no route to Postgres.
   ```bash
   export APP_URL="${APP_URL:-https://hypertrade-ten.vercel.app}"
   export LAB_URL="${LAB_URL:-$APP_URL}"
   ```
   Missing `LAB_API_TOKEN`: the board still runs on public data; write
   "LAB_API_TOKEN not set" in the brief and skip the Lab parts of §5. Missing
   `NTFY_TOPIC`: do the run, skip §7's push, list it as a gap. Never print
   `LAB_API_TOKEN`, `DATABASE_URL` or `NTFY_TOKEN`.
2. **Fresh checkout.** `git checkout master && git pull --ff-only` on
   `kygura/hypertrade`, then `bun install --frozen-lockfile`.
3. **Execution date.** `RUN_DATE=$(TZ=Atlantic/Canary date +%F)`, captured
   once at start. Every dated file uses it, even past midnight.
4. **Previous state** is read by code: `data/setups/ledger.json` (open and
   closed setups, 90-day stats), `data/board/history.json` (the snapshots OI
   changes are measured against), `data/board/latest.json` (last run's
   watchlist and tripwire hits, for deltas), and `data/setups/htf.json`, the
   operator's optional stance: while it is valid, `stance: stand_aside`
   blocks every new setup. You don't edit any of them.

---

## 2. Collect the board

```bash
mkdir -p /tmp/run
MODE=scan; [ -f data/marketstate/$RUN_DATE.json ] || MODE=daily   # first run of the date also collects the macro context (§5)
bun run routine --mode $MODE --collect-only --context /tmp/run/context.json > /tmp/run/board.txt
```

About 2–3 minutes (Hyperliquid's weight budget paces the candle and funding
calls). `board.txt` has three parts (four with `MODE=daily`):

1. **Rules**: the scan system prompt. It is the contract for §3 and §4,
   including the gate's rules; if this file and it disagree, it wins.
2. **Board and context**: one line per market (structure per timeframe,
   positioning, relative strength, cross-sectional z, the level menu), the
   tripwire hits and near-misses with each condition's value, open setups,
   last run's watchlist, hl-cycles regime and levels, the next FOMC/CPI/NFP,
   unusual app metrics, firing Lab rules.
3. **Macro context** (`MODE=daily` only): FRED, Yahoo, Fear & Greed,
   stablecoins and the majors' 20W/50W/200D features, for §5.
4. **Collection**: a summary and every gap.

`context.json` freezes what was collected so §4 resolves against the same
board. If `hyperliquid.metaAndAssetCtxs` is a gap, the board is empty: say so
in the final message, commit nothing, send nothing.

Optional, one call: the platform's intraday signals (near-miss, novelty,
ready opportunities, thesis watch). Read them as extra context for the
watchlist; they are not part of the scan.

```bash
PREV_SIG=$(ls data/signals/????-??-??.json 2>/dev/null | grep -v "$RUN_DATE" | sort | tail -1)
bun run signals:collect ${PREV_SIG:+--prev "$PREV_SIG"} --out data/signals/$RUN_DATE.json || rm -f data/signals/$RUN_DATE.json
```

---

## 3. Read the board

This is the job. Follow the rules section of `board.txt`; on top of it:

- **Read every row, not only the hits.** A tripwire is one-dimensional; the
  useful reads are usually combinations: funding in its 90th percentile on
  a market pressed into its 1d range high while OI builds and the 4h stalls;
  OI rising into a 4h breakdown with funding going negative into a 1w level;
  HL funding 30 points above Binance/Bybit (crowding local to HL); one market
  up while the board is down.
- **Timeframes in order.** 1w sets the context (code uses it for
  alignment), 1d the structure and the levels, 4h the trigger.
- **Near-misses are watchlist material.** Say what would complete them.
- **Outliers may have a cause the board can't see.** You may run up to three
  web searches, only for markets on your watchlist with an unexplained move
  (listing, unlock, exploit, governance, delisting). Prefer sources under
  72 h old. Put what you find in words: a number that is not on the board
  fails the number check.
- **Open setups.** Cancel one when its premise broke before price did
  (funding reset, OI unwound, structure lost), and say what broke. Price
  outcomes (triggered, stopped, target hit, expired) are code's job.

---

## 4. Write the scan, gate it

Write `/tmp/run/scan.json` in the `ScanOutputSchema` shape
(`src/server/routine/schema.ts`; the rules in `board.txt` describe each
field):

```json
{
  "read": "The board leans long into resistance: funding is above neutral on 9 of 31 markets, and HYPE is the most stretched.",
  "watchlist": [{
    "asset": "HYPE", "kind": "crowded_longs", "skew": "down", "timeframe": "1d",
    "note": "Funding 41.2% annualised (7d percentile 96, 30 points over Binance/Bybit), OI +6.1% 24h, mark at 0.92 of the 1d range",
    "arms": "a 4h close back under the 4h range low",
    "evidence": ["HYPE.pos.fundingAnnPct", "HYPE.pos.fundingVsCexAnnPct", "HYPE.tf.1d.rangePos"]
  }],
  "setups": [{
    "asset": "HYPE", "direction": "short", "template": "funding_fade", "timeframe": "4h",
    "imbalance": "crowded_longs",
    "thesis": "Longs pay 41.2% annualised to hold at the 1d range high while OI builds 6.1% in a day; the other side sees a 1w uptrend that has not broken.",
    "trigger": "4h close back under the 4h range low",
    "entry": { "low": { "level": "4h.low20" }, "high": { "level": "4h.low20", "atr": 0.5 } },
    "invalidation": { "level": "1d.high20", "atr": 0.25 },
    "invalidation_reason": "a hold above the 1d range high means the crowding resolved higher",
    "targets": [{ "level": "R", "r": 2 }, { "level": "R", "r": 3 }],
    "conviction": "medium",
    "evidence": ["HYPE.pos.fundingAnnPct", "HYPE.pos.oiChg24hPct", "HYPE.levels.1d.high20"]
  }],
  "passes": [{ "asset": "SOL", "template": "htf_pullback", "direction": "long", "reason": "first target under 2R from the menu" }],
  "cancel": [],
  "brief": "Delta-first: what changed on the board since the last run, what it means, what would prove it wrong."
}
```

Then:

```bash
bun run routine --mode scan --input /tmp/run/scan.json --context /tmp/run/context.json --dry-run
bun run routine --mode scan --input /tmp/run/scan.json --context /tmp/run/context.json --push-out /tmp/run/push.txt | tee /tmp/run/brief.txt
```

- The dry run prints the brief and the would-be files. An input that fails
  the schema exits 1 and names the field.
- Every drop is listed with its rule: `level_missing`, `unbacked_number`
  (thesis, trigger or reason cites a number not on the board), or a gate
  rule (`levels_order`, `zone_width`, `invalidation_distance`, `rr`,
  `duplicate`, `cap_new`, …). Fix the draft and dry-run again, or accept the
  drop: it is in the brief either way.
- A context older than 2 hours is refused: collect again (§2).
- The real run writes `data/setups/ledger.json` (when something moved),
  `data/board/history.json` and `data/board/latest.json`, prints the brief,
  and writes the push text to `push.txt` only when something is new. Code
  owns ids, status, prices, R, alignment, expiry and timestamps.

---

## 5. Daily and weekly extras

**Daily: the first run of `RUN_DATE`** (`MODE=daily` in §2).

1. Read the macro context section of `board.txt` (FRED yields, curve, VIX,
   dollar, oil and Nasdaq; SPY, QQQ, NVDA; Fear & Greed; stablecoin supply;
   the majors' 20W/50W/200D features), and run one live web search for
   scheduled catalysts and active geopolitical tensions. That search is
   mandatory once a day and never served from memory.
2. Write `data/marketstate/{latest,$RUN_DATE}.json` (`MarketStateDataSchema`)
   and `data/sectors/{latest,$RUN_DATE}.json` (`SectorsDataSchema`), both in
   `src/shared/schemas.ts`, the source of truth. Rules:
   - `headline`: the single most important change since yesterday, with its
     number. `tldr` under ~90 words. Rewrite every text field from scratch;
     data older than today names its date.
   - `domains`: exactly `macro, equities, crypto, tech, geopolitics`, in that
     order. Crypto's summary carries the board's read: who leans which way
     and how crowded.
   - `thesis`: `observe` facts only; `infer` the positioning read and the
     main disagreement; `forecast` a labelled base case and at least one
     labelled low-confidence tail case, each with its confirm/break level,
     in the hedge vocabulary below. `disclaimer`, verbatim:
     `"Not financial advice. Market intelligence only — a reasoned read of public data, not a recommendation to buy or sell anything."`
   - `risks`: 2–4 checkable conditions (metric, threshold, direction).
   - Sectors: an emergent taxonomy from the board's OI, funding and moves;
     `tokens` only Hyperliquid symbols on the board or in the live universe
     (case-sensitive); `rotations[]` from/to sector ids with a checkable
     `trigger` and an honest `confidence` (mostly well under 0.7).
   - `latest.json` and the dated file match byte for byte. On a new date add
     one import line and one array entry to `data/marketstate/index.ts` and
     `data/sectors/index.ts`, following the existing lines.
   The same vocabulary applies to setup theses, watchlist notes and the
   brief.

### Hedge vocabulary (carried over verbatim — do not invent substitutes)

Use these terms, exactly, in the `thesis` block:
`base case`, `tail case`, `low-confidence`, `we lean`, `risk skews`,
`consensus is pricing … / we read …`.

A probability may be hedged qualitatively ("a bit above even odds")
but **never** given as a false-precision point estimate ("73%"). Every
forward-looking clause carries a hedge word — no bare future-tense
assertion of a market outcome.

3. Write `data/lab/$RUN_DATE.json`: `{ generated_at, pulse: {<ruleId>:
   {firing, asset, direction}}, catalogue_ids, hl_cycles: {regime_state,
   as_of} }`, from `bun run lab lab_market_pulse --json '{}'` and
   `bun run lab lab_catalogue_list --json '{"live":false}'`. Without a Lab
   read, copy the previous snapshot's `pulse` and `catalogue_ids` and add
   `"note": "lab skipped: <why>"`.

**Weekly: the first run on a Monday** (`RUN_DATE`'s weekday). The Lab CLI
talks to the deployed app because `LAB_URL` is set; **never pass
`--local`**.

1. Search BTC and ETH, long and short:
   ```bash
   M='["cm:CapMVRVCur","cm:NVTAdj","ht:funding","ht:oi","ht:premium","fng:value","llama:stablecoin_cap"]'
   for A in BTC ETH; do for D in long short; do
     bun run lab lab_search --json "{\"asset\":\"$A\",\"direction\":\"$D\",\"metrics\":$M,\"trials\":40}" > /tmp/run/search-$A-$D.json
   done; done
   ```
2. Save only `verdict.level: "robust"`, at most 2 per search:
   `bun run lab lab_catalogue_save --json '{"rule":<rule>,"name":"<short name>","note":"WF <x> / holdout <y> / DSR <z>","runId":"<runId>","origin":"agent"}'`.
   List `candidate`-or-better rules in the brief with the failing number.
3. Prune only `origin: "agent"` rules: `lab_catalogue_health` flags
   `decayed` and `overlaps`; join their ids against `lab_catalogue_list`
   entries for `origin`. Remove (`lab_catalogue_remove {"id":…}`) a decayed
   agent rule, or the lower-Sharpe agent rule of an overlapping pair. Report
   user/seed rules, never remove them.

---

## 6. Validate, commit, push

1. Schema gate:
   ```bash
   bun -e "
   import { LedgerSchema } from './src/server/routine/schema.ts';
   import { ScanRecordSchema } from './src/server/routine/run.ts';
   import { BoardHistorySchema } from './src/server/routine/board.ts';
   import { MarketStateDataSchema, SectorsDataSchema } from './src/shared/schemas.ts';
   import { readFileSync } from 'node:fs';
   const j = (p) => JSON.parse(readFileSync(p, 'utf8'));
   LedgerSchema.parse(j('data/setups/ledger.json')); ScanRecordSchema.parse(j('data/board/latest.json')); BoardHistorySchema.parse(j('data/board/history.json'));
   MarketStateDataSchema.parse(j('data/marketstate/latest.json')); SectorsDataSchema.parse(j('data/sectors/latest.json'));
   console.log('ok');"
   ```
   On a daily run also `cmp` each `latest.json` with its dated copy and
   check the lab snapshot parses.
2. `bun run typecheck && bun test ./src`.
3. Stage only `data/`. Commit, conventional and with no AI attribution:
   `feat(routine): board scan $RUN_DATE` (daily run:
   `feat(routine): board scan + marketstate + sectors + lab $RUN_DATE`).
4. Green → `git push origin master`. Red → push to `routine/$RUN_DATE` and
   name the failing check in the brief; master never goes red from a data
   commit. Non-fast-forward → `git pull --rebase` and push again. If the
   session may only push its own branch (`claude-code/*`), push there and
   open a PR into `master` with `mcp__github__create_pull_request`; the
   `routine-land` workflow merges data-only PRs after typecheck and tests.
   Never merge it yourself or enable auto-merge. Put the PR link in the
   final message. GitHub goes through the `mcp__github__*` tools; `gh` is
   blocked here.

---

## 7. Delivery: one push, only when something is new

`push.txt` is non-empty only when code saw something new: a setup passed the
gate, an open setup changed status or was cancelled, a tripwire hit the last
run did not have, or the daily files were written.

```bash
[ -s /tmp/run/push.txt ] && bun run signals:notify "hypertrade $RUN_DATE" "$(cat /tmp/run/push.txt)"
```

Exactly one push per run, after the commit. If `signals:notify` exits 1, send
the same text once through the session's own push-notification tool, if
there is one, and list the ntfy failure as a gap. Empty `push.txt` → a silent
run: commit, send nothing. No reminders, no follow-ups.

**Final message:** the brief from `/tmp/run/brief.txt`, then one line:
commit sha or branch/PR, whether a push went out, data gaps.

---

## Hard rules

- The hard rule at the top applies everywhere: files, brief, push, final
  message. Never write a setup as an instruction, never size it, never
  mention leverage or execution.
- Write only inside `data/**`. Never edit `src/`, `api/`, `db/` or docs as
  part of a routine run.
- `data/setups/` and `data/board/` change only through `bun run routine`.
- Remove Lab catalogue rules only when `origin` is `"agent"`.
- No orders, no signing keys, no Desk calls (`src/server/desk/*` is out of
  scope). App reads are GETs; the Lab calls in §5 write to the Lab.
- Never print or log `LAB_API_TOKEN`, `DATABASE_URL` or `NTFY_TOKEN`.
- If a tool or hook blocks something this runbook needs, stop and report the
  block. Don't route around it.

## Repository map (background only)

- `src/server/routine/`: `board.ts` (features, level menu, history),
  `tripwires.ts`, `scan.ts` (level resolution, number check), `gate.ts`,
  `ledger.ts`, `prompts.ts` (the scan rules), `run.ts` (orchestration),
  `collect.ts` (every fetch), `signals.ts`.
- `data/board/`: `history.json`, `latest.json`. `data/setups/`:
  `ledger.json`, `htf.json`. `data/marketstate/`, `data/sectors/`: `latest.json`,
  dated copies, `index.ts`. `data/lab/`: dated snapshots. `data/signals/`.
- Background: `docs/fallback-routine.md` (the pipeline), `docs/SPEC.md`,
  `docs/LAB.md`.
