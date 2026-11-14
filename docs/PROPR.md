# Propr venue

The desk can trade a Propr challenge or funded account (`src/server/desk/propr/`). Propr routes
to Hyperliquid mainnet, so the governor sizes against the desk's own mainnet marks. The code is
ported from perp-radar's executor (`src/exec/`). perp-radar's own scheduled executor is a separate
program; this venue refuses new entries while perp-radar's orders sit on the same account, so only
one executor trades an account at a time.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `DESK_VENUE=propr` | Use this venue. A missing key or account falls back to paper with a note on the Desk page. |
| `PROPR_API_KEY` | API key. Held only by the client, sent only in the `X-API-Key` header to `api.propr.xyz` or `api.beta.propr.xyz` (redirects are refused), scrubbed from every error, alert and record. |
| `PROPR_ACCOUNT_ID` | The challenge or funded account (status active, passed or funded). Anything else is refused at read time. |
| `PROPR_LIVE` | Orders are sent only when this is exactly `true`. Anything else is a **dry run**. |
| `PROPR_KILL` | `true` falls back to paper: nothing reaches Propr. Resting rungs already on Propr are then no longer managed by the desk. |
| `PROPR_API_URL` | `https://api.propr.xyz/v1` (default) or the beta host. Any other host falls back to paper. |
| `PROPR_STARTING_BALANCE` | Only if the account does not report its starting balance; the higher of the two is used. |

Tuning: `PROPR_MAX_ENTRIES_PER_DAY` (2, max 3), `PROPR_DAILY_LOSS_PCT` (3), `PROPR_MAX_DRAWDOWN_PCT` (6),
`PROPR_LADDER_RUNGS` (5), `PROPR_LADDER_RUNGS_BY_COIN` (`BTC:8,LIT:3`), `PROPR_LADDER_FIRST_AT_MARKET`
(true), `PROPR_LADDER_TTL_HOURS` (8). Leverage has its own section below.

Before the first live run, `bun run propr:check [COIN]` reads the account with GET requests only and
prints what the desk would see: whether `X-API-Key` auth works, the balance fields of
`GET /accounts/{id}`, positions, orders split into desk (`PRD`) and perp-radar (`PRX`), today's
trades, the coin's margin config, and the desk's snapshot. Nothing is sent.

## Approval

Approval is always manual on Propr: `DESK_APPROVAL=auto` is ignored and switching to auto from the
page is refused. Every entry waits for approve or reject, and so does an exit an agent proposes
(the operator's own exits go straight through). Approve and reject claim the proposal atomically in
the store, so a double click or two tabs cannot send the same ladder twice; the second gets
`proposal is already being decided`.

## Leverage

Propr sets cross leverage per coin, from 1x up to the coin's maximum: 10x on BTC, ETH and SOL and 2x
elsewhere per the rulebook, overridable with `PROPR_LEVERAGE_BY_COIN` (`HYPE:5`) and capped
account-wide by `PROPR_MAX_LEVERAGE` (default 10). Each trade's leverage is picked in this order:

1. the trade's own `leverage`, capped at the coin's maximum and rounded to a whole number. Agents
   set it on `propose_trade` from their conviction (the portfolio tool tells them the venue picks
   leverage per trade). A copilot order runs at the leverage its preview shows (1x unless the
   order text or the adjust form gives one);
2. else the proposal's confidence through `PROPR_LEVERAGE_BY_CONFIDENCE` (`low:1,medium:3,high:5`);
3. else `PROPR_DEFAULT_LEVERAGE`;
4. else the smallest leverage that carries the ladder's notional on the account's equity.

The governor's per-coin leverage cap is set to that leverage, so a high-conviction trade can size
up to it and a low-leverage trade stays small. A ladder that needs more leverage than the coin
allows is refused with the reason. The margin config is changed before the first rung whenever the
leverage or mode differs, so a resting position on that coin is never repriced: the venue refuses a
new entry while a position on the coin is open. Only cross margin is supported.

## Dry run

The default. The venue reads the account (GET only), runs the governor and the firm rules, builds
the exact requests (the margin config, then one per rung) and records them on the proposal
(`execution.requests`) with `dryRun: true`. The alert is informational: `Dry run: {side} {coin}
built, not sent`. Housekeeping only reports what it sees; it cancels nothing.

## An entry

1. The governor approves and sizes the order as for any venue (risk %, open risk, leverage caps, R:R).
2. **Ladder** (`ladder.ts`): rungs from the mark toward the stop, ending halfway to the stop and
   never inside 20% of the stop distance. Every rung has the same quantity: the smaller of the
   governor's risk spread over the rungs' stop distances and its notional spread over their prices,
   so the ladder never exceeds either. Rungs drop until each is at least $11. The first rung is a
   market order; the rest rest as limits.
3. **Firm rules** (`firmReasons`), on Propr's account, manual trades included:
   - at most `PROPR_MAX_ENTRIES_PER_DAY` entries per UTC day (a ladder counts once);
   - no new entry while any position lacks a stop covering it, while entries on the same coin rest,
     or while perp-radar's orders are on the account;
   - no new entry once half the daily limit is used;
   - the worst case (this ladder filled, its stop slipping 1.5x, fees both ways, every open stop and
     resting rung) must leave 1% of the day-start balance above the daily floor and 1.5% of the
     starting balance above the static drawdown floor.
   An account whose balance or equity reads as zero or missing is refused outright.
4. Leftover desk orders on the coin (old stops, targets, rungs) are cancelled first; if one is still
   open afterwards, the entry is not sent.
5. One request per rung: the entry plus a reduce-only stop and take-profit for that rung's quantity,
   in one `orderGroupId`. Ids are ULIDs tagged `PRD` (perp-radar uses `PRX`). A rung that fails to
   send stops the loop: no later rung goes out.
6. A refused stop on a resting rung cancels its entry. If the entry has filled (the market rung, or a
   limit that filled at once), that rung's quantity is closed at market. The loop stops either way and
   the alert says so. A market rung reported with zero filled is noted, not recorded as a fill.

Fill prices are read from `averageFillPrice` (falling back to `averagePrice`) and quantities from
`cumulativeQuantity`. Orders, positions and trades are read page by page (100 per page, up to 10
pages; trades only back to 00:00 UTC).

Platform opportunities (extremes takes included) placed on Propr are tracked by the venue itself:
reconcile asks the broker whether the coin and side are still held, as a position or as the desk's
resting entry rungs, since a ladder's position grows rung by rung and never matches its first fill.
A dry run or a firm-rule refusal fails the placement with the venue's own reason.

## Exits and housekeeping

An exit is a reduce-only market close. A close with no reported fill is reported as sent, not filled.
Leftover orders on that coin are cancelled only once the whole position is confirmed closed.

Each watch tick cancels unfilled desk rungs once the trade is over or the ladder is older than its
TTL, and the desk's leftover stops and targets once the position is gone. Orders the desk did not
place are never cancelled. The tick also raises account alerts, deduplicated so each repeats at most
hourly:

- **critical**: a position with no stop covering it;
- **warn**: perp-radar orders on the account, an account that cannot be read, or a sweep that failed;
- **info**: rungs swept (live only).

## Known limits

- Propr's two-step trailing drawdown is not modeled; the static floor from the starting balance is.
- `X-API-Key` auth and the balance fields of `GET /accounts/{id}` follow Propr's docs but are only
  confirmed once `propr:check` runs against a real account.
- The governor's open-risk check does not see resting rungs; the firm worst case does.
- Propr's effective leverage limits endpoint is not read; the rulebook caps above stand in for it.
- Entry, stop and target pricing from perp-radar's scanner on top of the extremes module is not
  here yet. Proposals still come from the desk's agents and the operator.
