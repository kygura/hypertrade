-- Setups ledger (src/shared/setups.ts, src/server/setups/store.ts): one row per setup,
-- the full zod-parsed setup in `body`; the scalar columns exist to filter and order.
-- data/setups/ledger.json is an export of this table for the stateless routine session.
create table if not exists setups (
  id         text        primary key,
  setup_id   text,
  asset      text        not null,
  direction  text        not null,
  status     text        not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  body       jsonb       not null
);
create index if not exists setups_status_idx on setups (status, updated_at desc);
