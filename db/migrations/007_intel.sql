-- Intel: LLM trading tools (SPEC.md § Intel). Manual positions, watchlist,
-- the snapshot store, exposure graph, events/clusters/alerts, briefs, the
-- journal's notes and reports, theses, doc watches, settings and the LLM
-- cache. Lists live in jsonb, not arrays (db.ts runs with fetch_types off).
-- Apply after 006; safe to re-run.

-- Manual positions (source 'manual'); hl and desk positions are read live.
create table if not exists intel_positions (
  id         uuid primary key default gen_random_uuid(),
  asset      text not null,
  side       text not null check (side in ('long', 'short')),
  size       double precision not null check (size > 0),
  entry_px   double precision not null check (entry_px > 0),
  stop_px    double precision check (stop_px > 0),
  leverage   double precision not null default 1 check (leverage between 1 and 50),
  venue      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Watched assets in display order; empty falls back to DESK_WATCHLIST.
create table if not exists intel_watchlist (
  asset text primary key,
  tags  jsonb not null default '[]'::jsonb,
  ord   integer not null default 0
);

-- A UI open or a Telegram deep-link click: the next brief's baseline.
create table if not exists intel_reviews (
  id       uuid primary key default gen_random_uuid(),
  ts       timestamptz not null default now(),
  via      text not null check (via in ('ui', 'deeplink')),
  brief_id uuid
);
create index if not exists intel_reviews_ts_idx on intel_reviews (ts desc);

-- Per-asset market snapshot, written by /cron/collect. 90-day retention.
create table if not exists intel_snapshots (
  asset       text not null,
  ts          timestamptz not null,
  price       double precision not null,
  vol24h      double precision,
  funding     double precision,
  oi_usd      double precision,
  premium     double precision,
  basis       double precision,
  depth_bid_1 double precision,
  depth_ask_1 double precision,
  depth_bid_2 double precision,
  depth_ask_2 double precision,
  spread_bps  double precision,
  primary key (asset, ts)
);
create index if not exists intel_snapshots_ts_idx on intel_snapshots (ts);

-- Exposure graph. One edge per (src, dst, type); user edges are never
-- overwritten by seed or LLM refreshes.
create table if not exists intel_edges (
  id            uuid primary key default gen_random_uuid(),
  src           text not null,
  dst           text not null,
  type          text not null check (type in ('direct', 'settles_on', 'collateral', 'depends_on_stable', 'primary_venue', 'bridge', 'narrative', 'macro_beta')),
  weight        double precision not null,
  source        text,
  last_verified timestamptz,
  origin        text not null check (origin in ('seed', 'llm', 'user')),
  created_at    timestamptz not null default now(),
  unique (src, dst, type)
);
create index if not exists intel_edges_dst_idx on intel_edges (dst);

-- Groups of near-duplicate headlines; extraction runs once per cluster.
create table if not exists intel_clusters (
  id         uuid primary key default gen_random_uuid(),
  label      text,
  entities   jsonb not null default '[]'::jsonb,
  extraction jsonb,
  first_seen timestamptz not null,
  last_seen  timestamptz not null,
  mapped_at  timestamptz
);
create index if not exists intel_clusters_last_seen_idx on intel_clusters (last_seen desc);

-- Ingested items and scheduled catalysts. `key` is the source's own identity
-- (feed guid, proposal id, url hash), so re-ingesting updates instead of duplicating.
create table if not exists intel_events (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,
  cluster_id   uuid references intel_clusters on delete set null,
  type         text not null,
  title        text not null,
  summary      text,
  entities     jsonb not null default '[]'::jsonb,
  assets       jsonb not null default '[]'::jsonb,
  magnitude    text not null check (magnitude in ('low', 'med', 'high')),
  sources      jsonb not null default '[]'::jsonb,
  origin       text not null,
  first_seen   timestamptz not null,
  scheduled_at timestamptz,
  catalyst     jsonb,
  tag          text not null check (tag in ('observed', 'hypothesis')),
  created_at   timestamptz not null default now()
);
create index if not exists intel_events_first_seen_idx on intel_events (first_seen desc);
create index if not exists intel_events_scheduled_idx on intel_events (scheduled_at) where scheduled_at is not null;
create index if not exists intel_events_cluster_idx on intel_events (cluster_id);

-- Alerts. Dedupe (SPEC I0.11 / I0.13): ref is the cluster id (mapper), event
-- id (catalyst), watch change id (docwatch) or brief id (terminal);
-- time_window is the catalyst window ('24h' | '1h'), '' otherwise.
create table if not exists intel_alerts (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('mapper', 'catalyst', 'docwatch', 'terminal')),
  ref         text not null,
  time_window text not null default '',
  asset       text not null,
  title       text not null,
  event_type  text,
  line        jsonb not null,
  path        jsonb not null default '[]'::jsonb,
  edge_type   text,
  hops        integer not null default 0,
  path_weight double precision not null default 1,
  sources     jsonb not null default '[]'::jsonb,
  materiality double precision not null,
  priced_in   jsonb,
  route       text not null check (route in ('push', 'batch')),
  feedback    smallint check (feedback in (-1, 1)),
  trace       jsonb,
  created_at  timestamptz not null default now(),
  unique (kind, ref, asset, time_window)
);
create index if not exists intel_alerts_created_idx on intel_alerts (created_at desc);

-- Stored terminal briefs (UI and cron); body holds items, alerts, catalysts, lines, trace.
create table if not exists intel_briefs (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  surface    text not null check (surface in ('ui', 'cron')),
  since      timestamptz not null,
  silent     boolean not null,
  body       jsonb not null
);
create index if not exists intel_briefs_surface_idx on intel_briefs (surface, created_at desc);

-- LLM results by (cache key, prompt version). Row count since 00:00 UTC is the daily cap.
create table if not exists intel_llm_cache (
  key            text not null,
  prompt_version text not null,
  output         jsonb not null,
  usage          jsonb,
  created_at     timestamptz not null default now(),
  primary key (key, prompt_version)
);
create index if not exists intel_llm_cache_created_idx on intel_llm_cache (created_at);

-- Journal: operator note plus the LLM's setup tag and note summary per trade id.
create table if not exists intel_trade_notes (
  trade_id   text primary key,
  note       text,
  tag        text,
  summary    jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists intel_reports (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('journal_weekly', 'feedback_weekly')),
  created_at timestamptz not null default now(),
  body       jsonb not null
);
create index if not exists intel_reports_kind_idx on intel_reports (kind, created_at desc);

create table if not exists intel_theses (
  id           uuid primary key default gen_random_uuid(),
  text         text not null,
  assets       jsonb not null default '[]'::jsonb,
  claims       jsonb not null default '[]'::jsonb,
  invalidation jsonb not null default '[]'::jsonb,
  wrong_if     jsonb not null default '[]'::jsonb,
  trace        jsonb,
  created_at   timestamptz not null default now(),
  checked_at   timestamptz
);

create table if not exists intel_watches (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('url', 'evm_contract', 'evm_wallet')),
  target        text not null,
  chain         text,
  asset         text,
  label         text not null,
  last_hash     text,
  last_snapshot jsonb,
  checked_at    timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);

create table if not exists intel_watch_changes (
  id        uuid primary key default gen_random_uuid(),
  watch_id  uuid not null references intel_watches on delete cascade,
  ts        timestamptz not null default now(),
  from_hash text,
  to_hash        text not null,
  diff           text,
  facts          jsonb not null default '[]'::jsonb,
  detail         jsonb,
  lines          jsonb not null default '[]'::jsonb,
  alerted_assets jsonb not null default '[]'::jsonb,
  trace     jsonb
);
create index if not exists intel_watch_changes_watch_idx on intel_watch_changes (watch_id, ts desc);

-- Switches and cursors (lease holders, last sweep times, thresholds).
create table if not exists intel_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
