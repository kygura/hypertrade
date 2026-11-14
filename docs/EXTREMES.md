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
   `{key, stance: take|watch|pass, direction?, killPx?, cause, sources?}`. `take` needs a
   direction and a kill level on the right side of the live mark (422 otherwise) and sends one
   push linking to the coin page. `watch` and `pass` are stored, no push. One verdict per event.
   The session never writes an entry, a target or a size.

`GET /api/extremes?days=7` lists events with their delivery and verdict.

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

## Not built

- One-tap approve. A platform `Opportunity` needs a score, a scanner feature vector and
  book-based costs that a verdict does not have; inventing them would be false data. It needs
  an Opportunity source without a score and a cost step for non-scanner ideas.
- The mark at verdict time is returned and pushed, not stored, so verdicts are not graded yet.
