-- Platform (docs/SPEC.md § Platform P0.6–P0.12): the crawled address book and
-- positions, liquidation and scan snapshots, opportunities and the
-- append-only decision ledger. Lists live in jsonb (db.ts runs with
-- fetch_types off). Apply after 010; safe to re-run.

-- Every address the WS saw trade. The crawler ranks these (P0.6).
create table if not exists hl_addresses (
  address          text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  polled_at        timestamptz,
  notional_usd     double precision not null default 0 check (notional_usd >= 0),
  position_count   integer not null default 0 check (position_count >= 0),
  min_liq_distance double precision check (min_liq_distance >= 0)
);
-- Crawler candidate scan: unpolled first, then stalest.
create index if not exists hl_addresses_polled_idx on hl_addresses (polled_at asc nulls first);

-- Latest position per (address, coin) (P0.7). A closed position is deleted.
create table if not exists hl_positions (
  address        text not null references hl_addresses (address),
  coin           text not null,
  szi            double precision not null check (szi <> 0),
  entry_px       double precision not null check (entry_px > 0),
  position_value double precision not null check (position_value >= 0),
  liquidation_px double precision check (liquidation_px > 0),
  leverage       double precision check (leverage > 0),
  updated_at     timestamptz not null,
  primary key (address, coin)
);
-- Live liqmap aggregation reads by coin.
create index if not exists hl_positions_coin_idx on hl_positions (coin);

-- Opens, closes and > 1% moves in szi or liquidationPx (P0.7). Pruned at retention.
create table if not exists hl_position_changes (
  id                  bigserial primary key,
  address             text not null,
  coin                text not null,
  ts                  timestamptz not null,
  kind                text not null check (kind in ('open', 'close', 'change')),
  szi                 double precision,
  liquidation_px      double precision,
  prev_szi            double precision,
  prev_liquidation_px double precision
);
create index if not exists hl_position_changes_ts_idx on hl_position_changes (ts);

-- 15-min bucketed liquidation map per coin on the fixed log-price grid.
-- buckets: [{idx, longUsd, shortUsd}]. Pruned at retention.
create table if not exists liqmap_snapshots (
  coin       text not null,
  ts         timestamptz not null,
  mark       double precision not null check (mark > 0),
  bucket_bps double precision not null check (bucket_bps > 0),
  buckets    jsonb not null,
  primary key (coin, ts)
);
create index if not exists liqmap_snapshots_ts_idx on liqmap_snapshots (ts);

-- Raw scan inputs per asset every 5 min: rebuilds the z-score ring at boot (P0.9). Pruned at retention.
create table if not exists scan_snapshots (
  coin   text not null,
  ts     timestamptz not null,
  inputs jsonb not null,
  primary key (coin, ts)
);
create index if not exists scan_snapshots_ts_idx on scan_snapshots (ts);

-- The projection of the ledger the feed reads (P0.10, P0.11).
create table if not exists opportunities (
  id              uuid primary key default gen_random_uuid(),
  coin            text not null,
  direction       text not null check (direction in ('long', 'short')),
  setup_kind      text not null,
  trade_type      text not null check (trade_type in ('directional')),
  status          text not null check (status in ('new', 'investigating', 'calculated', 'ready', 'approved', 'rejected', 'expired', 'open', 'closed')),
  score           double precision not null,
  score_version   text not null,
  net_edge_bps    double precision,
  gross_edge_bps  double precision,
  edge_basis      text not null check (edge_basis in ('unvalidated', 'ledger')),
  costs           jsonb,
  tags            jsonb not null default '[]'::jsonb,
  liquidity_tier  smallint not null check (liquidity_tier between 1 and 3),
  regime          text not null,
  invalidation    text not null,
  entry_px        double precision check (entry_px > 0),
  stop_px         double precision check (stop_px > 0),
  target_px       double precision check (target_px > 0),
  invalidation_px double precision check (invalidation_px > 0),
  dedupe_key      text not null,
  snoozed_until   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Creation or the last status move; rescans leave it alone (ready expiry measures from it).
  status_changed_at timestamptz not null default now()
);
-- One live opportunity per (coin, direction, setupKind). The status list is LIVE_STATUSES in src/shared/platform.ts.
create unique index if not exists opportunities_live_dedupe on opportunities (dedupe_key)
  where status in ('new', 'investigating', 'calculated', 'ready', 'approved', 'open');
create index if not exists opportunities_status_score_idx on opportunities (status, score desc);

-- Append-only decision ledger: the source of truth (P0.12). Never pruned.
create table if not exists ledger_entries (
  id             bigserial primary key,
  opportunity_id uuid not null references opportunities (id),
  kind           text not null check (kind in ('created', 'status', 'costs', 'research', 'decision', 'outcome')),
  payload        jsonb not null,
  created_at     timestamptz not null default now()
);
create index if not exists ledger_entries_opportunity_idx on ledger_entries (opportunity_id, id);
create index if not exists ledger_entries_kind_idx on ledger_entries (kind);

create or replace function ledger_entries_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger_entries is append-only (% refused)', tg_op;
end;
$$;
drop trigger if exists ledger_entries_no_update_delete on ledger_entries;
create trigger ledger_entries_no_update_delete before update or delete on ledger_entries
  for each row execute function ledger_entries_append_only();
drop trigger if exists ledger_entries_no_truncate on ledger_entries;
create trigger ledger_entries_no_truncate before truncate on ledger_entries
  for each statement execute function ledger_entries_append_only();
