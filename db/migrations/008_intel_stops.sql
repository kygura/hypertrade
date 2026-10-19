-- Intel: stop-loss triggers captured from the watched Hyperliquid account
-- (DESK_WATCH_ADDRESS) on each /cron/collect, one row per (asset, side) per
-- collect. The journal reads them to compute R for HL trades (docs/SPEC.md § Intel
-- I0.15). 180-day retention (pruned by /cron/backfill). Apply after 007; safe
-- to re-run.
create table if not exists intel_stops (
  asset   text not null,
  side    text not null check (side in ('long', 'short')),
  ts      timestamptz not null,
  stop_px double precision not null check (stop_px > 0),
  primary key (asset, side, ts)
);
create index if not exists intel_stops_ts_idx on intel_stops (ts);
