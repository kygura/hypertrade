-- Narrative alerts (docs/SPEC.md § Narratives N3): stage changes and automatic
-- contrast reads land in intel_alerts with kind 'narrative' (asset = narrative id).
alter table intel_alerts drop constraint if exists intel_alerts_kind_check;
alter table intel_alerts add constraint intel_alerts_kind_check check (kind in ('mapper', 'catalyst', 'docwatch', 'terminal', 'flow', 'narrative'));
