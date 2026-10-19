alter table intel_theses add column if not exists history jsonb not null default '[]'::jsonb;
