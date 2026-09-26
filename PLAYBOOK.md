# PLAYBOOK — the comeback, operationalized

Written 2026-09-26. This is the operator's contract with himself. Hypertrade
exists to hold a goal, a journal and a strategy so the operator stays sane
and in check. This file is the part of that which is not code.

Rules for this file: it gets edited on Sundays only (the weekly review), and
every number in it is either filled in or marked `TBD`. Nothing here is a
wish. It is either a rule, a fact, or a date.

---

## 0. Where things actually stand (2026-09-26)

Facts, not feelings.

- **App**: hypertrade is built and deployable (TASKS V1 closed). V2
  (Supabase + Vercel provisioning) is still open. The MarketState and Sector
  data in the app is the 2026-08-30 seed. No routine has ever committed real
  data to `data/`.
- **Routines** (8 total, 4 alive):
  - Alive: Rental Pipeline Málaga (daily), The Weekly Tape (Wed), Market
    State (Sun/Wed/Fri), Techstars 2027 check (one-shot, Jan 2027).
  - Market State fires with the prompt "Read CLAUDE.md" but this repo has no
    CLAUDE.md, so it runs three times a week and produces nothing the app
    can show. Either give it ROUTINE.md as its prompt or pause it.
  - Dead or paused: Email cleanup (paused, last run failed), Atlas (paused,
    travel), two one-shot reminders whose sessions are gone.
- **Job search**: no routine, no tracker. Job alerts (XING, Joinrs,
  Glassdoor Málaga) land in Gmail under the Job Alerts label and stay
  unread. One voices.com gig invite ($375, Spanish voice data, deadline
  Sep 30) is open.
- **Trading**: no journal, no written strategy, no prop evaluation started.
- **Life**: Málaga, remote software freelancer, room search in flight for
  Oct 1 move-in.

The gap between "state of being aspired to" and now is not a trade away. It
is a job, a written edge, and a journal that gets filled in every day. The
rest of this file is those three things.

---

## 1. The goal state

Two numbers and one sentence. Fill them in once, then stop re-deciding them.

| | Value | By |
|---|---|---|
| Net worth target | TBD | TBD |
| Monthly income floor (job or contracts) | TBD | 2026-12-31 |
| State of being (one sentence) | TBD | |

The net worth number is the destination. The income floor is what makes the
destination reachable without gambling for it. Everything in trading below
is sized so that a bad quarter of trading cannot touch the income floor.

---

## 2. Three tracks, one calendar

Every weekday has the same shape. The order is deliberate: the thing that
pays the rent goes first, the thing that feels like the comeback goes last.

| Block | Track | Time box | Done when |
|---|---|---|---|
| Morning | Income (job / contracts) | 90 min | Quota hit (§3) |
| Midday | Build (hypertrade or client work) | 3–4 h | Commit pushed |
| Late afternoon | Edge (trading) | 60 min max | Journal entry written, charts closed |
| Evening | Nothing market-related | | |

Sunday: 45 minutes, weekly review (§6). No trading, no applications.

The 60-minute cap on trading is the single most important rule in this
file. The obsession does not get an open-ended block.

---

## 3. Income track (job)

Profile: 26, Málaga, remote software (TypeScript/React/Bun/Hono, Postgres,
Python, quant/crypto tooling, LLM integration). Portfolio piece: this repo
plus hypertrade.space.

Targets, in order of preference:

1. Remote full-stack / backend TypeScript roles at fintech, crypto infra, or
   data/analytics companies (EU time zones). Alan (via Joinrs) is one such
   lead already in the inbox.
2. Contract work: quant tooling, trading dashboards, LLM-backed analysts.
   The Analyst feature in this repo is the demo.
3. Local hybrid roles in Málaga tech (Glassdoor alerts are already flowing).

Daily quota, weekday mornings (90 min):

- Read every Job Alerts email from the last 24 h. Trash or archive all of
  them once read.
- 2 tailored applications, or 1 application plus 1 outreach message to a
  person at a target company.
- Log each one in `data/jobs/applications.json` (§7 schema). No log entry,
  it did not happen.

Weekly: 10 applications or outreach messages minimum. Track reply rate. If
reply rate is under 5% after 3 weeks, the CV or the target list is wrong,
not the market. Rewrite one of them.

Open now:

- voices.com private invite, $375, Spanish (Spain) voice data. Deadline
  Sep 30. Take it or decline it by Sep 28. Small, real, this week.
- Alan Fullstack Software Engineer (Joinrs, Sep 19). Apply or archive by
  Sep 29.
- Techstars / ABN AMRO Future of Finance 2027: the routine will fire Jan 15.
  Until then Hyperion is a side story, not the plan.

Reactivate the Email cleanup routine only after its last failure is
understood. Until then, inbox triage is manual and part of the quota.

---

## 4. Edge track (prop trading framework)

### 4.1 Why a prop evaluation and not own capital

A funded account is capped-downside, rules-enforced trading. The rules do
the letting go for you: when the daily loss is hit, the platform closes
you out. That is the point. The evaluation fee is the only capital at risk.

Target firm: Breakout (breakoutprop.com). Current published terms
(checked 2026-09-26; re-verify before purchase):

| Plan ($100K) | Fee | Profit target | Max daily loss | Max drawdown (static) |
|---|---|---|---|---|
| Turbo | $330 | 9% | 3% | 3% |
| Pro | $545 | 12% | 3% | 5% |
| Classic | $800 | 10% | 3% | 6% |

Leverage 5x on BTC/ETH/XYZ100, 2x elsewhere. Fees 0.04% per side. No
minimum days, no time limit, no holding limits. Fee is non-refundable and
the firm earns on failed re-purchases. The firm's own disclosure says most
applicants fail first attempt.

Start with **Classic** when the gate below opens. Widest drawdown buffer.
The cheaper Turbo is a harder test dressed as a discount.

### 4.2 The gate (no evaluation purchase until all four are true)

1. 30 consecutive trading days journaled under the exact Breakout rules
   (3% daily, 6% total, static from starting balance) on a paper account
   sized at $100K.
2. Zero rule breaches in those 30 days. One breach resets the count.
3. Journaled expectancy ≥ +0.25R per trade over ≥ 40 trades.
4. The income track quota was hit in at least 4 of the last 5 weeks.

Rule 4 is not about trading. It is the anti-obsession clause: the
evaluation is bought with a life that is already working, not instead of
one.

Earliest possible purchase date: 2026-11-09 (30 trading days from Sep 29).

### 4.3 Risk math (fixed, derived from the rules)

Starting balance $100K, all numbers in account %.

| Parameter | Value | Why |
|---|---|---|
| Risk per trade (1R) | 0.5% ($500) | 6 full losers to hit the daily limit; we stop long before that |
| Max trades per day | 3 | Worst day = −1.5%, half the daily limit |
| Daily stop | −1.5% (3R) | Hard. Close the platform. Journal. |
| Weekly stop | −3% (6R) | Hard. No trading until Monday. |
| Max drawdown budget | 4% of the 6% | The last 2% is never ours to spend |
| Minimum reward:risk at entry | 2:1 | Below this, no trade, whatever the read |
| Position sizing | size = 0.5% / stop distance % | Stop is set first, size is derived. Never the reverse |

Expectancy needed to pass: target 10% = 20R. At 45% win rate and 2R
average winner, expectancy is +0.35R per trade, so roughly 60 trades. At
3 trades/day max that is a month of full days, realistically two to three
months. Passing in a week means the sizing rules were broken.

### 4.4 The one setup

One setup, one timeframe, one universe. Nothing else gets traded until 100
journaled trades exist for this one.

- **Universe**: BTC, ETH, SOL, HYPE perps only. The 5x/2x leverage split
  and liquidity make these the only names where the risk math holds.
- **Timeframe**: 4H for direction, 1H for entry. No timeframe below 1H.
- **Regime filter** (from hypertrade, not from vibes): 4H close above the
  20-period EMA and the MarketState headline not reading risk-off = longs
  only. Below and risk-off = shorts only. Mixed = no trades that day.
- **Funding filter** (HL `metaAndAssetCtxs`): do not go long when the
  coin's 8h funding is in the top decile of the last 30 days; do not go
  short when it is in the bottom decile. Crowded side is the wrong side.
- **Entry**: pullback to the 1H 20 EMA in the direction of the 4H regime,
  confirmed by a 1H close back in trend direction. Limit order at the
  close, not a chase.
- **Stop**: beyond the pullback swing low/high plus 0.3× ATR(14, 1H).
  Set before the entry order.
- **Target**: 2R fixed. Half off at 2R, stop to breakeven, remainder
  trails the 1H 20 EMA. Simple on purpose.
- **Sessions**: entries only between 08:00 and 18:00 Europe/Madrid. No
  entries in the hour around scheduled macro prints (the geopolitics
  domain in MarketState lists them).
- **No-trade days**: daily/weekly stop hit; regime mixed; fewer than 6
  hours of sleep; any day the income quota was skipped.

This setup is deliberately boring. The edge, if there is one, is in the
regime and funding filters plus the risk math, not in the entry.

### 4.5 Letting go, as rules

The obsession problem restated as things a platform can enforce:

- The platform closes at the daily stop. Not "one more".
- Charts are closed outside the 60-minute block. Phone app uninstalled
  during the paper phase.
- A trade with no journal entry within 10 minutes of close counts as a rule
  breach.
- No changes to §4.3 or §4.4 except on a Sunday, in writing, with the
  journal stats that justify the change.
- The 2% of drawdown that is "never ours" is also never ours in the
  evaluation. If the account is ever at −4%, stop, and start a new paper
  count. Do not trade the last 2% to get it back. That is the exact
  behavior that lost the last opening.

---

## 5. Sanity track (journal)

Daily, end of the trading block, five lines. Stored in
`data/journal/YYYY-MM-DD.json` (§7). Hypertrade renders it later; the
file exists first.

1. Income: quota hit? (yes/no + count)
2. Build: what got pushed?
3. Trades: count, R result, breaches (0 or the list)
4. State: one word for the day, one sentence on what pulled hardest
5. Tomorrow: the one thing

Missing a day is not a crisis. Two missed days in a week is a Sunday
agenda item.

---

## 6. Weekly review (Sunday, 45 min)

1. Fill the week's row in the table below.
2. Read the journal's five-line entries in one pass.
3. Check the four gate conditions (§4.2).
4. Decide the one change for next week. One. Write it here.
5. Touch nothing else.

| Week of | Apps/outreach | Replies | Trades | Net R | Breaches | Gate days | One change |
|---|---|---|---|---|---|---|---|
| 2026-09-28 | | | | | | 0/30 | |

---

## 7. Data files the app will read

Kept next to the routine-written data so hypertrade can render them once
`/journal` and `/jobs` routes exist (TASKS T13). Shapes are the contract.

`data/journal/YYYY-MM-DD.json`

```json
{
  "date": "2026-09-28",
  "income": { "quota_hit": true, "applications": 2, "outreach": 0 },
  "build": "pushed PLAYBOOK.md, opened PR",
  "trades": [
    { "coin": "BTC", "side": "long", "r": 2.0, "setup": "4h-pullback", "breach": null }
  ],
  "net_r": 2.0,
  "breaches": [],
  "state": { "word": "steady", "pull": "wanted a fourth trade at 17:40" },
  "tomorrow": "reply to Alan"
}
```

`data/jobs/applications.json`

```json
[
  {
    "date": "2026-09-28",
    "company": "Alan",
    "role": "Fullstack Software Engineer",
    "source": "joinrs",
    "channel": "application",
    "status": "sent",
    "next_action": "follow up 2026-10-05",
    "notes": ""
  }
]
```

---

## 8. Routine hygiene (do once, this week)

- Market State: either set its prompt to "Read ROUTINE.md and follow it"
  in this environment, or pause it. Right now it burns three runs a week
  for nothing.
- Delete the two dead one-shots (provenance PR re-check, tempo-deck scan).
- Leave Atlas paused. Leave Email cleanup paused until its failure is read.
- Add one routine: **Sunday Review**, `CRON_TZ=Europe/Madrid 10 9 * * 0`,
  fresh session in this environment, prompt: read PLAYBOOK.md §6, read the
  week's `data/journal/*.json`, compute the row, push a PR that fills it
  in, and send a push notification with the gate count and the one change.

---

## 9. First week (Sep 28 – Oct 4)

Mon 28: voices.com decision. First journal entry. Paper account opened at
$100K with Breakout rules written on a card next to the screen.
Tue 29: Alan application or archive. 2 more applications.
Wed 30: Weekly Tape lands; read it once, that is the regime input for the
week. Voices.com deadline.
Thu 1: Move-in day if the rental lands. Half quota is fine. No trading.
Fri 2: Routine hygiene (§8).
Sun 4: First weekly review. Fill the row. Gate count should read 4/30 or
5/30.

That is the whole week. Small, countable, and none of it is the one trade
that makes it all back, because that trade does not exist.
