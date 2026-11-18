# Extremes

Rare, tape-first alerts. Code finds an extreme in a coin's own 15-minute history, a Claude
research session is woken with the facts, and the owner gets a push only when that session
says `take`. Contracts: `src/shared/extremes.ts`.

## Flow

1. **Detect** (`src/server/extremes/detect.ts`, pure). Three kinds, at most one event per kind
   and coin per call. `side` is the fade side the imbalance favours, never a recommendation.
   - `price_dislocation`: 4h/24h/72h log return in sigmas of the coin's own same-length
     returns over 30 days, and extreme against BTC too (return minus beta × BTC), so a
     market-wide move does not fire every alt. Without BTC history a non-BTC coin never fires.
   - `oi_flush`: open interest in contracts (OI USD / mark) dropping hard over 1h/4h/24h
     together with a price move. Price down is a long flush (side long), price up a short one.
   - `crowded_asymmetry`: funding at an extreme of its 30-day distribution, OI near its
     30-day high, price flat or against the crowd over 24h. Side is against the crowd.
2. **Job** (`src/server/extremes/job.ts`, `POST /api/cron/extremes`, pg_cron at :08 :23 :38
   :53). Top `EXTREMES_TOP` (30) coins by stored 24h volume plus BTC, read from
   `scan_snapshots`. A key (`kind|coin|side`) is silent for `EXTREMES_COOLDOWN_H` (24) after
   it fires. At most `EXTREMES_DAILY_CAP` (3) events go out per UTC day; the rest are stored
   with delivery `none`. Every event is stored before it is sent, and a failed send is not
   retried: a lost alert is preferred to a repeat.
3. **Wake** (`src/server/extremes/wake.ts`). One POST per run to `EXTREMES_WAKE_URL` (a Claude
   Code routine's fire endpoint) with `EXTREMES_WAKE_TOKEN`. Never retried: the endpoint has no
   idempotency and a retry starts a second session. With no target, or on any failure, each
   event's facts are pushed through the desk notifier instead.
4. **Verdict** (`POST /api/extremes/verdict`, bearer `LAB_API_TOKEN`). Body
   `{key, stance: take|watch|pass, direction?, killPx?, cause, sources?, confidence?, leverage?}`. Every stance stamps
   the live mark (`verdictMark`; null for `watch`/`pass` when no fresh mark exists). `take` needs a direction, a fresh
   mark (503 otherwise) and a kill level on the right side of it (422 otherwise); code prices it (Pricing, below), it
   becomes an approvable opportunity (Approve, below) and sends one push linking to the coin page. `confidence`
   (low|medium|high) and `leverage` (1-10) are optional on a take: the session's conviction and the Propr leverage it
   wants. `watch` and `pass` are stored, no push. One verdict per event. The session never writes an entry, a target or
   a size. Response: `{record, mark, pushed, opportunity, opportunityReason, pricing}`, `opportunity` = `{id, status,
   created}` or null, `pricing` = `{priced: true, setup, stop, target, rr, minRr}`, `{priced: false, reason}` or null.

`GET /api/extremes?days=7` (max 30) lists events with delivery, verdict and grade, plus a summary (below):
`{since, records: [ExtremeRecord & {grade}], summary}`.

## Research session

The app's push channels (ntfy, Telegram) are not in use since 2026-11-18. With none configured the notifier sends
nothing, so the pushes this file describes (an event's facts, a take) do not go out; the hourly routine's final
message is the notification.

Since 2026-11-18 the research runs inside the hourly routine "Hypertrade queue digest", which polls `GET /api/extremes`
for events without a verdict instead of being woken (a verdict can come up to an hour after the event).
The routine's full prompt is `docs/EXTREMES-ROUTINE.md`: input format, the steps per event, the
take/watch/pass rules and the verdict call. The routine stores a copy of it, so edit the file
first and paste it into the routine.

## Calibration

`bun run extremes replay [--top 30] [--days N] [--events] [--source candles|snapshots]`
replays the detectors with the job's cooldown and grades the fade side at 4h, 24h and 72h,
absolute and against BTC. `bun run extremes` scans now. Both are keyless on candles.

The code defaults (`DEFAULT_EXTREME_THRESHOLDS`) were tuned once for frequency, not for returns. On
2026-11-14, top 30 coins, about 5.4 weeks of 15-minute candles: `price_dislocation` fired 10
times (1.84 a week), 7 of them on one coin whose volatility regime broke. Ten events say
nothing about edge. Hyperliquid publishes no OI history, so `oi_flush` and `crowded_asymmetry`
are not evaluable on candles; the calibration pipeline below tunes all three on stored
snapshots. Live funding is the predicted rate and is noisier than the settled funding the
candle replay reads.

`scan`, `show` and `replay` detect with the latest applied calibration when `DATABASE_URL` is
set, else the code defaults, and print which.

## Calibration pipeline

`src/server/extremes/calibrate.ts` (pure), `bun run extremes calibrate`, weekly workflow
`.github/workflows/extremes-calibrate.yml`, table `extreme_calibrations` (029).

- **Frequency only.** Each kind is tuned so it fires at a target rate across the job's
  universe. Forward fade-side returns (hit rate and median at 4h/24h/72h, before and after)
  are stored next to the result for information and never enter the objective.
- **Targets.** Per kind `EXTREMES_CALIBRATION_TARGET_WK` (1.0) events a week, band
  `EXTREMES_CALIBRATION_MIN_WK`..`EXTREMES_CALIBRATION_MAX_WK` (0.5..1.5): about 2 to 4 a week
  in total. An inconsistent band falls back to the defaults.
- **One knob per kind.** A multiplier `k` of the code defaults' sigma cuts: `price_dislocation`
  scales `price.z` and `price.zResid` (every window); `oi_flush` scales `oiFlush.z` (every
  window) and `oiFlush.zPrice`; `crowded_asymmetry` scales `crowded.minAprPct`. Not
  `zFunding`: funding sits at HL's default most of the time, its MAD is tiny and the level z
  runs to tens, so any z cut in the clamp range passes the same readings. Not the percentile:
  30 days of hourly samples leave 7 above the 99th, so it moves in coarse steps and saturates
  on ties at the default rate. The apr bar is the one continuous cut that gates. Hard floors
  (`minMove`, `minDrop`) are never touched. A larger `k` never fires more.
- **Search.** For each step and coin in the universe the readings are taken once under the
  loosest thresholds any candidate can reach; only readings that could fire are kept. Each
  candidate re-thresholds them (`rethreshold`, `eventsOf`) with the job's per-key cooldown
  (`EXTREMES_COOLDOWN_H`): 25 multipliers per kind on a geometric grid between the run's
  bounds, nearest the target wins, ties go to the multiplier closest to the applied one. A test
  proves this fast path yields exactly `replayExtremes`' events. No look-ahead: readings use
  `ts <= step` only, and the universe at each step is the job's (top `EXTREMES_TOP` by the
  latest 24 h volume stored in the hour before the step, plus BTC).
- **Per-coin cap.** The rate counts at most `EXTREMES_CALIBRATION_PER_COIN_CAP` (2) events per
  coin per kind in the window, so one coin in a broken regime cannot carry the estimate. The
  busiest coin is reported.
- **Guard rails.** Not evaluable (the run keeps the current thresholds): fewer than
  `EXTREMES_CALIBRATION_MIN_DAYS` (14) days of dense history (24 h windows with at least 48
  snapshot times, counted back from the last step), fewer than
  `EXTREMES_CALIBRATION_MIN_REPLAY_DAYS` (7) days of replayed steps (the detectors need 14
  days of history before the first step, so this needs about 21 days stored), or a kind whose
  input is missing (OI kinds without OI). Per run `k` moves at most
  `EXTREMES_CALIBRATION_MAX_STEP` (±25%) from the applied multiplier, and stays within
  `EXTREMES_CALIBRATION_MULT_MIN`..`EXTREMES_CALIBRATION_MULT_MAX` (0.5..2.5) of the code
  defaults. A kind already in its band keeps its thresholds (no weekly jitter). Out of band
  with no candidate doing better within those bounds: unchanged, reported `clamped`. A changed
  kind that stopped at a bound while still out of band reports `limited` (`step` or `clamp`).
- **Where the thresholds live.** Every run stores one row in `extreme_calibrations`: `ran_at`,
  the replayed window, the coins, the result (jsonb) and the proposed thresholds (jsonb),
  `applied`. The live job (`runExtremesJob`) detects with the thresholds of the newest
  applied row, parsed with `ExtremeThresholdsSchema`; no applied row, a row that fails to
  parse (logged once) or a failed read means the code defaults. The job's JSON report says
  which (`calibration`: `{id, ranAt}` or `"defaults"`). `GET /api/extremes/calibration` (same
  auth as `GET /api/extremes`) returns the applied thresholds and their source, the code
  defaults and the last 10 runs.
- **By hand.** `bun run extremes calibrate [--days 30] [--top N] [--apply] [--json]` (needs
  `DATABASE_URL`). Without `--apply` the run is stored as a proposal (`applied` false). With
  `--apply` it is stored applied when at least one kind changed, and one `info` push goes out
  through the desk notifier (`Extremes recalibrated: oi_flush ×0.80 (0.2 → 0.9/wk), ...`, the
  multiplier relative to the code defaults). No push when nothing changed. `--top` defaults to
  `EXTREMES_TOP`. `--json` prints `{id, applied, thresholdsBefore, result, markdown}`.
- **Workflow.** Sunday 03:17 UTC and `workflow_dispatch` (`apply`, default true; `days`,
  default 30); one run at a time. Secrets: `DATABASE_URL` (skips with a notice without it),
  optional `NTFY_TOPIC`, `NTFY_SERVER`, `NTFY_TOKEN` for the push. The table goes to the step
  summary.
- **Roll back.** `bun run extremes calibrate --reset` stores an applied row equal to the code
  defaults; the next job run uses them. When the code defaults change, run it too: applied
  rows hold full thresholds, so they keep the old ones until the next applied run.

## Pricing

`src/server/extremes/pricing.ts`, ported from perp-radar's scanner (`src/setups.ts` there), on the coin's last 80 h of
Hyperliquid 1h candles (current bar last). Entry is the verdict mark. Levels: 1h ATR(14), the last 24 bars' high and
low with the mark, and the 72 bars before the current one (low, high, median close; needs 48). One template per kind
and fade side:

| kind | direction | setup | template stop | target |
| --- | --- | --- | --- | --- |
| `price_dislocation` | short (long mirrored) | `fade_extension` | 24h high + 0.5 ATR | 72h median |
| `oi_flush` | long | `flush_reversion` | 24h low − 0.5 ATR | 24h low + half the 24h range |
| `oi_flush` | short | `squeeze_exhaustion` | 24h high + 0.5 ATR | 24h high − half the 24h range |
| `crowded_asymmetry` | long | `short_squeeze_loading` | 72h low − 0.25 ATR | 72h high |
| `crowded_asymmetry` | short | `long_squeeze_loading` | 72h high + 0.25 ATR | 72h low |

- The stop is the farther from the entry of the template's stop and `killPx`, then widened to at least 0.75 ATR
  (perp-radar's `MIN_STOP_ATR`), so a tight stop cannot inflate the R:R. R:R = reward / risk at the entry.
- A priced take must clear `EXTREMES_MIN_RR` (default 2), compared at one decimal (1.98 passes against 2). Under it the
  verdict is stored and pushed with the levels and the reason, and no opportunity opens (`opportunityReason` says why).
- Unpriced (a direction against the event's fade side, a target already behind the mark, under 15 h of candles, under
  48 h for a 72 h range, or a failed candle read): it opens as before, stop = `killPx`, no target, and the push says why.
- Conviction: the verdict's `confidence`, else the R:R's (3.5:1 or more high, 2.5:1 or more medium, else low). It and the
  verdict's `leverage` go on the opportunity as tags, `conviction:<c>` and `leverage:<n>`.

## Approve

A `take` becomes a platform `Opportunity` (`src/server/extremes/opportunity.ts`), shown in the coin page's SETUP block
and decided there like any ready setup (APPROVE sizes the ticket through the desk governor from the stop; operator
cookie only, the research bearer cannot approve).

- `setupKind` = the event kind, `direction` = the verdict's, `entryPx` = the verdict mark, `stopPx` = `invalidationPx` =
  the priced stop and `targetPx` the priced target (unpriced: `killPx` and no target), no costs. Tags `extreme`, the
  kind (and `tier:unknown` when no volume is stored for the coin), then when priced the setup and `conviction:<c>`, and
  `leverage:<n>` when the verdict gave one. Approving hands the target, conviction and leverage to the desk: the ticket
  is still sized at 0.5% risk from the stop; on Propr the leverage (else the conviction through
  `PROPR_LEVERAGE_BY_CONFIDENCE`) picks the trade's cross leverage and the governor's per-coin cap, never the size.
- `score` = the event severity under `scoreVersion` `extremes-1` (`EXTREMES_SCORE_VERSION`), a different number from
  the scanner score: the feed labels it SEV, the detail says severity, and it never enters ledger stats or evidence.
- Liquidity tier from the latest stored 24 h volumes, regime from the coin's last 24 h of snapshots (`unknown` without).
  The `created` ledger entry holds the event facts and `{mark, verdictMark, killPx, eventTs, window, source}`, plus
  `pricing` (setup, stop, target, rr, zone, structural stop, ATR, the 24h and 72h levels, or `unpriced` with the
  reason), `conviction` and `leverage` when known.
- Status `new -> calculated -> ready`, actor system. A live row on the same `coin|direction|kind` is reported, not
  duplicated or refreshed. If creating it fails, the verdict and the push still go through (`opportunity: null`).
- It expires `EXTREMES_READY_TTL_H` (4) hours after it became ready, in the scanner and in this job (the serverless API
  has no scanner). The scanner never rescans it. The `Take:` push is the only push: no `Ready:` alert for these rows.
- The platform outcomes loop marks it at its horizons (fee-only, no costs); `groupStats` skips rows without costs, so
  it appears in no ledger stats group.

## Grading

Computed at read time from stored `scan_snapshots` (`src/server/extremes/grade.ts`), no job. Each horizon (4h, 24h,
72h) is `gradeEvent` from the replay re-based at the verdict: signed gross return in the graded direction (a take's
direction, else the event's fade side) from `verdictMark` at `verdictAt` (else the event mark at its bar) to the first
stored tick in [start + horizon, + 6 min]; null before the horizon or with no tick there. For a take, `killHit` says
whether a stored mark reached `killPx` between the start and now (capped at 72 h), and `stopped` caps each horizon's
return at the kill level once it was crossed (raw otherwise). The summary groups by stance and by kind: n, graded n
(24 h), `returnStats` per horizon (raw and stopped), kill-hit rate over takes. `bun run extremes score [--days 30]`
prints it (needs `DATABASE_URL`).
