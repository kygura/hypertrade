# Propr venue

The desk can trade a Propr challenge or funded account (`src/server/desk/propr/`). Propr routes
to Hyperliquid mainnet, so the governor sizes against the desk's own mainnet marks. The code is
ported from perp-radar's executor (`src/exec/`); perp-radar's own scheduled executor is untouched
and keeps running until it is switched off there.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `DESK_VENUE=propr` | Use this venue. A missing key or account falls back to paper with a note on the Desk page. |
| `PROPR_API_KEY` | API key. Held only by the client, sent only in the `X-API-Key` header to `api.propr.xyz` or `api.beta.propr.xyz`, scrubbed from every error, alert and record. |
| `PROPR_ACCOUNT_ID` | The active challenge or funded account. Anything else is refused at read time. |
| `PROPR_LIVE` | Orders are sent only when this is exactly `true`. Anything else is a **dry run**. |
| `PROPR_KILL` | `true` falls back to paper: nothing reaches Propr. |
| `PROPR_API_URL` | `https://api.propr.xyz/v1` (default) or the beta host. Any other host falls back to paper. |
| `PROPR_STARTING_BALANCE` | Only if the account does not report its starting balance; the higher of the two is used. |

Tuning: `PROPR_MAX_LEVERAGE` (3), `PROPR_MAX_ENTRIES_PER_DAY` (2, max 3), `PROPR_DAILY_LOSS_PCT` (3),
`PROPR_MAX_DRAWDOWN_PCT` (6), `PROPR_LADDER_RUNGS` (5), `PROPR_LADDER_RUNGS_BY_COIN` (`BTC:8,LIT:3`),
`PROPR_LADDER_FIRST_AT_MARKET` (true), `PROPR_LADDER_TTL_HOURS` (8).

## Dry run

The default. The venue reads the account (GET only), runs the governor and the firm rules, builds
the exact order requests and records them on the proposal (`execution.requests`). The proposal is
marked `failed` with `Propr dry run: N rung requests built, none sent`, so nothing reads as filled.
Housekeeping only says what it would cancel.

## An entry

1. The governor approves and sizes the order as for any venue (risk %, open risk, leverage caps, R:R).
2. **Ladder** (`ladder.ts`): rungs from the mark toward the stop, ending halfway to the stop and
   never inside 20% of the stop distance. Every rung has the same quantity: the smaller of the
   governor's risk spread over the rungs' stop distances and its notional spread over their prices,
   so the ladder never exceeds either. Rungs drop until each is at least $11. The first rung is a
   market order; the rest rest as limits.
3. **Firm rules** (`firmReasons`), on Propr's account, manual trades included:
   - at most `PROPR_MAX_ENTRIES_PER_DAY` entries per UTC day (a ladder counts once);
   - no new entry while any position lacks a stop covering it, or while entries on the same coin rest;
   - no new entry once half the daily limit is used;
   - the worst case (this ladder filled, its stop slipping 1.5x, fees both ways, every open stop and
     resting rung) must leave 1% of the day-start balance above the daily floor and 1.5% of the
     starting balance above the static drawdown floor.
4. One request per rung: the entry plus a reduce-only stop and take-profit for that rung's quantity,
   in one `orderGroupId`. Ids are deterministic ULIDs seeded by the proposal id and tagged `PRX`, so a
   retried send is the same order to Propr.
5. A refused stop on the market rung closes that rung at market at once; on a resting rung, the entry
   is cancelled. Either case is reported in the alert.

## Exits and housekeeping

An exit is a reduce-only market close. A full close cancels the desk's leftover orders on that coin.
Each watch tick cancels unfilled rungs once the trade is over or the ladder is older than its TTL,
and the leftover stops and targets once the position is gone. Orders the desk did not place are never
touched.

## Not here yet

- Entry, stop and target pricing from perp-radar's scanner on top of the extremes module. Proposals
  still come from the desk's agents and the operator.
- Propr's effective leverage limits endpoint: the venue caps leverage at `PROPR_MAX_LEVERAGE` and the
  governor's caps sit under it.
