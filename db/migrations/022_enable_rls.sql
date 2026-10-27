-- Supabase exposes the public schema through PostgREST, so a table without row level
-- security is readable and writable with the anon key. The app connects as a role that
-- bypasses RLS (postgres), so enabling it with no policies locks out the API roles only.
-- Covers every public table, not a fixed list: production had RLS on 34 of them set
-- outside the migrations, and a fresh database needs the same. Idempotent.
-- Tables added later must enable RLS in their own migration (migrate.test.ts checks).
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
