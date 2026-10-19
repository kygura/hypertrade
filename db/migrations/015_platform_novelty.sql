-- Novelty journal (FEATURES.md section 4): one entry per coin per closed daily
-- bar, id `${bar_date}:${coin}`. The entry is the zod-validated NoveltyEntry; bar_date is
-- kept apart for range reads and the 365-day prune.
create table if not exists platform_novelty (
  id       text primary key,
  bar_date text  not null,
  entry    jsonb not null
);
create index if not exists platform_novelty_bar_idx on platform_novelty (bar_date);
