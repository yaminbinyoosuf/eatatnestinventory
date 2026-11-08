-- LOCAL TESTING ONLY. Recreates the parts of a Supabase database that the
-- migration depends on (roles + auth.uid()), so the real migration can be
-- applied unchanged to a plain PostgreSQL 17. Never run this on Supabase.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator_local_pw'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
-- Other roles every Supabase project has; a dump may carry grants to them.
do $$ declare r text; begin
  foreach r in array array['supabase_admin','supabase_auth_admin','supabase_storage_admin','supabase_realtime_admin',
                           'supabase_replication_admin','supabase_read_only_user','dashboard_user','pgbouncer'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop; end $$;
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create table if not exists auth.users (id uuid primary key, email text unique);
-- Same definitions Supabase uses (claims set per request by PostgREST)
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.role', true),
                         (current_setting('request.jwt.claims', true)::jsonb ->> 'role')), '')::text $$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
