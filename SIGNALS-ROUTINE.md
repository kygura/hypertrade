# SIGNALS-ROUTINE.md — hypertrade signal-pipeline routine

Runbook for the **second scheduled routine**: a stateless Claude Code cloud
session that reads the signal pipeline (near-misses, novelty, ready
opportunities, thesis watch, Lab ideas), commits `data/signals/YYYY-MM-DD.md`
plus `.json`, pushes, and sends **at most one** ntfy push. It is separate from
`ROUTINE.md` (market state, sectors, setups) and never touches that
routine's files.

If you were opened for ordinary development work, this file is not your task.
Don't touch `data/**` unless asked.

**Hard rule, same as ROUTINE.md:** market intelligence, not financial advice.
Informational only. This routine never gates, approves, rejects or places
anything, never recommends a trade, never sizes, never mentions leverage.
Every forward-looking clause carries a hedge word; never state a future
outcome as fact. Hedge vocabulary (verbatim from ROUTINE.md §4.2): `base
case`, `tail case`, `low-confidence`, `we lean`, `risk skews`, `consensus is
pricing … / we read …`. No false-precision probabilities.

---

## 1. Setup

1. `git checkout master && git pull --ff-only` on `kygura/hypertrade`; `bun install --frozen-lockfile`.
2. `RUN_DATE=$(TZ=Atlantic/Canary date +%F)`, captured once. Every dated file uses it.
3. Previous state is the last committed file, the only memory:
   `PREV=$(ls data/signals/????-??-??.json 2>/dev/null | grep -v "$RUN_DATE" | sort | tail -1)`.
   None = first run; everything counts as new for the last 24 h.
4. Environment: `APP_URL` (the always-on backend origin) and `LAB_API_TOKEN`
   (read bearer). If either is missing, say so in one line and stop; no push.
   Never print the token.

## 2. Collect (one deterministic call)

```bash
mkdir -p data/signals
bun run signals:collect ${PREV:+--prev "$PREV"} --out data/signals/$RUN_DATE.json
```

The script writes the file itself (temp file + rename), so a failed run leaves
no partial JSON. If it exits non-zero, `rm -f data/signals/$RUN_DATE.*` and
stop; a broken file committed now would become next run's `--prev`.

Prints one JSON (`src/server/routine/signals.ts` assembles it from the
server's own endpoints and stores; no logic is duplicated here):

| Key | Source | Meaning |
|---|---|---|
| `nearMiss` | `GET /api/platform/near-miss` | `top` and up to 5 `all`: coin, setup kind, failed condition index, `value` vs `limit`, `relDistance` |
| `novelty` | `GET /api/platform/novelty` | `NOVEL:` entries detected since `since`; `kind` `new_extreme` or `joint_extreme`, `families`, `features`, `nearSetups` |
| `ready` | `GET /api/platform/opportunities?status=ready` + detail | each with its PS4 `evidence` line (n · clusters · interval · edge basis) |
| `thesisWatch` | `GET /api/intel/theses` history | premises whose latest check turned `contradicted`/`triggered` after a good one at the previous run |
| `lab` | Lab trial log (needs `DATABASE_URL`) | `trials` = authored ideas since the last run, each with its `rule` (`lab_event_study` rows are screens, not ideas); `universe` = `PLATFORM_MY_MARKETS`; `trials: null` = log not reachable |
| `changes`, `changed` | diff vs `--prev` | what is new; `changed: false` means nothing to report |

A section that cannot be read does not abort the run: it is listed in
`gaps: [{source, code}]` (e.g. `HTTP 503`), contributes nothing new, and keeps
the previous run's value so it is not mistaken for a change. An unreadable
`--prev` is a gap too (`source: "prev"`); the run then treats everything as new.
Report each gap with its code; don't fill it from memory. If `gaps` covers every
platform section (worker down, 503), say so and send no push.

### Lab screens for authored ideas

For each `lab.trials[]` entry that carries a `rule`, screen that rule on my
markets:

```bash
bun run lab lab_event_study --json '{"rule":<trial.rule>,"mine":true,"stopAtr":1.5,"targetAtr":3}'
```

(needs `LAB_URL=$APP_URL`; never `--local`). Report `verdict`
(`insufficient`/`rejected`/`clear`, a reject-only screen: `clear` is never
evidence of an edge) and the funnel bottleneck (`funnel.steps[funnel.bottleneck]`:
the condition where most coin-days die). Older trials (logged before the rule was stored) have no `rule`: list them as
"not screenable (no rule logged)" with their logged verdict. The screens add `lab_event_study` rows to the log; they are
excluded from next run's idea list on purpose.

## 3. Write `data/signals/$RUN_DATE.md`

Rewrite from scratch each run; never append. Sections appear only when they
have content, in this order. Every line: item, numbers, hedge word, source.

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

Carry the evidence line and screen verdicts verbatim; they already say
`unvalidated` / `rejected` / `clear` honestly. Do not upgrade them.

## 4. Validate, commit, push

1. `bun run typecheck && bun test ./src`. JSON must parse; `.md` must exist.
2. Stage only `data/signals/**`. Commit:
   `feat(signals): signals snapshot $RUN_DATE`. No co-author or AI attribution lines.
3. `git push origin master`; non-fast-forward → `git pull --rebase`, push again.
   If the session may only push a branch, push it, open a PR into `master`
   with `mcp__github__create_pull_request` and `mcp__github__enable_pr_auto_merge`;
   never merge it yourself. `gh` is blocked.
4. Red check → push to `signals/$RUN_DATE`, name the failing check in the final message.

## 5. Delivery: one ntfy push, or none

The channel is ntfy through the desk notifier (`createNotifier`,
`src/server/desk/notify.ts`). Only `NTFY_TOPIC` (plus optional `NTFY_SERVER`,
`NTFY_TOKEN`) must be set; Telegram is not used here.

- `changed: false` → **silent run**: commit the files, send nothing.
- `changed: true` → exactly one push, after the commit succeeds:

```bash
bun run signals:notify "signals $RUN_DATE" "<≤ 6 short lines>"
```

Body: top near-miss (`COIN setup: cond failed by X%`), each new `NOVEL:`
(coin, kind), ready opportunities added with their evidence line, broken
premises, new Lab ideas with screen verdict. Hedged, facts first, no
instructions. No retries beyond one; `signals:notify` exits 1 when no channel accepted the push; that is a one-line gap in the
final message, never a reason to push again. No reminders, no follow-ups.

## Final message

Two to four lines: commit sha or branch, `changed` yes/no, whether a push went
out, data gaps. Not the full report; that is the `.md`.

## Hard rules

- The top-of-file hard rule applies to the `.md`, the push and the final message.
- Write only `data/signals/**`. Never edit `src/`, `api/`, `db/`, docs, or the other routine's `data/` folders.
- No orders, no signing keys, no Desk calls. Read-only GETs plus `lab_event_study`, which is not read-only: each screen appends one row to the Lab trial log.
- Never print `LAB_API_TOKEN`, `DATABASE_URL` or `NTFY_TOKEN`.
- If a hook or tool blocks something this runbook needs, stop and report it. Don't route around it.
