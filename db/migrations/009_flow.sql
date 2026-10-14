-- Flow (SPEC.md § Flow F0.1): non-HL venue metrics (Coinalyze aggregate
-- `agg`, or a spot exchange code), one row per (asset, venue, metric, ts).
-- Volume and liquidation metrics are per 15-min interval values. HL OI and
-- funding stay in intel_snapshots. 90-day retention (pruned by
-- /cron/backfill). Also lets a Telegram /digest log a review (F0.6).
-- Apply after 008; safe to re-run.
create table if not exists intel_flow (
  asset  text not null,
  venue  text not null,
  metric text not null check (metric in ('oi_usd', 'funding', 'long_short_ratio', 'liq_long_usd', 'liq_short_usd', 'perp_volume_usd', 'perp_buy_volume_usd', 'spot_volume_usd')),
  value  double precision not null,
  ts     timestamptz not null,
  primary key (asset, venue, metric, ts)
);
create index if not exists intel_flow_ts_idx on intel_flow (ts);

alter table intel_reviews drop constraint if exists intel_reviews_via_check;
alter table intel_reviews add constraint intel_reviews_via_check check (via in ('ui', 'deeplink', 'telegram_digest'));
