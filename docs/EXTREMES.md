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
   with delivery `none`.
3. **Wake** (`src/server/extremes/wake.ts`). One POST per run to `EXTREMES_WAKE_URL` (a Claude
   Code routine's fire endpoint) with `EXTREMES_WAKE_TOKEN`. Never retried: the endpoint has no
   idempotency and a retry starts a second session. With no target, or on any failure, each
   event's facts are pushed through the desk notifier instead.
4. **Verdict** (`POST /api/extremes/verdict`, bearer `LAB_API_TOKEN`). Body
   `{key, stance: take|watch|pass, direction?, killPx?, cause, sources?}`. Every stance stamps the live mark
   (`verdictMark`; null for `watch`/`pass` when no fresh mark exists). `take` needs a direction, a fresh mark (503
   otherwise) and a kill level on the right side of it (422 otherwise); it becomes an approvable opportunity (below)
   and sends one push linking to the coin page. `watch` and `pass` are stored, no push. One verdict per event. The
   session never writes an entry, a target or a size. Response: `{record, mark, pushed, opportunity, opportunityReason}`,
   `opportunity` = `{id, status, created}` or null.

`GET /api/extremes?days=7` (max 30) lists events with delivery, verdict and grade, plus a summary (below):
`{since, records: [ExtremeRecord & {grade}], summary}`.

## Research session

The routine's full prompt is `docs/EXTREMES-ROUTINE.md`: input format, the steps per event, the
take/watch/pass rules and the verdict call. The routine stores a copy of it, so edit the file
first and paste it into the routine.

## Calibration

`bun run extremes replay [--top 30] [--days N] [--events] [--source candles|snapshots]`
replays the detectors with the job's cooldown and grades the fade side at 4h, 24h and 72h,
absolute and against BTC. `bun run extremes` scans now. Both are keyless on candles.

Thresholds (`DEFAULT_EXTREME_THRESHOLDS`) are tuned for frequency, not for returns. On
2026-11-14, top 30 coins, about 5.4 weeks of 15-minute candles: `price_dislocation` fired 10
times (1.84 a week), 7 of them on one coin whose volatility regime broke. Ten events say
nothing about edge.

Not yet validated: Hyperliquid publishes no OI history, so `oi_flush` and `crowded_asymmetry`
are not evaluable on candles and their thresholds are set by analogy to the price scale.
Re-tune them with `--source snapshots` once `scan_snapshots` holds 14 days or more. Live
funding is the predicted rate and is noisier than the settled funding the candle replay reads.

## Approve

A `take` becomes a platform `Opportunity` (`src/server/extremes/opportunity.ts`), shown in the coin page's SETUP block
and decided there like any ready setup (APPROVE sizes the ticket through the desk governor from the stop; operator
cookie only, the research bearer cannot approve).

- `setupKind` = the event kind, `direction` = the verdict's, `entryPx` = the verdict mark, `stopPx` = `invalidationPx` =
  `killPx`, no target, no costs. Tags `extreme`, the kind (and `tier:unknown` when no volume is stored for the coin).
- `score` = the event severity under `scoreVersion` `extremes-1` (`EXTREMES_SCORE_VERSION`), a different number from
  the scanner score: the feed labels it SEV, the detail says severity, and it never enters ledger stats or evidence.
- Liquidity tier from the latest stored 24 h volumes, regime from the coin's last 24 h of snapshots (`unknown` without).
  The `created` ledger entry holds the event facts and `{mark, verdictMark, killPx, eventTs, window, source}`.
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
