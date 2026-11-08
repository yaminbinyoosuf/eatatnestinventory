-- Structure fingerprint compared between the live database and a restored backup.
select 'tables', count(*) from pg_tables where schemaname in ('public', 'private')
union all select 'constraints', count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ('public', 'private')
union all select 'foreign_keys', count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' and c.contype = 'f'
union all select 'triggers', count(*) from pg_trigger t join pg_class r on r.oid = t.tgrelid join pg_namespace n on n.oid = r.relnamespace where not t.tgisinternal and n.nspname = 'public'
union all select 'rls_policies', count(*) from pg_policies where schemaname = 'public'
union all select 'rls_enabled_tables', count(*) from pg_class r join pg_namespace n on n.oid = r.relnamespace where n.nspname = 'public' and r.relkind = 'r' and r.relrowsecurity
union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
union all select 'indexes', count(*) from pg_indexes where schemaname = 'public';
-- exact definitions: any change to a function body, constraint, index, trigger or policy changes this hash
select 'definitions_md5', md5(string_agg(d, E'\n' order by d)) from (
  select 'F ' || n.nspname || '.' || p.proname || ' ' || pg_get_functiondef(p.oid) d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.prokind = 'f'
  union all select 'C ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(c.oid)
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ('public', 'private')
  union all select 'I ' || indexdef from pg_indexes where schemaname = 'public'
  union all select 'T ' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class r on r.oid = t.tgrelid
    join pg_namespace n on n.oid = r.relnamespace where not t.tgisinternal and n.nspname = 'public'
  union all select 'P ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || array_to_string(roles, ',')
    from pg_policies where schemaname = 'public'
  union all select 'A ' || c.relname || ' ' || r.role || ' ' || p.priv
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(r.role, c.oid, p.priv)
) x;
