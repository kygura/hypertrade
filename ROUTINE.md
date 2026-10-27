# ROUTINE.md — hypertrade routines

Runbook for the scheduled Claude Code cloud sessions. If you were opened for
ordinary development work, this file is not your task: use `docs/SPEC.md`,
`docs/design/README.md` and `docs/LAB.md`, and leave `data/**` alone.

## Why a session with a codebase

A cron job can fetch and threshold. A chat can interpret. A session holding
this repo can do both and one more thing: it reads its own past output from
git, grades it with the repo's code, and changes the code when the grades say
so. Every routine below leaves a file the next one reads. That loop is the
point; a routine that writes nothing a later routine reads does not belong
here.

```
 board (4h) ──setups──▶ ledger ──closed──▶ post-mortem (daily) ──lessons──▶ playbook
    ▲                                                                        │
    └──────────────── read before every board run ◀──────────────────────────┘
 journal (weekly) ──your fills vs the ledger──▶ playbook "Operator" section
 review (weekly) ──graded templates, Lab rules──▶ catalogue + data/review/
 tune (monthly) ──evidence from review──▶ one PR to src/server/routine/ (human merges)
```

Code measures, you judge, code grades you. Prices, R, status, gate decisions,
event-study verdicts and Lab statistics come from code. You never type a
price or a statistic that a command did not print.

## Dispatch

The trigger prompt may name a routine (`run ROUTINE.md: review`). If it does,
run that one. If not, pick by the clock in `Atlantic/Canary`, first match wins:

| When | Routine | Section |
|---|---|---|
| prompt names one | that routine | |
| 1st Monday of the month, first run of the day | tune, then board | §6, §1 |
| Monday, first run of the day | review, then board | §5, §1 |
| Sunday, first run of the day | journal, then board | §4, §1 |
| first run of the day | daily, then board | §2, §1 |
| otherwise | board | §1 |

"First run of the day": no `data/marketstate/$RUN_DATE.json` yet. On-demand
only, never scheduled: **check** (§7).

## 0. Preflight (every routine)

1. **Environment** (cloud environment secrets): `LAB_API_TOKEN` (read bearer
   for `/api/lab`, `/api/intel`, `/api/platform` GETs), `NTFY_TOPIC` (optional
   `NTFY_SERVER`, `NTFY_TOKEN`), `DESK_WATCH_ADDRESS` (your HL account, for
   §4). There is no database route from a cloud session; everything is HTTPS.
   ```bash
   export APP_URL="${APP_URL:-https://hypertrade-ten.vercel.app}"
   export LAB_URL="${LAB_URL:-$APP_URL}"
   RUN_DATE=$(TZ=Atlantic/Canary date +%F)   # once, at start; every dated file uses it
   mkdir -p /tmp/run
   ```
   A missing secret skips the parts that need it and is named as a gap in
   the final message. Never print a secret.
2. **Checkout.** `git checkout master && git pull --ff-only`, then
   `bun install --frozen-lockfile`.
3. **Read the playbook.** `data/playbook.md`, every time, before anything
   else is written. It is what earlier runs learned. If it does not exist,
   create it from the template in §8.

## 1. Board (every 4 h)

Find where positioning is imbalanced on the top Hyperliquid perps and turn
the clean ones into conditional setups that code gates and grades.

```bash
MODE=scan; [ -f data/marketstate/$RUN_DATE.json ] || MODE=daily
bun run routine --mode $MODE --collect-only --context /tmp/run/context.json > /tmp/run/board.txt
```

`board.txt` opens with the scan rules. They are the contract for
`scan.json`, including the gate; where they disagree with this file, they
win. Then one row per market (4h/1d/1w structure, funding vs its own week
and vs Binance/Bybit, OI change, premium, relative strength, the level
menu), tripwire hits and near-misses, open setups, last run's watchlist,
upcoming FOMC/CPI/NFP and firing Lab rules. If `hyperliquid.metaAndAssetCtxs`
is a gap the board is empty: stop, commit nothing, send nothing.

How to read it:

- Price, OI and funding together, across 1w (context), 1d (structure and
  levels), 4h (trigger). A single reading is not a read.
- Every row, not only the hits. Near-misses go on the watchlist with what
  would complete them.
- **Apply the playbook.** If a lesson covers a market or template on the
  board, the setup or pass cites it by its id (`L3`). A lesson you override
  is named with the reason.
- Up to three web searches, only for watchlist markets with a move the board
  cannot explain (listing, unlock, exploit, delisting). Findings go in words:
  a number not on the board fails the number check.
- Cancel an open setup when its premise broke before price did, and say
  what broke. Price outcomes are code's.

Write `/tmp/run/scan.json` (`ScanOutputSchema`, `src/server/routine/schema.ts`),
levels by menu key only, then:

```bash
bun run routine --mode scan --input /tmp/run/scan.json --context /tmp/run/context.json --dry-run
bun run routine --mode scan --input /tmp/run/scan.json --context /tmp/run/context.json --push-out /tmp/run/push.txt | tee /tmp/run/brief.txt
```

The dry run names every drop and its rule. Fix and dry-run again, or accept
the drop. A context older than 2 h is refused: collect again. Standing aside
on a board of 30+ markets for days is a failure mode, not caution; a setup
is a hypothesis with an invalidation, and the ledger grades it.

Writes (through code only): `data/board/{latest,history}.json`,
`data/setups/ledger.json`.

## 2. Daily (first run of the day)

**2a. Market state and sectors.** The `MODE=daily` board adds a macro
section (FRED, equities, Fear & Greed, stablecoins, the majors' 20W/50W/200D).
Run one live web search for today's scheduled catalysts and live geopolitical
risks; never from memory. Write `data/marketstate/{latest,$RUN_DATE}.json`
(`MarketStateDataSchema`) and `data/sectors/{latest,$RUN_DATE}.json`
(`SectorsDataSchema`), both in `src/shared/schemas.ts`. `headline` is the one
change since yesterday that matters, with its number. `risks` are checkable
(metric, threshold, direction). Sector `tokens` are HL symbols only. The
latest and dated copies are byte-identical; on a new date add one import and
one entry to each `data/*/index.ts`. Forecasts say "base case" / "tail case"
and give no point probabilities.

**2b. Lab snapshot.** `data/lab/$RUN_DATE.json` from
`bun run lab lab_market_pulse --json '{}'` and
`bun run lab lab_catalogue_list --json '{"live":false}'`
(`{generated_at, pulse, catalogue_ids, hl_cycles}`). Without the Lab, copy
the previous snapshot with `"note": "lab skipped: <why>"`.

**2c. Post-mortems.** For every setup in `ledger.json` `closed[]` not yet
reviewed (its id appears in no `data/review/postmortems/*.md`), code first:

```bash
bun run review:postmortem > /tmp/run/closed.jsonl
```

One line per setup: status, R, conviction, and `maeR` / `mfeR`, the worst and
best excursion while triggered, in R from the entry midpoint
(`src/server/routine/review.ts`). Empty output: nothing to review.

Then append one entry per setup to `data/review/postmortems/$(date +%Y-%m).md`:

```markdown
### XMR-long-20261027-1 · htf_pullback · target_hit · +2.0R · MAE 0.4R / MFE 2.3R
- Premise: <the thesis, one line>
- What happened: <which part of the premise held or broke, from the board rows since>
- Missed or got right: <the one thing the read should repeat or avoid>
- Lesson: L3 (+1) | new: <candidate lesson> | none
```

MAE/MFE in R is the useful part: a winner that sat at −0.9R first was a bad
stop that got lucky; a loser that reached +1.5R first was a missing partial.

**2d. Playbook.** Fold the day's post-mortems into `data/playbook.md` (§8):
increment a lesson's evidence when a post-mortem supports it, add a lesson
only when two post-mortems agree, retire one that a post-mortem contradicts
twice. Edit in place; the file stays under ~120 lines.

## 3. Delivery and landing (every routine)

1. Validate what you touched:
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
   bun run typecheck && bun test ./src
   ```
2. Data routines stage only `data/`. Commit `feat(routine): <routines> $RUN_DATE`,
   no AI attribution. Push to `master`; red checks go to `routine/$RUN_DATE`
   instead and the brief names the failure. A session limited to its own
   `claude-code/*` branch opens a PR into `master` with
   `mcp__github__create_pull_request`; `routine-land` merges data-only PRs
   after typecheck and tests. Never merge it yourself. `gh` is blocked; use
   the `mcp__github__*` tools.
3. One push per session, after the commit, only when something is new:
   ```bash
   [ -s /tmp/run/push.txt ] && bun run signals:notify "hypertrade $RUN_DATE" "$(cat /tmp/run/push.txt)"
   ```
   `push.txt` is written by the board when a setup passed, changed status or
   a tripwire hit is new. Review, journal and tune append one line each to
   it (§5–§6). Empty → silent run. If ntfy fails, use the session's own push
   tool once and name the gap.
4. Final message: the brief, then one line: commit sha or PR link, push
   sent or not, gaps.

## 4. Journal (Sunday)

Compare what you traded with what the board proposed. Needs `DESK_WATCH_ADDRESS`.

```bash
bun run review:journal > /tmp/run/trips.json
```

Code gave you round trips (entry, exit, size, net PnL, fees) over 30 days;
`recent` are the ones closed in the last 7. You:

1. Tag each `recent` trade with one of `SETUP_TAGS`
   (`src/server/intel/journal.ts`) and match it to a ledger setup on the same
   asset and side within its life, or to none.
2. Write `data/review/journal/$RUN_DATE.md`: matched trades vs the setup
   (entered inside the zone? stop where the invalidation was? exited at a
   target or early?), unmatched trades (what they were), setups you skipped
   that hit target, and two numbers per tag: count and net PnL. No dollar
   totals beyond what `trips.json` holds.
3. Update the playbook's **Operator** section: a pattern needs 3 trades
   (`FINDING_MIN_TRADES`). "Exits before the first target on 4 of 5 matched
   longs" is a pattern; one bad trade is not.
4. One line to `push.txt` only if an Operator entry was added or changed.

## 5. Review (Monday)

Grade the machinery, not the market.

1. **Templates.** For each tripwire template in `src/server/routine/tripwires.ts`
   that has a Lab rule twin or can be written as one, run
   `bun run lab lab_event_study --json '{"rule":<rule>,"stopAtr":1.5,"targetAtr":3,"mine":true}'`.
   Record verdict (`rejected` / `clear` / `insufficient`), weeks, train and
   holdout mean R. Never pass `--local`.
2. **Ledger by template and conviction.** From `ledger.json` closed setups
   and the post-mortems: count, hit rate, mean R, mean MAE/MFE in R, per
   `setup_id` and per `conviction`. If "high" does not beat "low" on mean R
   over 10+ closed setups, conviction is noise; say so.
3. **Lab search from hypotheses.** Take at most two candidate lessons from
   the playbook or the post-mortems and turn each into a rule:
   `bun run lab lab_author_rule --json '{"intent":"<the lesson in words>","asset":"BTC"}'`,
   then `lab_event_study` on the best candidate. Save to the catalogue only
   `verdict.level: "robust"` (`lab_catalogue_save`, `origin: "agent"`, note
   with WF / holdout / DSR). Quote the trial count (`idea #n of N`) next to
   every result. This replaces a fixed weekly metric grid: each search tests
   something the ledger raised.
4. **Prune.** `lab_catalogue_health`: remove `origin: "agent"` rules that are
   decayed or the weaker of an overlapping pair. Report user and seed rules,
   never remove them.
5. Write `data/review/weekly/$(date +%G-W%V).md`: the template table, the
   ledger table, the searches with trial counts, catalogue changes, and a
   **Tune candidates** list: each item a code change (threshold, template,
   gate rule) with the evidence row that supports it. One line to `push.txt`.

## 6. Tune (first Monday of the month)

The only routine that touches code, and the reason this runs as a session
with the repo instead of a cron job.

1. Read the last four `data/review/weekly/*.md`. A tune candidate qualifies
   when it shows up in at least two of them, with evidence: an event study
   `rejected`, a template at negative mean R over 10+ closed setups, a gate
   drop rule that discards most proposals while the dropped ones would have
   worked (check against candles), or a playbook lesson with 5+ supporting
   post-mortems that a threshold could encode.
2. Pick **one**. Branch `tune/$RUN_DATE`, change `src/server/routine/`
   (tripwires, gate, scan prompt), and add or update the test that pins the
   new behaviour. Done gate from `CLAUDE.md`: `bun run typecheck`,
   `bun test ./src`, `bun run check:api`, `bun run build`.
3. Open a PR into `master`: the evidence rows quoted from the weekly files,
   what changes, what would show it was wrong. `routine-land` does not merge
   it (it touches `src/`); you review and merge. One PR open at a time: if a
   tune PR is still open, comment the new evidence on it instead.
4. One line to `push.txt` with the PR link.

Nothing qualifies → write that in the weekly file and open nothing.

## 7. Check (on demand)

Run when the prompt is `run ROUTINE.md: check <ASSET> <long|short> [idea]`.
Read-only: commits nothing, pushes nothing.

1. The asset's board row: `bun run routine --collect-only` and read its line,
   tripwires and level menu.
2. Liquidation map and crowding: `GET $APP_URL/api/platform/liqmap?coin=<ASSET>`
   with `Authorization: Bearer $LAB_API_TOKEN`; upcoming catalysts from the
   board's calendar lines.
3. The idea as a rule: `lab_author_rule` with the idea, then `lab_event_study`
   on the best candidate. Quote verdict, weeks and the trial count.
4. The playbook lessons and Operator entries that apply.
5. Answer in five lines: the strongest case for, the strongest case
   against, the level that invalidates it (from the menu), what the Lab says
   with its trial count, which of your own patterns this trade risks.

## 8. Playbook format

`data/playbook.md` is the only file every routine reads. Keep it short; it
is a working set, not an archive (the post-mortems are the archive).

```markdown
# Playbook

## Lessons
- **L1** · funding_fade · Fades of HL-only crowding (HL funding 20+ pts over CEX) worked; fades of crowding shared with Binance/Bybit did not. · evidence: 4 (XMR-short-…, …) · since 2026-11-02
- **L2** · all · 4h triggers fired within 2 bars of FOMC were stopped 3 of 3. · evidence: 3 · since …

## Operator
- **O1** · Exits before the first target on matched longs: 4 of 5. · since …

## Retired
- **L0** · <lesson> · contradicted by <ids> on <date>
```

Rules: every lesson cites setup or trade ids; at most 15 lessons and 8
Operator entries (retire the weakest to add one); a lesson with no new
evidence in 45 days is retired. The board cites lessons by id, so ids are
never reused.

## Hard rules

- Prices, statistics, status and gate decisions come from code. If a number
  is not in a command's output, it does not go in a file.
- Data routines write only under `data/`. `data/setups/` and `data/board/`
  change only through `bun run routine`. Only §6 edits code, on its own
  branch, through a PR a human merges.
- No orders and no Desk writes from any routine.
- Remove Lab catalogue rules only when `origin` is `"agent"`.
- Never print `LAB_API_TOKEN`, `DATABASE_URL`, `NTFY_TOKEN` or the watch
  address.
- If a tool or hook blocks a step, stop that step and report it. Don't route
  around it.

## Map

- `src/server/routine/`: `board.ts`, `tripwires.ts`, `scan.ts`, `gate.ts`,
  `ledger.ts`, `prompts.ts`, `run.ts`, `collect.ts`. Pipeline background:
  `docs/fallback-routine.md`.
- `src/server/routine/review.ts` (`bun run review:*`): post-mortem and
  journal facts, on `src/server/intel/journal.ts` round trips and excursions.
- Lab tools: `bun run lab <tool> --json '<args>'`; contract in `docs/LAB.md`.
- `data/board/`, `data/setups/`, `data/marketstate/`, `data/sectors/`,
  `data/lab/`, `data/review/{postmortems,journal,weekly}/`, `data/playbook.md`.
