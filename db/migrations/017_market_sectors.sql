-- Narrative sector tags per coin (PS-B5): tagged once by the LLM from a fixed vocabulary,
-- cached here, only ever used to filter universes (never to score).
create table if not exists market_sectors (
  coin      text primary key,
  sectors   jsonb       not null,
  tagged_at timestamptz not null
);
