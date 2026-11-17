# DESIGN-desk-calm: the calm desk

Addendum to docs/design/README.md, docs/design/terminal.md and docs/SPEC.md § Desk.
**Where they disagree, this file wins.** It replaces README §8's 220 ms rhythm,
tick flash and pulsing busy label.

## Why

Trading should feel calm. Fear of missing out loses money, so the desk makes the
impulsive action slower than the planned one. Every rule below enforces that.

## 1. No ticking P&L

- Open positions never show live dollar P&L by default. `RevealPnl`
  (`src/ui/components/RevealPnl.tsx`) shows `$ ···` until a tap, click,
  Enter/Space or hover, then hides again after 4 s.
- Each position shows where price sits between its stop and its target as one
  quiet bar, plus R so far (`+0.6R`): `PlanProgress`
  (`src/ui/components/PlanProgress.tsx`). With no target it shows distance to the
  stop and R.
- Applies to the desk book (PLAN · UPNL), the desk's DAY PNL, the Intel
  positions table (R · UPNL, sorted by R) and the Governor page. Realized P&L in
  the journal is history and stays visible.
- Desk marks come from the HL websocket, sampled at most every few seconds and
  eased into place (`EasedValue`, 400 ms opacity settle). No per-tick flicker,
  no colour flash. The polled mark is the fallback when the socket is down.

## 2. Plan before button

- There is no free-floating Buy or Sell button. An order is placed only from a
  written plan: coin, side, ladder (price + size per level), stop, target.
  Contract: `src/shared/deskPlan.ts`; logic: `checkPlan` in
  `src/server/desk/plan.ts`.
- Before submit the plan shows total size and notional, average entry if fully
  filled, loss at the stop in dollars and % of the account, R:R at full fill and
  at top-rung-only fill (the top rung is the one that fills first: a long's
  highest, a short's lowest), and how much of today's loss limit and of the max
  drawdown it uses. Fees are not included.
- Submit is disabled while any blocker holds: no stop or no target; stop or
  target on the wrong side of the rungs; loss at stop above the per-trade cap;
  today's possible loss (lost today + open stop risk + this plan) past the daily
  limit; a cooldown; any governor refusal. A plan the governor would size
  smaller is blocked, not silently shrunk.
- The plan is journaled whether or not it is placed (`desk_plans`, migration
  030). Copilot confirms (`/order`) are journaled too, as one-rung plans, and
  the copilot now requires a target.
- Venues: Propr rests the full ladder as GTC limits, each with its own stop and
  take-profit. Paper and hl-testnet place a single rung within 0.5% of the mark
  and refuse a multi-rung ladder with a blocker.

Routes (session-gated, under `/api/desk`):

| Route | Body | Returns |
|---|---|---|
| `POST /plans/check` | `{plan}` | `PlanCheck` `{metrics, blockers, warnings}`, nothing saved |
| `POST /plans` | `{plan, place}` | `{record, check, placed}`, always journaled |
| `GET /plans?limit=` | | `{plans}` newest first |
| `GET /cooldown` | | `{coins, all, stopOutsToday}` |

## 3. Cooldown after a loss

- A stop-out locks new entries on that coin for `DESK_COOLDOWN_HOURS` (default 4).
- `DESK_MAX_STOP_OUTS_PER_DAY` (default 2) stop-outs in one UTC day lock all new
  entries until 00:00 UTC.
- State lives server-side in the `desk_state` KV under `cooldown`, so it
  survives reloads and restarts. Pure transitions in
  `src/server/desk/cooldown.ts`.
- The governor (`assess`) enforces the lock on every entry path: plans, agent
  proposals, Telegram, the `/order` copilot and platform approve.
- During a cooldown the desk shows how long is left (absolute time plus a coarse
  "about 3h left", updated at most per minute) and the journal entry for the
  loss. There is no override.
- Detection: paper stop-outs are recorded when the watch tick settles the stop.
  On live venues the watch tick counts a stop-out when a position that had a
  stop is gone and the 5-minute bars since the last good read touched that stop.
  Known gaps: a stop hit and refilled inside one tick is missed; a manual close
  after a wick through the stop reads as a stop-out; no exchange fill data, so
  the price is the stop and P&L is null.

## 4. Quiet palette and motion

- No blinking, flashing or pulsing on price moves. The `flash-up/down` tick
  flash is gone.
- Up and down use muted, low-saturation tones in all three themes (text tokens
  ≥ 4.5:1 on panel, elevated and hover surfaces; fills ≥ 3:1). Hyperion's warm
  greys set the mood; Hyperdash and Trade[XYZ] follow the same rules.
- Transitions are 300 ms or longer and eased: digits 320 ms, value settle
  400 ms, plan-progress tick 500 ms, hover 300 ms. `.pulse-label` is one finite
  600 ms fade to 0.6 opacity, not a loop. No sounds.
- Alerts arrive as one soft notice. No badges counting up; the desk's pending
  badge is neutral.
- Enforced by `src/ui/motion.test.ts`: it fails on `infinite`,
  `animate-pulse|ping|bounce|spin`, any CSS or inline time under 300 ms,
  Tailwind `duration-N` under 300, a `transition*` utility without a duration,
  and `Audio`/`AudioContext`.

## 5. Copy and tone

- Labels describe the plan, not the market's urgency. No "Act now", "Don't
  miss", countdowns to candle closes or similar.
- Ticking countdowns are replaced by absolute times: the order preview shows
  "valid until HH:MM:SS"; funding shows "Funding at HH:MM UTC"; catalysts show
  "in 4h 12m" without amber.
- Empty states are calm: "No plan open. Nothing to do."

## Settings

| Env | Default | Meaning |
|---|---|---|
| `DESK_PLAN_MAX_RISK_PCT` | 1 | per-trade loss-at-stop cap, % of equity |
| `DESK_MAX_DRAWDOWN_PCT` | 10 | max drawdown for paper and testnet (Propr uses `PROPR_MAX_DRAWDOWN_PCT`) |
| `DESK_COOLDOWN_HOURS` | 4 | per-coin lock after a stop-out |
| `DESK_MAX_STOP_OUTS_PER_DAY` | 2 | stop-outs that lock all entries until the UTC reset |

The per-trade check uses the tighter of `DESK_PLAN_MAX_RISK_PCT` and the
governor's `DESK_MAX_RISK_PCT` (default 0.5), so with defaults plans cap at
0.5%. Raise `DESK_MAX_RISK_PCT` to 1 to get the spec's 1% default.

## Acceptance

- No component renders live dollar P&L without a user action.
- An order cannot be sent without a stop and passing the risk checks above.
- A stop-out triggers the cooldown, and the cooldown survives a page reload
  (server-side KV).
- No CSS animation on price elements shorter than 300 ms; no infinite
  animations anywhere.
