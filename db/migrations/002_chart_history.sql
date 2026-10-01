-- Chart history: source-tagged candles at every timeframe, sync bookkeeping,
-- and hourly funding. Apply after 001_init.sql.

-- Which venue a bar came from: 'hl' (Hyperliquid), or 'binance' / 'bitstamp'
-- for history older than anything Hyperliquid serves.
alter table candles add column if not exists src text not null default 'hl';

-- The old daily backfill stored CoinGecko's free OHLC endpoint as tf='1d',
-- but that endpoint returns 4-day bars for any range over 30 days, with no
-- volume. Every other writer sets v, so `v is null` selects exactly those
-- rows; the new sync refills real daily bars on the next request.
delete from candles where v is null;

-- Per (coin, series) sync bookkeeping. series is a timeframe ('1m'..'1M') or
-- 'funding'.
create table if not exists sync_state (
  coin        text not null,
  series      text not null,
  -- Hyperliquid has nothing older than this: the coin's listing, or the edge
  -- of HL's 5000-bar window (which moves forward for LTF intervals).
  hl_floor    timestamptz,
  -- Per external source: {"binance": {"status": "ok"|"none", "floor": ms, "exhausted": bool}, ...}
  ext         jsonb not null default '{}'::jsonb,
  synced_at   timestamptz,
  -- Last time a chart asked for this series; the cron keeps recently viewed
  -- coins warm so their LTF history keeps accumulating.
  accessed_at timestamptz,
  error       text,
  primary key (coin, series)
);

-- Hourly funding settlements from Hyperliquid fundingHistory.
create table if not exists funding (
  coin    text not null,
  ts      timestamptz not null,
  rate    double precision not null, -- hourly rate, fraction
  premium double precision not null, -- premium sample for the hour, fraction
  primary key (coin, ts)
);
