# PROP.md — hypertrade prop-trading contract

This file is the operating contract for trading a **Breakout** evaluation
(and, if passed, a funded Breakout Account) with hypertrade as the journal,
regime reader and rule enforcer. It sits next to ROUTINE.md (what the cloud
routine produces) and SPEC.md (what the app does). ROUTINE.md's hard rule
still holds for the routine: it produces market intelligence, never trade
calls. This file is where the operator's own trading rules live, so the app
can hold the operator to them.

**Why this exists.** The last account was lost by not letting go: no written
goal, no stop on the account, no stop on the day, no third party holding the
line. A prop evaluation is the cheapest way to buy that third party. The fee
is the only real money at risk; the firm enforces the two limits the operator
could not enforce alone. The point of the first evaluation is not the payout.
It is a clean, externally verified record of trading inside limits for as
long as it takes to hit the target.

**Hard rule.** Nothing in this file is a prediction. Every setup below is a
hypothesis until the journal says otherwise (§(f)).

---

## (a) The rule set being traded against

Source: breakoutprop.com/program-rules (updated 2026-07-29), pricing page and
firm blog, read 2026-09-26. Re-read before purchase — terms move.

| Plan (1-Step) | Profit target | Max daily loss | Max drawdown (static) |
|---|---|---|---|
| Classic | 10% | 3% | 6% |
| Pro | 12% | 3% | 5% |
| Turbo | 9% | 3% | 3% |

Mechanics that shape the framework:

- **Both limits are live at once.** Touching either one, for any length of
  time, including on open positions, breaches the account: positions closed,
  account disabled, buy a new evaluation to continue.
- **Daily loss resets at 00:30 UTC** from the closed balance (open positions
  excluded from the base, included in the equity that gets measured).
- **Drawdown is static** from the starting balance. It never trails, never
  moves. On a $10K Classic it is $9,400 forever.
- **Fees**: 0.04% per side on notional (8 bp round trip). Swap 0.033% per open
  position per day. At 5x leverage on full margin a round trip costs 0.4% of
  equity. Scalping is priced out; swing is priced in.
- **Leverage is fixed per instrument**: BTC 10x; ETH, SOL, and most majors 5x;
  HYPE and a few small caps 3x; everything else 2x.
- **No time limit, no minimum days, no consistency rule.** Slow is allowed.
- **Weekend holding allowed, 24/7 trading.**
- **No partial take-profits on a single position.** One TP per position;
  split a position into several orders if the plan needs scaling out.
- **No partial fills on limit orders.** Size against visible depth.
- **Funded account keeps the same daily loss and static drawdown**, drops the
  target. The strategy that passes is the strategy that gets paid.
- **Payouts** on demand, 80/20 default, USDC, $50 minimum. Paid-out amounts
  are added as buffer to the daily loss limit.
- **KYC** is required before a funded account trades. Submit it at signup, not
  after passing (the only refund case is KYC rejection on active evals).

**Plan choice: Classic, smallest account size.** Turbo's 3% drawdown is six
half-percent losses before breach, which is a bad first week, not a strategy
test. Pro's 12% target buys nothing here. The account size is irrelevant
until the record exists; the fee is the cost of the exam, not an investment.

## (b) Risk framework, derived from the limits

Numbers below are fractions of **starting balance**, the same base the firm
uses for drawdown.

| Rule | Value | Why |
|---|---|---|
| Risk per trade (stop to entry) | 0.50% | 12 consecutive stops before breach on Classic. 1% would be 6. |
| Self-imposed daily stop | 1.50%, or 2 losing trades | Half the firm's 3%. The firm's limit is the wall; this is the fence before the wall. |
| Self-imposed weekly stop | -3R (1.5%) | Hit it, no trading for 5 calendar days. Review the journal instead. |
| Max concurrent positions | 2 | Correlation in crypto is the rule, not the exception. Two positions in the same sector count as one and split the 0.5%. |
| Max open risk at any time | 1.0% | Sum of open stops. |
| Minimum reward:risk at entry | 2:1 planned | Below that the setup does not exist. |
| Leverage actually used | ≤ 2x notional/equity | Available leverage is not target leverage. Fees and the daily limit both punish notional. |
| Max holding period | 10 days | Swap is 0.033%/day; a thesis older than two weeks is a different thesis. |
| Trades per week | ≤ 6 | Twenty-plus trades a week at 8 bp is a fee-donation programme. |
| Time gate | No entries in the 30 min around CPI, FOMC, NFP prints | The briefing's geopolitics domain and `risks` name them. |

**Arithmetic that matters.** Target 10% at 0.5% risk is **20R**. At a 45%
hit rate and 2R average winner the expectancy is 0.35R per trade, so the
target is roughly 55 to 60 trades, or 10 to 12 weeks at 5 trades a week.
At a 40% hit rate it is about 0.2R per trade and 100 trades. A losing streak
of 8 (about a one-in-thirty event at 45%) costs 4%: survivable on Classic,
fatal on Turbo. This is why the plan is Classic and why the target is a
quarter, not a month.

**Sizing formula** (the app computes it; the operator does not do this in
their head at 03:00):

```
risk_usd    = starting_balance * 0.005
stop_dist   = |entry - stop| / entry
size_usd    = risk_usd / stop_dist                # notional
size_usd    = min(size_usd, 2 * equity)           # leverage cap
fee_usd     = size_usd * 0.0008                   # round trip, count it against R
```

A stop under 0.5% away means the notional cap binds and the trade is a
scalp. Skip it.

## (c) Setup ledger

Every trade cites exactly one `setup_id`. A trade without a setup is a rule
breach, not a trade. Setups may be added only through a journal review
(§(f)), never mid-session.

| id | Regime gate (from `data/marketstate`, `data/sectors`) | Trigger (from HL metrics / chart) | Invalidation | Notes |
|---|---|---|---|---|
| `funding_fade` | Briefing thesis is chop or unconfirmed; no catalyst inside 24h | Funding for the coin outside its 30-day range (z30 ≥ 2) with OI at a 30-day high; price stalls at a level | Price closes beyond the level on rising OI | Counter-trend. Same idea as the engine's `funding_skew` manifest; this is the discretionary version traded by hand on the prop terminal. |
| `sector_continuation` | Sector `momentum ≥ 0.5` in the latest sectors file and named in `rotations[].to`; briefing not risk-off | The sector's top token (by mindshare, listed on Breakout) breaks a multi-day range on rising OI, funding still moderate (z30 < 1.5) | Falls back inside the range; OI drops | Trend. The one setup that uses what hypertrade was built for. |
| `post_liquidation_reclaim` | Any regime | Funding flips negative on a long-biased major after a >5% down candle; OI has fallen ≥ 15% from its peak; price reclaims the pre-flush level | Loses the reclaimed level | Mean reversion after forced selling. Rare by design. |
| `no_trade` | Briefing thesis forecast says range-bound with a catalyst inside 48h; or any kill switch active | — | — | A logged no-trade day counts toward the record. |

The ledger is short on purpose. Three setups and a no-trade rule is the
whole book until the journal earns a fourth.

## (d) Session protocol

Before the first order of any day, in the app (`/journal`, §(e) task list):

1. **Check-in**: hours slept, urge score 1 to 5 ("how badly do I want to
   trade right now"), one line of intent. Urge ≥ 4 or sleep < 6h locks
   entries for the day. This is the rule with the most expected value in the
   whole file.
2. **Read** the latest briefing's `thesis.forecast` and `risks`, the sectors
   `rotations`, and the HL markets table sorted by funding z-score. Write
   the regime tag for the day (`risk_on` / `risk_off` / `chop`).
3. **Plan**: at most 2 candidate trades written as setup, level, stop, target,
   size (from the formula). Plans written before the trigger, never after.

During:

4. Enter only on a written plan. Stop order placed at entry, on the terminal,
   not mental.
5. After any exit, log it before the next entry. Realised R, fees, and the
   one-line "what did I do that was not in the plan".
6. Two losses, or -1.5%, closes the day. The app shows the lockout; the
   operator honours it.

After:

7. Daily close: 3 lines. What the regime did, what I did, one thing to keep.

## (e) What the app has to add (journal + enforcement)

hypertrade currently reads regimes and simulates allocations. It does not
yet hold a trade record. Additions, tracked in TASKS.md as T13–T15:

**Tables** (`db/migrations/002_journal.sql`):

```
trades(
  id uuid pk, venue text check (venue in ('paper','breakout_eval','breakout_funded')),
  account_id text, setup_id text not null, coin text not null, side text not null,
  regime_tag text, sector_id text,
  planned_at timestamptz, opened_at timestamptz, closed_at timestamptz,
  entry double precision, stop double precision, target double precision, exit double precision,
  size_usd double precision, risk_pct double precision, r_planned double precision, r_realized double precision,
  fees_usd double precision, thesis text, deviation_note text, post_note text,
  breaches text[] default '{}'
)
sessions(
  day date pk, slept_h double precision, urge int check (urge between 1 and 5),
  intent text, regime_tag text, pnl_r double precision, trades int,
  lockout_reason text, close_note text
)
accounts(
  id text pk, venue text, starting_balance double precision, max_dd_pct double precision,
  daily_loss_pct double precision, target_pct double precision, opened_at timestamptz, status text
)
```

**Routes**: `GET/POST /api/journal/trades`, `PUT /api/journal/trades/:id`,
`GET/PUT /api/journal/sessions/:day`, `GET /api/journal/accounts`,
`GET /api/journal/stats?venue&from` (hit rate, avg R, expectancy, streaks,
per-setup breakdown, fee drag, breach count).

**Enforcement in the UI** (`/journal`): the sizing calculator from §(b); a
red lockout banner when any §(b) or §(d) rule is tripped (computed
server-side from `trades` + `sessions`, not from a client flag); a setup
picker limited to the §(c) ledger; a paper/eval/funded venue tag so paper
and real records never blend in the stats.

**Gate the app enforces**: the "buy evaluation" checklist (§(f)) is a page
that stays red until the paper record satisfies it.

## (f) Gates

Nothing is bought until the paper record clears these, all measured in the
app on `venue = paper` with the same rule set as §(b):

- ≥ 30 logged trades, each citing a §(c) setup, over ≥ 6 weeks.
- Expectancy ≥ 0.2R after fees; no single trade above 3R contributing more
  than a third of net R.
- Zero breaches of the daily or weekly stop in the last 4 weeks.
- ≥ 20 logged sessions with the check-in filled.

While funded or in evaluation, the record is reviewed every Sunday. A setup
whose 20-trade expectancy is below zero is suspended from the ledger. A new
setup enters only after 20 paper trades of its own.

If the evaluation breaches: no repurchase for 30 days. The journal review
of the breached account is the work for that month. The firm earns a fee on
every re-buy, and says so in its own disclosures. Do not be that fee.

## (g) What a win is

A win is a quarter of sessions logged, inside the limits, with a positive
expectancy, whether or not the target is reached. A passed evaluation is the
firm agreeing. A payout is the firm paying for the record. None of these is
the old account back. The old account is not coming back and this file is
not for that.
