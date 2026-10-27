-- Supabase advisor 0013 (rls_disabled_in_public): these tables were reachable through the
-- anon/authenticated PostgREST roles. The app only connects over DATABASE_URL as the
-- table owner, which bypasses RLS, so enabling it with no policies closes the API surface
-- without touching app access. Matches the other public tables. Idempotent.
alter table if exists hl_addresses         enable row level security;
alter table if exists hl_position_changes  enable row level security;
alter table if exists hl_positions         enable row level security;
alter table if exists intel_flow           enable row level security;
alter table if exists intel_research       enable row level security;
alter table if exists lab_trials           enable row level security;
alter table if exists ledger_entries       enable row level security;
alter table if exists liqmap_snapshots     enable row level security;
alter table if exists market_sectors       enable row level security;
alter table if exists opportunities        enable row level security;
alter table if exists platform_near_miss   enable row level security;
alter table if exists platform_novelty     enable row level security;
alter table if exists scan_snapshots       enable row level security;
alter table if exists schema_migrations    enable row level security;
alter table if exists setups               enable row level security;
