-- Re-applies the intended privileges. Run automatically by scripts/restore.sh, because restoring a
-- dump into a new Supabase project re-grants Supabase's broad default privileges on every table.
-- Identical to the privilege statements in the migration. Safe to run any number of times.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
  foreach t in array array['outlets','settings','materials','material_prices','menu_items','recipe_versions','recipe_items',
                           'pos_aliases','suppliers','stock_days','stock_entries','wastage','sales_imports','sales',
                           'purchase_bills','purchase_lines','staff','staff_outlets','audit_log'] loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
-- ---------------------------------------------------------------------
-- Function privileges: nothing is callable by anon; RPCs by authenticated.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on function
  public.app_state(), public.save_settings(uuid, int, numeric, numeric, numeric, numeric),
  public.add_material(uuid, text, text, numeric, numeric), public.add_prep(uuid, text, text),
  public.update_material(uuid, uuid, int, text, text, numeric, numeric, text, date),
  public.set_price(uuid, uuid, int, date, numeric), public.archive_material(uuid, uuid, int),
  public.add_menu(uuid, text, numeric), public.archive_menu(uuid, uuid, int),
  public.save_recipe(uuid, text, uuid, int, date, numeric, jsonb), public.map_alias(uuid, text, uuid),
  public.import_sales(uuid, text, text, jsonb), public.void_sale(uuid, uuid), public.void_sales_day(uuid, date, text[]),
  public.save_stock(uuid, text, date, int, boolean, jsonb), public.clear_stock_day(uuid, text, date, int),
  public.reopen_day(uuid, text, date, int), public.add_wastage(uuid, text, date, uuid, numeric, text, text),
  public.void_wastage(uuid, uuid), public.save_purchase(uuid, text, date, text, text, jsonb),
  public.void_purchase_line(uuid, uuid), public.applied_requests(uuid[])
to authenticated;
-- Supabase's default privileges grant broad rights on new objects; take back everything not intended.
revoke execute on all functions in schema private from authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated;
-- The service key is never used by the app. Even if it leaks, it cannot write business tables.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from service_role;
-- helpers RLS policies and app_state need when evaluated as the caller
grant execute on function private.is_staff(), private.my_role(), private.can_outlet(text),
  private.recipes_json(uuid, uuid) to authenticated;
