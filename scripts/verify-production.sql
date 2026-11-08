-- READ-ONLY production checks for supabase/migrations/20261108000000_init.sql.
-- Paste into the Supabase SQL Editor (runs as postgres). It changes nothing.
-- result: PASS / FAIL / CHECK (could not be determined from SQL; verify by hand as described).
-- The three staff checks pass only after staff accounts exist (docs/SETUP.md step 3).
with
tbl as (
  select c.oid, c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
all_tables(name) as (values
  ('outlets'),('staff'),('staff_outlets'),('settings'),('materials'),('material_prices'),('menu_items'),
  ('recipe_versions'),('recipe_items'),('pos_aliases'),('suppliers'),('stock_days'),('stock_entries'),
  ('wastage'),('sales_imports'),('sales'),('purchase_bills'),('purchase_lines'),('client_requests'),('audit_log')),
-- per the migration's trigger lists
expect_trigger(tgname, relname) as (
  select 'audit', unnest(array['outlets','staff','staff_outlets','settings','materials','material_prices','menu_items',
    'recipe_versions','recipe_items','pos_aliases','suppliers','stock_days','stock_entries','wastage','sales_imports',
    'sales','purchase_bills','purchase_lines'])
  union all
  select g, unnest(array['outlets','staff','settings','materials','material_prices','menu_items','recipe_versions',
    'recipe_items','pos_aliases','suppliers','stock_days','stock_entries','wastage','sales_imports','sales',
    'purchase_bills','purchase_lines','client_requests','audit_log'])
  from unnest(array['no_delete','no_truncate']) g
  union all
  select 'only_void', unnest(array['material_prices','recipe_versions','stock_entries','wastage','sales','purchase_bills','purchase_lines'])
  union all
  select 'no_update', unnest(array['recipe_items','sales_imports','client_requests','audit_log'])
),
actual_trigger as (
  select t.tgname::text as tgname, c.relname::text as relname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal and t.tgenabled <> 'D'
),
trigger_gaps as (
  select e.tgname, string_agg(e.relname, ', ' order by e.relname) as missing, count(*) as n
  from expect_trigger e left join actual_trigger a using (tgname, relname)
  where a.tgname is null group by e.tgname
),
-- functions the browser's role may execute (22 in public + 4 helpers used by RLS / app_state)
expect_fn(fn) as (values
  ('public.app_state'),('public.save_settings'),('public.add_material'),('public.add_prep'),('public.update_material'),
  ('public.set_price'),('public.archive_material'),('public.add_menu'),('public.archive_menu'),('public.save_recipe'),
  ('public.map_alias'),('public.import_sales'),('public.void_sale'),('public.void_sales_day'),('public.save_stock'),
  ('public.clear_stock_day'),('public.reopen_day'),('public.add_wastage'),('public.void_wastage'),('public.save_purchase'),
  ('public.void_purchase_line'),('public.applied_requests'),
  ('private.is_staff'),('private.my_role'),('private.can_outlet'),('private.recipes_json')),
fn as (
  select p.oid, n.nspname || '.' || p.proname as fn, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prokind = 'f'
),
auth_fn as (select fn from fn where has_function_privilege('authenticated', oid, 'execute')),
tpriv as (
  select r.role, t.relname, p.priv
  from tbl t
  cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
  where has_table_privilege(r.role, t.oid, p.priv)
),
api_schemas as (
  select string_agg(cfg, ',') as cfg
  from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) cfg
  where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%'
),
checks(result, name, detail) as (
  -- structure
  select case when count(*) = 20 and count(*) filter (where t.oid is null) = 0 then 'PASS' else 'FAIL' end,
         'all 20 tables exist',
         coalesce('missing: ' || string_agg(a.name, ', ') filter (where t.oid is null), count(t.oid)::text)
    from all_tables a left join tbl t on t.relname = a.name
  union all
  select case when bool_and(relrowsecurity) then 'PASS' else 'FAIL' end, 'RLS enabled on every table',
         string_agg(relname, ', ') filter (where not relrowsecurity) from tbl
  union all
  select case when count(*) = 19 and bool_and(cmd = 'SELECT') then 'PASS' else 'FAIL' end,
         'RLS: 19 policies, all read-only (no policy allows writes)',
         count(*) || ' policies' || coalesce('; non-SELECT: ' || string_agg(tablename || '.' || policyname || '=' || cmd, ', ') filter (where cmd <> 'SELECT'), '')
    from pg_policies where schemaname = 'public'
  union all
  select case when bool_and(owner = 'postgres') then 'PASS' else 'FAIL' end,
         'tables owned by postgres (backups read past RLS)', string_agg(distinct owner, ', ') from tbl
  -- table privileges (has_table_privilege sees every grant path, incl. PUBLIC and role membership)
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'anon has NO table privileges',
         string_agg(relname || ':' || priv, ', ' order by relname, priv) from tpriv where role = 'anon'
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'authenticated has no write privileges',
         string_agg(relname || ':' || priv, ', ' order by relname, priv) from tpriv where role = 'authenticated' and priv <> 'SELECT'
  union all
  select case when count(*) = 19 and count(*) filter (where relname = 'client_requests') = 0 then 'PASS' else 'FAIL' end,
         'authenticated can SELECT exactly the 19 app tables (not client_requests)',
         count(*) || ' tables' || coalesce('; missing: ' || (select string_agg(a.name, ', ') from all_tables a
           where a.name <> 'client_requests' and not exists (select 1 from tpriv p where p.role = 'authenticated' and p.priv = 'SELECT' and p.relname = a.name)), '')
    from tpriv where role = 'authenticated' and priv = 'SELECT'
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'service_role has no write privileges',
         string_agg(relname || ':' || priv, ', ' order by relname, priv) from tpriv where role = 'service_role' and priv <> 'SELECT'
  -- function privileges
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'anon can execute no functions',
         string_agg(fn, ', ' order by fn) from fn where has_function_privilege('anon', oid, 'execute')
  union all
  select case when (select count(*) from expect_fn e where e.fn not in (select fn from auth_fn)) = 0
               and (select count(*) from auth_fn a where a.fn not in (select fn from expect_fn)) = 0 then 'PASS' else 'FAIL' end,
         'authenticated can execute exactly the 22 app functions + 4 helpers',
         (select count(*) from auth_fn)::text
         || coalesce('; missing: ' || (select string_agg(e.fn, ', ') from expect_fn e where e.fn not in (select fn from auth_fn)), '')
         || coalesce('; unexpected: ' || (select string_agg(a.fn, ', ') from auth_fn a where a.fn not in (select fn from expect_fn)), '')
  union all
  select case when count(*) filter (where fn <> 'public.app_state' and not prosecdef) = 0
               and count(*) filter (where fn = 'public.app_state' and prosecdef) = 0 then 'PASS' else 'FAIL' end,
         'write functions are SECURITY DEFINER; app_state is SECURITY INVOKER (RLS applies)',
         string_agg(fn || case when prosecdef then ' (definer)' else ' (invoker)' end, ', ')
           filter (where (fn <> 'public.app_state' and not prosecdef) or (fn = 'public.app_state' and prosecdef))
    from fn where fn like 'public.%'
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'every SECURITY DEFINER function pins search_path',
         string_agg(fn, ', ') from fn
   where prosecdef and not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')
  union all
  select case when not has_schema_privilege('anon', 'private', 'USAGE') then 'PASS' else 'FAIL' end,
         'anon has no access to the private schema', null
  union all
  select case when cfg is null then 'CHECK' when cfg like '%private%' then 'FAIL' else 'PASS' end,
         'private schema not exposed through the API',
         coalesce(cfg, 'not readable from SQL: confirm Settings > Data API > Exposed schemas does not list "private"')
    from api_schemas
  -- history protection triggers (exact table lists from the migration)
  union all
  select case when not exists (select 1 from trigger_gaps where tgname in ('no_delete', 'no_truncate')) then 'PASS' else 'FAIL' end,
         'delete + truncate guards on all 19 protected tables (38 triggers)',
         (select count(*) from actual_trigger where tgname in ('no_delete', 'no_truncate'))::text
         || coalesce('; missing: ' || (select string_agg(tgname || ' on ' || missing, '; ') from trigger_gaps where tgname in ('no_delete', 'no_truncate')), '')
  union all
  select case when not exists (select 1 from trigger_gaps where tgname = 'audit') then 'PASS' else 'FAIL' end,
         'audit triggers on all 18 audited tables',
         (select count(*) from actual_trigger where tgname = 'audit')::text
         || coalesce('; missing: ' || (select missing from trigger_gaps where tgname = 'audit'), '')
  union all
  select case when not exists (select 1 from trigger_gaps where tgname in ('only_void', 'no_update')) then 'PASS' else 'FAIL' end,
         'void-only (7 tables) and immutable (4 tables) triggers',
         (select count(*) from actual_trigger where tgname in ('only_void', 'no_update'))::text
         || coalesce('; missing: ' || (select string_agg(tgname || ' on ' || missing, '; ') from trigger_gaps where tgname in ('only_void', 'no_update')), '')
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'no table is in a Realtime publication (would break the restore test)',
         string_agg(tablename, ', ') from pg_publication_tables where schemaname = 'public'
  -- configuration rows
  union all
  select case when (select string_agg(name, ',' order by name) from public.outlets) = 'Areekode,Kondotty'
               and (select count(*) from public.settings) = 1 then 'PASS' else 'FAIL' end,
         'outlets (Areekode, Kondotty) and settings row present',
         (select string_agg(name, ',' order by name) from public.outlets)
  -- staff (pass after docs/SETUP.md step 3)
  union all
  select case when count(*) = 1 then 'PASS' else 'FAIL' end, 'exactly one active owner', count(*)::text
    from public.staff where role = 'owner' and active
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'every staff row matches a login (same id and email)',
         string_agg(s.email, ', ')
    from public.staff s left join auth.users u on u.id = s.user_id and lower(u.email) = s.email where u.id is null
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'every active non-owner has at least one outlet',
         string_agg(s.email, ', ')
    from public.staff s where s.active and s.role <> 'owner'
     and not exists (select 1 from public.staff_outlets o where o.user_id = s.user_id)
  union all
  select case when count(*) = 0 then 'PASS' else 'FAIL' end, 'no logins without a staff row (sign-ups must be off)',
         string_agg(u.email, ', ')
    from auth.users u where not exists (select 1 from public.staff s where s.user_id = u.id)
  union all
  select case when coalesce(sum(problems), 0) = 0 then 'PASS' else 'FAIL' end, 'integrity report clean',
         string_agg(check_name || '=' || problems, ', ') filter (where problems > 0)
    from private.integrity_report()
)
select result, name, detail from checks
order by case result when 'FAIL' then 0 when 'CHECK' then 1 else 2 end, name;
