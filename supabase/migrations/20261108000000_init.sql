-- =====================================================================
-- eat@nest Inventory — permanent central database (Supabase Postgres)
--
-- Design rules (see docs/DATA-SAFETY.md):
--   * The browser may only READ tables (RLS-filtered). Every WRITE goes
--     through a SECURITY DEFINER function below, which checks the caller,
--     validates the input and runs as one transaction.
--   * Business history is never deleted: DELETE/TRUNCATE are blocked by
--     triggers; transactional rows are voided (voided_at/by/reason) and
--     master records are archived (archived_at/by).
--   * Every change to every business table is written to audit_log.
--   * Every write call carries a client request id (p_req). A repeated id
--     returns {"duplicate":true} instead of applying the change twice.
--   * Mutable records carry a version; a stale version raises NS409.
--
-- Error codes raised to the client:
--   NS400 validation problem    NS403 not allowed    NS409 changed by someone else
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------
-- Reference / configuration
-- ---------------------------------------------------------------------
create table public.outlets (
  name       text primary key check (name ~ '^[A-Za-z][A-Za-z ]{0,39}$'),
  created_at timestamptz not null default now()
);
insert into public.outlets(name) values ('Areekode'), ('Kondotty');

-- Staff accounts. user_id is the Supabase Auth user id (auth.users.id).
-- Deliberately no FK into the auth schema so the public schema can be
-- dumped and restored on its own; email lets a restored staff row be
-- re-linked to a re-created login (docs/RECOVERY.md).
create table public.staff (
  user_id    uuid primary key,
  email      text not null unique check (email = lower(email) and email like '%@%'),
  name       text not null check (length(btrim(name)) between 1 and 80),
  role       text not null check (role in ('owner', 'manager', 'staff')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.staff_outlets (
  user_id uuid not null references public.staff(user_id) on update cascade,  -- re-link after recovery (docs/RECOVERY.md)
  outlet  text not null references public.outlets(name),
  primary key (user_id, outlet)
);

create table public.settings (
  id          int primary key default 1 check (id = 1),
  target      numeric not null check (target > 0 and target < 100),
  t_watch     numeric not null check (t_watch >= 0),
  t_attention numeric not null,
  t_critical  numeric not null,
  version     int not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  check (t_watch <= t_attention and t_attention <= t_critical)
);
insert into public.settings(id, target, t_watch, t_attention, t_critical) values (1, 42, 3, 5, 10);

-- ---------------------------------------------------------------------
-- Master data
-- ---------------------------------------------------------------------
create table public.materials (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 100),
  unit        text not null check (unit in ('kg', 'l', 'pc', 'g', 'pack')),
  min_stock   numeric not null default 0 check (min_stock >= 0 and min_stock < 1e9),
  is_prep     boolean not null default false,
  archived_at timestamptz,
  archived_by uuid,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create unique index materials_active_name on public.materials (lower(btrim(name))) where archived_at is null;

create table public.material_prices (
  id             bigint generated always as identity primary key,
  material_id    uuid not null references public.materials(id),
  effective_date date not null,
  price          numeric not null check (price > 0 and price < 1e9),
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  voided_at      timestamptz,
  voided_by      uuid,
  void_reason    text
);
create unique index material_prices_active on public.material_prices (material_id, effective_date) where voided_at is null;

create table public.menu_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 100),
  price       numeric not null check (price > 0 and price < 1e7),
  archived_at timestamptz,
  archived_by uuid,
  version     int not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create unique index menu_items_active_name on public.menu_items (lower(btrim(name))) where archived_at is null;

-- A recipe version belongs to exactly one menu item OR one prep material.
create table public.recipe_versions (
  id               bigint generated always as identity primary key,
  menu_item_id     uuid references public.menu_items(id),
  prep_material_id uuid references public.materials(id),
  effective_from   date not null,
  yield            numeric check (yield is null or (yield > 0 and yield < 1e9)),
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  voided_at        timestamptz,
  voided_by        uuid,
  void_reason      text,
  check ((menu_item_id is null) <> (prep_material_id is null)),
  check (prep_material_id is null or yield is not null)
);
create unique index recipe_versions_menu_active on public.recipe_versions (menu_item_id, effective_from)
  where voided_at is null and menu_item_id is not null;
create unique index recipe_versions_prep_active on public.recipe_versions (prep_material_id, effective_from)
  where voided_at is null and prep_material_id is not null;

create table public.recipe_items (
  id                bigint generated always as identity primary key,
  recipe_version_id bigint not null references public.recipe_versions(id),
  line_no           int not null,
  material_id       uuid not null references public.materials(id),
  qty               numeric not null check (qty > 0 and qty < 1e9),
  unique (recipe_version_id, line_no)
);
create index recipe_items_material on public.recipe_items (material_id);

create table public.pos_aliases (
  alias        text primary key check (alias = lower(alias) and length(alias) between 1 and 200),
  menu_item_id uuid not null references public.menu_items(id),
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid()
);

create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create unique index suppliers_name on public.suppliers (lower(btrim(name)));

-- ---------------------------------------------------------------------
-- Transactions (outlet-scoped, immutable except for voiding)
-- ---------------------------------------------------------------------
create table public.stock_days (
  outlet     text not null references public.outlets(name),
  day        date not null,
  closed     boolean not null default false,
  closed_at  timestamptz,
  closed_by  uuid,
  version    int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (outlet, day)
);

create table public.stock_entries (
  id          bigint generated always as identity primary key,
  outlet      text not null,
  day         date not null,
  material_id uuid not null references public.materials(id),
  opening     numeric not null default 0 check (opening >= 0 and opening < 1e9),
  purchased   numeric not null default 0 check (purchased >= 0 and purchased < 1e9),
  stock_in    numeric not null default 0 check (stock_in >= 0 and stock_in < 1e9),
  stock_out   numeric not null default 0 check (stock_out >= 0 and stock_out < 1e9),
  closing     numeric check (closing is null or (closing >= 0 and closing < 1e9)),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  voided_at   timestamptz,
  voided_by   uuid,
  void_reason text,
  foreign key (outlet, day) references public.stock_days(outlet, day)
);
create unique index stock_entries_active on public.stock_entries (outlet, day, material_id) where voided_at is null;
create index stock_entries_material on public.stock_entries (material_id);

create table public.wastage (
  id          uuid primary key default gen_random_uuid(),
  outlet      text not null references public.outlets(name),
  day         date not null,
  material_id uuid not null references public.materials(id),
  qty         numeric not null check (qty > 0 and qty < 1e9),
  reason      text not null default '',
  responsible text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  voided_at   timestamptz,
  voided_by   uuid,
  void_reason text
);
create index wastage_outlet_day on public.wastage (outlet, day);
create index wastage_material on public.wastage (material_id);

create table public.sales_imports (
  id           uuid primary key default gen_random_uuid(),
  outlet       text not null references public.outlets(name),
  file_name    text not null default '',
  row_count    int not null check (row_count > 0),
  total_qty    numeric not null,
  total_amount numeric not null,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);

create table public.sales (
  id           uuid primary key default gen_random_uuid(),
  outlet       text not null references public.outlets(name),
  day          date not null,
  menu_item_id uuid not null references public.menu_items(id),
  qty          numeric not null check (qty > 0 and qty <= 1e6),
  amount       numeric not null check (amount >= 0 and amount < 1e10),
  import_id    uuid references public.sales_imports(id),
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  voided_at    timestamptz,
  voided_by    uuid,
  void_reason  text
);
-- one active row per outlet/day/menu item: re-imports replace, never double count
create unique index sales_active on public.sales (outlet, day, menu_item_id) where voided_at is null;
create index sales_menu_item on public.sales (menu_item_id);

create table public.purchase_bills (
  id          uuid primary key default gen_random_uuid(),
  outlet      text not null references public.outlets(name),
  day         date not null,
  supplier_id uuid references public.suppliers(id),
  invoice_no  text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  voided_at   timestamptz,
  voided_by   uuid,
  void_reason text
);
-- the same supplier invoice cannot be entered twice at an outlet
create unique index purchase_bills_invoice on public.purchase_bills
  (outlet, coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(invoice_no)))
  where voided_at is null and btrim(invoice_no) <> '';

create table public.purchase_lines (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references public.purchase_bills(id),
  outlet      text not null references public.outlets(name),
  day         date not null,
  material_id uuid not null references public.materials(id),
  qty         numeric not null check (qty > 0 and qty < 1e9),
  rate        numeric not null check (rate > 0 and rate < 1e9),
  amount      numeric not null check (amount >= 0 and amount < 1e12),
  bill_name   text not null default '',
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  voided_at   timestamptz,
  voided_by   uuid,
  void_reason text
);
create index purchase_lines_outlet_day on public.purchase_lines (outlet, day);
create index purchase_lines_bill on public.purchase_lines (bill_id);
create index purchase_lines_material on public.purchase_lines (material_id);

-- Idempotency ledger: one row per accepted write request.
create table public.client_requests (
  id         uuid primary key,
  op         text not null,
  user_id    uuid,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  table_name text not null,
  action     text not null,
  old_row    jsonb,
  new_row    jsonb
);
create index audit_log_at on public.audit_log (at);

-- ---------------------------------------------------------------------
-- Stored-XSS guard: the app renders names as HTML, and these values are
-- now shared between users, so free text may not contain < or >.
-- ---------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select * from (values ('materials','name'),('menu_items','name'),('suppliers','name'),('staff','name'),
                                 ('wastage','reason'),('wastage','responsible'),('purchase_bills','invoice_no'),
                                 ('purchase_lines','bill_name'),('sales_imports','file_name'),('pos_aliases','alias'),
                                 ('material_prices','note')) v(t, col) loop
    execute format('alter table public.%I add constraint %I check (%I !~ ''[<>]'')', c.t, c.col || ' must not contain < or >', c.col);
  end loop;
end $$;

-- No NaN / Infinity in any numeric column (Postgres numeric accepts them; they would break every calculation).
do $$
declare c record;
begin
  for c in select table_name, column_name from information_schema.columns
           where table_schema = 'public' and data_type = 'numeric' loop
    execute format('alter table public.%I add constraint %I check (%I is null or (%I <> ''NaN'' and %I < ''Infinity'' and %I > ''-Infinity''))',
                   c.table_name, c.column_name || ' must be a finite number', c.column_name, c.column_name, c.column_name, c.column_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------
create function private.audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.audit_log(user_id, table_name, action, old_row, new_row)
  values (auth.uid(), tg_table_name, tg_op,
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return null;
end $$;

create function private.forbid_delete() returns trigger language plpgsql as $$
begin
  raise exception 'Deleting from % is not allowed: business history is kept permanently (void or archive instead).', tg_table_name
    using errcode = 'NS403';
end $$;

-- Transaction rows may only change by being voided once; never edited in place.
create function private.only_void() returns trigger language plpgsql as $$
declare cols text[] := array['voided_at', 'voided_by', 'void_reason'];
begin
  if old.voided_at is not null then
    raise exception '% row is already voided and cannot change', tg_table_name using errcode = 'NS403';
  end if;
  if new.voided_at is null or (to_jsonb(new) - cols) is distinct from (to_jsonb(old) - cols) then
    raise exception 'Rows in % are never edited in place; void and re-enter instead', tg_table_name using errcode = 'NS403';
  end if;
  return new;
end $$;

create function private.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'NS403';
end $$;

do $$
declare t text;
begin
  -- audited tables
  foreach t in array array['outlets','staff','staff_outlets','settings','materials','material_prices','menu_items',
                           'recipe_versions','recipe_items','pos_aliases','suppliers','stock_days','stock_entries',
                           'wastage','sales_imports','sales','purchase_bills','purchase_lines'] loop
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function private.audit()', t);
  end loop;
  -- tables whose rows may never be deleted (staff_outlets is plain access config and may be)
  foreach t in array array['outlets','staff','settings','materials','material_prices','menu_items','recipe_versions',
                           'recipe_items','pos_aliases','suppliers','stock_days','stock_entries','wastage','sales_imports',
                           'sales','purchase_bills','purchase_lines','client_requests','audit_log'] loop
    execute format('create trigger no_delete before delete on public.%I for each row execute function private.forbid_delete()', t);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.forbid_delete()', t);
  end loop;
  -- immutable-except-void tables
  foreach t in array array['material_prices','recipe_versions','stock_entries','wastage','sales','purchase_bills','purchase_lines'] loop
    execute format('create trigger only_void before update on public.%I for each row execute function private.only_void()', t);
  end loop;
  -- fully immutable
  foreach t in array array['recipe_items','sales_imports','client_requests','audit_log'] loop
    execute format('create trigger no_update before update on public.%I for each row execute function private.forbid_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Permission helpers
-- ---------------------------------------------------------------------
create function private.is_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and active)
$$;

create function private.my_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.staff where user_id = auth.uid() and active
$$;

create function private.can_outlet(p_outlet text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.active
      and (s.role = 'owner' or exists (select 1 from public.staff_outlets so
                                       where so.user_id = s.user_id and so.outlet = p_outlet)))
$$;

create function private.require_staff() returns void language plpgsql stable set search_path = public, pg_temp as $$
begin
  if not private.is_staff() then
    raise exception 'This login is not set up for eat@nest. Ask the owner to add you.' using errcode = 'NS403';
  end if;
end $$;

create function private.require_manager() returns void language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform private.require_staff();
  if private.my_role() not in ('owner', 'manager') then
    raise exception 'Only a manager or the owner can change materials, prices, menu, recipes, settings or reopen a closed day.'
      using errcode = 'NS403';
  end if;
end $$;

create function private.require_outlet(p_outlet text) returns void language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform private.require_staff();
  if p_outlet is null or not exists (select 1 from public.outlets where name = p_outlet) then
    raise exception 'Unknown outlet "%"', p_outlet using errcode = 'NS400';
  end if;
  if not private.can_outlet(p_outlet) then
    raise exception 'You do not have access to the % outlet.', p_outlet using errcode = 'NS403';
  end if;
end $$;

-- Returns false when this request id was already applied (a safe retry).
create function private.begin_request(p_req uuid, p_op text) returns boolean
language plpgsql set search_path = public, pg_temp as $$
declare prev text;
begin
  if p_req is null then
    raise exception 'Missing request id' using errcode = 'NS400';
  end if;
  insert into public.client_requests(id, op, user_id) values (p_req, p_op, auth.uid()) on conflict (id) do nothing;
  if found then return true; end if;
  select op into prev from public.client_requests where id = p_req;
  if prev is distinct from p_op then
    raise exception 'Request id reused for a different operation' using errcode = 'NS400';
  end if;
  return false;
end $$;

-- Prices are shared by both outlets and drive every past food-cost figure. Staff may record a price
-- from a bill or stock entry only for recent dates; managers/owners for any date.
create function private.require_price_rights(p_day date) returns void language plpgsql stable set search_path = public, pg_temp as $$
begin
  if private.my_role() not in ('owner', 'manager') and (p_day < current_date - 7 or p_day > current_date + 1) then
    raise exception 'Only a manager can record a price for % (more than 7 days ago or in the future). Ask a manager to enter this.', p_day
      using errcode = 'NS403';
  end if;
end $$;

create function private.bad(msg text) returns void language plpgsql as $$
begin raise exception '%', msg using errcode = 'NS400'; end $$;

create function private.conflict(what text) returns void language plpgsql as $$
begin
  raise exception '% was changed by someone else since you loaded it. Reload to see the latest, then try again.', what
    using errcode = 'NS409';
end $$;

-- numeric from a jsonb field; '' / null -> null; non-numbers -> validation error
create function private.num(j jsonb, k text) returns numeric language plpgsql immutable as $$
begin
  if j -> k is null or jsonb_typeof(j -> k) = 'null' or j ->> k = '' then return null; end if;
  if jsonb_typeof(j -> k) <> 'number' then
    raise exception 'Field % must be a number', k using errcode = 'NS400';
  end if;
  return (j ->> k)::numeric;
end $$;

-- ---------------------------------------------------------------------
-- Row Level Security: read-only, filtered. No table grants for writing.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['outlets','staff','staff_outlets','settings','materials','material_prices','menu_items',
                           'recipe_versions','recipe_items','pos_aliases','suppliers','stock_days','stock_entries',
                           'wastage','sales_imports','sales','purchase_bills','purchase_lines','client_requests','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
  -- reference data readable by any active staff member
  foreach t in array array['outlets','settings','materials','material_prices','menu_items','recipe_versions',
                           'recipe_items','pos_aliases','suppliers'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy read_staff on public.%I for select to authenticated using (private.is_staff())', t);
  end loop;
  -- outlet data readable only for the caller's outlets (owners: all)
  foreach t in array array['stock_days','stock_entries','wastage','sales_imports','sales','purchase_bills','purchase_lines'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy read_outlet on public.%I for select to authenticated using (private.can_outlet(outlet))', t);
  end loop;
end $$;

grant select on public.staff, public.staff_outlets, public.audit_log to authenticated;
create policy read_self_or_owner on public.staff for select to authenticated
  using (user_id = auth.uid() or private.my_role() = 'owner');
create policy read_self_or_owner on public.staff_outlets for select to authenticated
  using (user_id = auth.uid() or private.my_role() = 'owner');
create policy read_owner on public.audit_log for select to authenticated
  using (private.my_role() = 'owner');
-- client_requests: no policy, no grant -> invisible to clients.

grant execute on function private.is_staff(), private.my_role(), private.can_outlet(text) to authenticated;

-- ---------------------------------------------------------------------
-- Read: whole application state in the shape the app renders from.
-- SECURITY INVOKER, so RLS decides what is returned. One call = one
-- consistent snapshot (and no PostgREST row-limit truncation).
-- ---------------------------------------------------------------------
create function private.recipes_json(p_menu uuid, p_prep uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'from', v.effective_from, 'yield', v.yield,
           'items', (select coalesce(jsonb_agg(jsonb_build_object('rm', i.material_id, 'q', i.qty) order by i.line_no), '[]'::jsonb)
                     from public.recipe_items i where i.recipe_version_id = v.id))
         order by v.effective_from), '[]'::jsonb)
  from public.recipe_versions v
  where v.voided_at is null
    and (v.menu_item_id = p_menu or v.prep_material_id = p_prep)
$$;
grant execute on function private.recipes_json(uuid, uuid) to authenticated;

create function public.app_state() returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare me public.staff;
begin
  select * into me from public.staff where user_id = auth.uid() and active;
  if not found then
    raise exception 'This login is not set up for eat@nest. Ask the owner to add you.' using errcode = 'NS403';
  end if;
  return jsonb_build_object(
    'at', now(),
    'me', jsonb_build_object('name', me.name, 'email', me.email, 'role', me.role,
            'outlets', (select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb)
                        from public.outlets o where private.can_outlet(o.name))),
    'set', (select jsonb_build_object('target', target, 't', jsonb_build_array(t_watch, t_attention, t_critical), 'version', version)
            from public.settings where id = 1),
    'rm', (select coalesce(jsonb_agg(jsonb_build_object(
              'id', m.id, 'name', m.name, 'unit', m.unit, 'min', m.min_stock, 'prep', m.is_prep,
              'archived', m.archived_at is not null, 'version', m.version,
              'prices', (select coalesce(jsonb_agg(jsonb_build_object('d', p.effective_date, 'p', p.price, 'note', p.note)
                                                   order by p.effective_date), '[]'::jsonb)
                         from public.material_prices p where p.material_id = m.id and p.voided_at is null),
              'rec', private.recipes_json(null, m.id))
            order by m.created_at, m.id), '[]'::jsonb) from public.materials m),
    'menu', (select coalesce(jsonb_agg(jsonb_build_object(
              'id', x.id, 'name', x.name, 'price', x.price, 'archived', x.archived_at is not null, 'version', x.version,
              'rec', private.recipes_json(x.id, null))
            order by x.created_at, x.id), '[]'::jsonb) from public.menu_items x),
    'inv', (select coalesce(jsonb_agg(jsonb_build_object(
              'd', e.day, 'o', e.outlet, 'rm', e.material_id, 'open', e.opening, 'pur', e.purchased,
              'inn', e.stock_in, 'out', e.stock_out, 'close', e.closing) order by e.day, e.id), '[]'::jsonb)
            from public.stock_entries e where e.voided_at is null),
    'days', (select coalesce(jsonb_object_agg(d.day || '|' || d.outlet, jsonb_build_object('closed', d.closed, 'v', d.version)), '{}'::jsonb)
             from public.stock_days d),
    'sales', (select coalesce(jsonb_agg(jsonb_build_object(
              'id', s.id, 'd', s.day, 'o', s.outlet, 'mid', s.menu_item_id, 'qty', s.qty, 'amt', s.amount) order by s.day, s.created_at), '[]'::jsonb)
              from public.sales s where s.voided_at is null),
    'waste', (select coalesce(jsonb_agg(jsonb_build_object(
              'id', w.id, 'd', w.day, 'o', w.outlet, 'rm', w.material_id, 'qty', w.qty, 'why', w.reason, 'who', w.responsible)
              order by w.day, w.created_at), '[]'::jsonb)
              from public.wastage w where w.voided_at is null),
    'buy', (select coalesce(jsonb_agg(jsonb_build_object(
              'id', l.id, 'd', l.day, 'o', l.outlet, 'rm', l.material_id, 'qty', l.qty, 'rate', l.rate, 'amt', l.amount,
              'bn', l.bill_name, 'sup', coalesce(sp.name, ''), 'inv', b.invoice_no) order by l.day, l.created_at), '[]'::jsonb)
            from public.purchase_lines l join public.purchase_bills b on b.id = l.bill_id
            left join public.suppliers sp on sp.id = b.supplier_id
            where l.voided_at is null),
    'alias', (select coalesce(jsonb_object_agg(a.alias, a.menu_item_id), '{}'::jsonb) from public.pos_aliases a)
  );
end $$;

-- =====================================================================
-- Write functions. All: SECURITY DEFINER, explicit search_path, caller
-- checked first, one transaction, idempotent on p_req.
-- =====================================================================
create function private.done(dup boolean, extra jsonb default '{}'::jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', true, 'duplicate', dup) || extra
$$;

-- ---------- settings ----------
create function public.save_settings(p_req uuid, p_version int, p_target numeric, p_t1 numeric, p_t2 numeric, p_t3 numeric)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'save_settings') then return private.done(true); end if;
  if not (p_target > 0 and p_target < 100) then perform private.bad('Target food cost must be between 0 and 100%.'); end if;
  if not (p_t1 >= 0 and p_t1 <= p_t2 and p_t2 <= p_t3) then
    perform private.bad('Watch ≤ Attention ≤ Critical, and none below 0.');
  end if;
  update public.settings set target = p_target, t_watch = p_t1, t_attention = p_t2, t_critical = p_t3,
         version = version + 1, updated_at = now(), updated_by = auth.uid()
   where id = 1 and version = p_version;
  if not found then perform private.conflict('Settings'); end if;
  return private.done(false);
end $$;

-- ---------- materials & prices ----------
create function private.lock_material(p_id uuid, p_version int) returns public.materials
language plpgsql set search_path = public, pg_temp as $$
declare m public.materials;
begin
  select * into m from public.materials where id = p_id for update;
  if not found then perform private.bad('That material no longer exists.'); end if;
  if m.archived_at is not null then perform private.bad(m.name || ' has been deleted (archived).'); end if;
  if p_version is not null and m.version <> p_version then perform private.conflict(m.name); end if;
  return m;
end $$;

create function private.put_price(p_material uuid, p_day date, p_price numeric, p_note text, p_reason text)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if not (p_price > 0) then perform private.bad('Price must be above 0.'); end if;
  update public.material_prices set voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   where material_id = p_material and effective_date = p_day and voided_at is null;
  insert into public.material_prices(material_id, effective_date, price, note) values (p_material, p_day, p_price, p_note);
end $$;

create function private.new_material(p_name text, p_unit text, p_min numeric, p_prep boolean) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare nid uuid;
begin
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' then perform private.bad('Enter a name.'); end if;
  if p_unit not in ('kg', 'l', 'pc', 'g', 'pack') then perform private.bad('Unknown unit.'); end if;
  if exists (select 1 from public.materials where lower(btrim(name)) = lower(p_name) and archived_at is null) then
    perform private.bad('A material called "' || p_name || '" already exists.');
  end if;
  insert into public.materials(name, unit, min_stock, is_prep) values (p_name, p_unit, coalesce(p_min, 0), p_prep)
  returning id into nid;
  return nid;
end $$;

create function public.add_material(p_req uuid, p_name text, p_unit text, p_price numeric, p_min numeric)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare nid uuid;
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'add_material') then return private.done(true); end if;
  if not (p_price > 0) then perform private.bad('Enter a price above 0.'); end if;
  if p_min < 0 then perform private.bad('Min stock cannot be negative.'); end if;
  nid := private.new_material(p_name, p_unit, p_min, false);
  insert into public.material_prices(material_id, effective_date, price, note) values (nid, date '2000-01-01', p_price, 'Initial');
  return private.done(false, jsonb_build_object('id', nid));
end $$;

create function public.add_prep(p_req uuid, p_name text, p_unit text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare nid uuid;
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'add_prep') then return private.done(true); end if;
  nid := private.new_material(p_name, p_unit, 0, true);
  return private.done(false, jsonb_build_object('id', nid));
end $$;

-- p_price_mode: 'fix' corrects the price in force on p_day; 'new' records a new price from p_day.
create function public.update_material(p_req uuid, p_id uuid, p_version int, p_name text, p_unit text, p_min numeric,
                                       p_price numeric, p_price_mode text, p_day date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.materials; cur public.material_prices;
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'update_material') then return private.done(true); end if;
  m := private.lock_material(p_id, p_version);
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' then perform private.bad('Enter a name.'); end if;
  if p_unit not in ('kg', 'l', 'pc', 'g', 'pack') then perform private.bad('Unknown unit.'); end if;
  if coalesce(p_min, 0) < 0 then perform private.bad('Min stock cannot be negative.'); end if;
  if exists (select 1 from public.materials where lower(btrim(name)) = lower(p_name) and archived_at is null and id <> p_id) then
    perform private.bad('A material called "' || p_name || '" already exists.');
  end if;
  if p_unit <> m.unit and (exists (select 1 from public.stock_entries where material_id = p_id)
                        or exists (select 1 from public.purchase_lines where material_id = p_id)
                        or exists (select 1 from public.wastage where material_id = p_id)
                        or exists (select 1 from public.recipe_items where material_id = p_id)) then
    perform private.bad('The unit of ' || m.name || ' cannot change: it already has stock, purchase, wastage or recipe records, '
                        || 'which would all be misread in the new unit. Add a new material with the correct unit instead.');
  end if;
  update public.materials set name = p_name, unit = p_unit, min_stock = coalesce(p_min, 0),
         version = version + 1, updated_at = now(), updated_by = auth.uid() where id = p_id;
  if p_price is not null then
    if not (p_price > 0) then perform private.bad('Price must be above 0.'); end if;
    if p_day is null then perform private.bad('Missing date for the price.'); end if;
    select * into cur from public.material_prices
     where material_id = p_id and voided_at is null and effective_date <= p_day
     order by effective_date desc limit 1;
    if cur.id is null or cur.price <> p_price then
      if p_price_mode = 'fix' and cur.id is not null then
        perform private.put_price(p_id, cur.effective_date, p_price, coalesce(cur.note, 'Price'), 'Corrected typing mistake');
      elsif p_price_mode in ('fix', 'new') then
        perform private.put_price(p_id, p_day, p_price, 'Edited', 'Replaced by edit');
      else
        perform private.bad('Unknown price change type.');
      end if;
    end if;
  end if;
  return private.done(false);
end $$;

create function public.set_price(p_req uuid, p_id uuid, p_version int, p_day date, p_price numeric)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'set_price') then return private.done(true); end if;
  perform private.lock_material(p_id, p_version);
  if p_day is null then perform private.bad('Missing date for the price.'); end if;
  perform private.put_price(p_id, p_day, p_price, 'Manual', 'Replaced by a new price for the same date');
  update public.materials set version = version + 1, updated_at = now(), updated_by = auth.uid() where id = p_id;
  return private.done(false);
end $$;

-- Materials/prep items in the CURRENT recipe of an active menu item or prep item cannot be archived:
-- edit those recipes first (which keeps the old versions as history).
create function private.current_recipe_users(p_material uuid) returns text
language sql stable set search_path = public, pg_temp as $$
  with latest as (
    select distinct on (coalesce(v.menu_item_id, v.prep_material_id)) v.*
    from public.recipe_versions v
    where v.voided_at is null and v.effective_from <= current_date
    order by coalesce(v.menu_item_id, v.prep_material_id), v.effective_from desc
  ), relevant as (
    select id, menu_item_id, prep_material_id from latest
    union
    select id, menu_item_id, prep_material_id from public.recipe_versions
     where voided_at is null and effective_from > current_date
  )
  select string_agg(distinct coalesce(mi.name, pm.name), ', ')
  from relevant r
  join public.recipe_items i on i.recipe_version_id = r.id and i.material_id = p_material
  left join public.menu_items mi on mi.id = r.menu_item_id and mi.archived_at is null
  left join public.materials pm on pm.id = r.prep_material_id and pm.archived_at is null
  where mi.id is not null or pm.id is not null
$$;

create function public.archive_material(p_req uuid, p_id uuid, p_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.materials; users text;
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'archive_material') then return private.done(true); end if;
  m := private.lock_material(p_id, p_version);
  users := private.current_recipe_users(p_id);
  if users is not null then
    perform private.bad(m.name || ' is in the current recipe of: ' || users || '. Edit those recipes first (save a new version without it), then delete.');
  end if;
  update public.materials set archived_at = now(), archived_by = auth.uid(), version = version + 1,
         updated_at = now(), updated_by = auth.uid() where id = p_id;
  return private.done(false);
end $$;

-- ---------- menu & recipes ----------
create function public.add_menu(p_req uuid, p_name text, p_price numeric)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare nid uuid;
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'add_menu') then return private.done(true); end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or not (p_price > 0) then perform private.bad('Enter a name and selling price.'); end if;
  if exists (select 1 from public.menu_items where lower(btrim(name)) = lower(p_name) and archived_at is null) then
    perform private.bad('A menu item called "' || p_name || '" already exists.');
  end if;
  insert into public.menu_items(name, price) values (p_name, p_price) returning id into nid;
  return private.done(false, jsonb_build_object('id', nid));
end $$;

create function public.archive_menu(p_req uuid, p_id uuid, p_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare x public.menu_items;
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'archive_menu') then return private.done(true); end if;
  select * into x from public.menu_items where id = p_id for update;
  if not found then perform private.bad('That menu item no longer exists.'); end if;
  if x.archived_at is not null then perform private.bad(x.name || ' is already deleted.'); end if;
  if x.version <> p_version then perform private.conflict(x.name); end if;
  update public.menu_items set archived_at = now(), archived_by = auth.uid(), version = version + 1,
         updated_at = now(), updated_by = auth.uid() where id = p_id;
  return private.done(false);
end $$;

-- p_kind 'menu' | 'prep'; p_items = [{"rm": uuid, "q": number}, ...]
create function public.save_recipe(p_req uuid, p_kind text, p_owner uuid, p_version int, p_from date, p_yield numeric, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare vid bigint; it jsonb; n int := 0; mat public.materials; q numeric; owner_name text;
begin
  perform private.require_manager();
  if not private.begin_request(p_req, 'save_recipe') then return private.done(true); end if;
  if p_from is null then perform private.bad('Choose the date the recipe is effective from.'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    perform private.bad('Every ingredient needs a quantity above 0.');
  end if;
  if p_kind = 'menu' then
    select name into owner_name from public.menu_items where id = p_owner and archived_at is null for update;
    if owner_name is null then perform private.bad('That menu item no longer exists.'); end if;
    update public.menu_items set version = version + 1, updated_at = now(), updated_by = auth.uid()
     where id = p_owner and version = p_version;
    if not found then perform private.conflict(owner_name); end if;
  elsif p_kind = 'prep' then
    mat := private.lock_material(p_owner, p_version);
    if not mat.is_prep then perform private.bad(mat.name || ' is not a prep item.'); end if;
    if not (p_yield > 0) then perform private.bad('Enter how much this batch makes.'); end if;
    update public.materials set version = version + 1, updated_at = now(), updated_by = auth.uid() where id = p_owner;
  else
    perform private.bad('Unknown recipe type.');
  end if;

  update public.recipe_versions set voided_at = now(), voided_by = auth.uid(), void_reason = 'Replaced by a recipe saved for the same date'
   where voided_at is null and effective_from = p_from
     and ((p_kind = 'menu' and menu_item_id = p_owner) or (p_kind = 'prep' and prep_material_id = p_owner));
  insert into public.recipe_versions(menu_item_id, prep_material_id, effective_from, yield)
  values (case when p_kind = 'menu' then p_owner end, case when p_kind = 'prep' then p_owner end, p_from,
          case when p_kind = 'prep' then p_yield end)
  returning id into vid;

  for it in select * from jsonb_array_elements(p_items) loop
    n := n + 1;
    q := private.num(it, 'q');
    if not (q > 0) then perform private.bad('Every ingredient needs a quantity above 0.'); end if;
    select * into mat from public.materials where id = (it ->> 'rm')::uuid for share;
    if mat.id is null then perform private.bad('Ingredient ' || n || ' no longer exists.'); end if;
    if mat.archived_at is not null then perform private.bad(mat.name || ' has been deleted; choose another ingredient.'); end if;
    if p_kind = 'prep' and (mat.is_prep or mat.id = p_owner) then
      perform private.bad('A sauce/prep recipe can only use raw materials.');
    end if;
    insert into public.recipe_items(recipe_version_id, line_no, material_id, qty) values (vid, n, mat.id, q);
  end loop;
  return private.done(false);
end $$;

create function public.map_alias(p_req uuid, p_alias text, p_menu uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.require_staff();
  if not private.begin_request(p_req, 'map_alias') then return private.done(true); end if;
  p_alias := lower(btrim(coalesce(p_alias, '')));
  if p_alias = '' then perform private.bad('Empty POS item name.'); end if;
  if not exists (select 1 from public.menu_items where id = p_menu and archived_at is null) then
    perform private.bad('That menu item no longer exists.');
  end if;
  insert into public.pos_aliases(alias, menu_item_id) values (p_alias, p_menu)
  on conflict (alias) do update set menu_item_id = excluded.menu_item_id, updated_at = now(), updated_by = auth.uid();
  return private.done(false);
end $$;

-- ---------- sales ----------
-- p_rows = [{"d":"YYYY-MM-DD","mid":uuid,"qty":n,"amt":n}], one row per day+item (client aggregates).
-- Existing active rows for the same outlet/day/item are voided and replaced: no double counting.
create function public.import_sales(p_req uuid, p_outlet text, p_file text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare imp uuid; r jsonb; d date; mid uuid; q numeric; a numeric; n int := 0; replaced int := 0; k int;
begin
  perform private.require_outlet(p_outlet);
  if not private.begin_request(p_req, 'import_sales') then return private.done(true); end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then perform private.bad('Nothing to import.'); end if;
  if jsonb_array_length(p_rows) > 5000 then perform private.bad('Too many rows in one import (max 5000).'); end if;
  perform pg_advisory_xact_lock(hashtextextended('sales|' || p_outlet, 0));
  insert into public.sales_imports(outlet, file_name, row_count, total_qty, total_amount)
  values (p_outlet, left(coalesce(p_file, ''), 200), jsonb_array_length(p_rows),
          (select coalesce(sum((x ->> 'qty')::numeric), 0) from jsonb_array_elements(p_rows) x),
          (select coalesce(sum((x ->> 'amt')::numeric), 0) from jsonb_array_elements(p_rows) x))
  returning id into imp;
  for r in select * from jsonb_array_elements(p_rows) loop
    n := n + 1;
    begin
      d := (r ->> 'd')::date;
    exception when others then
      perform private.bad('Row ' || n || ': bad date');
    end;
    if d is null then perform private.bad('Row ' || n || ': bad date'); end if;
    mid := (r ->> 'mid')::uuid;
    q := private.num(r, 'qty'); a := private.num(r, 'amt');
    if not exists (select 1 from public.menu_items where id = mid) then perform private.bad('Row ' || n || ': unknown menu item'); end if;
    if not (q > 0 and q <= 1e6) then perform private.bad('Row ' || n || ': impossible quantity'); end if;
    if a is null or a < 0 then perform private.bad('Row ' || n || ': bad amount'); end if;
    update public.sales set voided_at = now(), voided_by = auth.uid(), void_reason = 'Replaced by import ' || imp
     where outlet = p_outlet and day = d and menu_item_id = mid and voided_at is null;
    get diagnostics k = row_count; replaced := replaced + k;
    begin
      insert into public.sales(outlet, day, menu_item_id, qty, amount, import_id) values (p_outlet, d, mid, q, a, imp);
    exception when unique_violation then
      perform private.bad('The file has the same item twice for ' || d || '. Combine those rows and try again.');
    end;
  end loop;
  return private.done(false, jsonb_build_object('rows', n, 'replaced', replaced));
end $$;

create function public.void_sale(p_req uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.sales;
begin
  perform private.require_staff();
  if not private.begin_request(p_req, 'void_sale') then return private.done(true); end if;
  select * into s from public.sales where id = p_id for update;
  if not found then perform private.bad('That sale no longer exists.'); end if;
  perform private.require_outlet(s.outlet);
  if s.voided_at is not null then return private.done(true); end if;
  update public.sales set voided_at = now(), voided_by = auth.uid(), void_reason = 'Deleted in Sales tab' where id = p_id;
  return private.done(false);
end $$;

create function public.void_sales_day(p_req uuid, p_day date, p_outlets text[])
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare o text; k int; total int := 0;
begin
  perform private.require_staff();
  if not private.begin_request(p_req, 'void_sales_day') then return private.done(true); end if;
  if p_day is null or coalesce(array_length(p_outlets, 1), 0) = 0 then perform private.bad('Choose a day and outlet.'); end if;
  foreach o in array p_outlets loop
    perform private.require_outlet(o);
    update public.sales set voided_at = now(), voided_by = auth.uid(), void_reason = 'Deleted all sales for the day'
     where outlet = o and day = p_day and voided_at is null;
    get diagnostics k = row_count; total := total + k;
  end loop;
  return private.done(false, jsonb_build_object('voided', total));
end $$;

-- ---------- stock ----------
create function private.lock_day(p_outlet text, p_day date) returns public.stock_days
language plpgsql set search_path = public, pg_temp as $$
declare sd public.stock_days;
begin
  if p_day is null then perform private.bad('Choose a date.'); end if;
  insert into public.stock_days(outlet, day) values (p_outlet, p_day) on conflict do nothing;
  select * into sd from public.stock_days where outlet = p_outlet and day = p_day for update;
  return sd;
end $$;

create function private.bump_day(p_outlet text, p_day date) returns void
language sql set search_path = public, pg_temp as $$
  update public.stock_days set version = version + 1, updated_at = now() where outlet = p_outlet and day = p_day
$$;

-- p_rows = [{"rm":uuid,"open":n,"pur":n,"inn":n,"out":n,"close":n|null,"pp":n|null}]
create function public.save_stock(p_req uuid, p_outlet text, p_day date, p_version int, p_close boolean, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sd public.stock_days; r jsonb; mat public.materials; o numeric; pu numeric; i numeric; t numeric; c numeric; pp numeric;
        cur numeric; missing text; n int := 0;
begin
  perform private.require_outlet(p_outlet);
  if not private.begin_request(p_req, 'save_stock') then return private.done(true); end if;
  sd := private.lock_day(p_outlet, p_day);
  if sd.version <> coalesce(p_version, 0) then perform private.conflict('Stock for ' || p_outlet || ' on ' || p_day); end if;
  if sd.closed then perform private.bad('This day is closed. Reopen it to change the numbers.'); end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then perform private.bad('Nothing entered.'); end if;

  update public.stock_entries set voided_at = now(), voided_by = auth.uid(), void_reason = 'Replaced by stock save'
   where outlet = p_outlet and day = p_day and voided_at is null;

  for r in select * from jsonb_array_elements(p_rows) loop
    n := n + 1;
    select * into mat from public.materials where id = (r ->> 'rm')::uuid;
    if mat.id is null then perform private.bad('Row ' || n || ': material no longer exists.'); end if;
    if mat.is_prep then perform private.bad(mat.name || ': sauces/prep items are not counted in stock.'); end if;
    o := coalesce(private.num(r, 'open'), 0); pu := coalesce(private.num(r, 'pur'), 0);
    i := coalesce(private.num(r, 'inn'), 0); t := coalesce(private.num(r, 'out'), 0);
    c := private.num(r, 'close'); pp := private.num(r, 'pp');
    if o < 0 or pu < 0 or i < 0 or t < 0 or c < 0 or pp < 0 then perform private.bad(mat.name || ': negative value'); end if;
    if c is null then perform private.bad(mat.name || ': closing stock missing'); end if;
    if o + pu + i - t - c < 0 then
      perform private.bad(mat.name || ': closing is higher than opening + bought. Recheck the count.');
    end if;
    begin
      insert into public.stock_entries(outlet, day, material_id, opening, purchased, stock_in, stock_out, closing)
      values (p_outlet, p_day, mat.id, o, pu, i, t, c);
    exception when unique_violation then
      perform private.bad(mat.name || ' appears twice.');
    end;
    if pp > 0 then
      select price into cur from public.material_prices
       where material_id = mat.id and voided_at is null and effective_date <= p_day order by effective_date desc limit 1;
      if cur is distinct from pp then
        perform private.require_price_rights(p_day);
        perform private.put_price(mat.id, p_day, pp, 'Purchase', 'Replaced by price paid in stock entry');
        update public.materials set version = version + 1, updated_at = now(), updated_by = auth.uid() where id = mat.id;
      end if;
    end if;
  end loop;

  if p_close then
    select string_agg(m.name, ', ' order by m.name) into missing
      from public.materials m
     where not m.is_prep and m.archived_at is null
       and not exists (select 1 from public.stock_entries e where e.outlet = p_outlet and e.day = p_day
                       and e.material_id = m.id and e.voided_at is null and e.closing is not null);
    if missing is not null then perform private.bad('Close day needs a closing count for every material. Missing: ' || missing); end if;
    update public.stock_days set closed = true, closed_at = now(), closed_by = auth.uid() where outlet = p_outlet and day = p_day;
  end if;
  perform private.bump_day(p_outlet, p_day);
  return private.done(false);
end $$;

create function public.clear_stock_day(p_req uuid, p_outlet text, p_day date, p_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sd public.stock_days;
begin
  perform private.require_outlet(p_outlet);
  if not private.begin_request(p_req, 'clear_stock_day') then return private.done(true); end if;
  sd := private.lock_day(p_outlet, p_day);
  if sd.version <> coalesce(p_version, 0) then perform private.conflict('Stock for ' || p_outlet || ' on ' || p_day); end if;
  if sd.closed then perform private.bad('This day is closed. Reopen it first.'); end if;
  update public.stock_entries set voided_at = now(), voided_by = auth.uid(), void_reason = 'Cleared day'
   where outlet = p_outlet and day = p_day and voided_at is null;
  perform private.bump_day(p_outlet, p_day);
  return private.done(false);
end $$;

create function public.reopen_day(p_req uuid, p_outlet text, p_day date, p_version int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sd public.stock_days;
begin
  perform private.require_outlet(p_outlet);
  perform private.require_manager();
  if not private.begin_request(p_req, 'reopen_day') then return private.done(true); end if;
  sd := private.lock_day(p_outlet, p_day);
  if sd.version <> coalesce(p_version, 0) then perform private.conflict('Stock for ' || p_outlet || ' on ' || p_day); end if;
  update public.stock_days set closed = false, closed_at = null, closed_by = null where outlet = p_outlet and day = p_day;
  perform private.bump_day(p_outlet, p_day);
  return private.done(false);
end $$;

-- ---------- wastage ----------
create function public.add_wastage(p_req uuid, p_outlet text, p_day date, p_rm uuid, p_qty numeric, p_why text, p_who text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare mat public.materials;
begin
  perform private.require_outlet(p_outlet);
  if not private.begin_request(p_req, 'add_wastage') then return private.done(true); end if;
  if p_day is null then perform private.bad('Choose a date.'); end if;
  if not (p_qty > 0) then perform private.bad('Enter a wastage quantity above 0.'); end if;
  select * into mat from public.materials where id = p_rm;
  if mat.id is null or mat.archived_at is not null then perform private.bad('Choose a material.'); end if;
  insert into public.wastage(outlet, day, material_id, qty, reason, responsible)
  values (p_outlet, p_day, p_rm, p_qty, left(coalesce(p_why, ''), 60), left(btrim(coalesce(p_who, '')), 80));
  return private.done(false);
end $$;

create function public.void_wastage(p_req uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.wastage;
begin
  perform private.require_staff();
  if not private.begin_request(p_req, 'void_wastage') then return private.done(true); end if;
  select * into w from public.wastage where id = p_id for update;
  if not found then perform private.bad('That wastage entry no longer exists.'); end if;
  perform private.require_outlet(w.outlet);
  if w.voided_at is not null then return private.done(true); end if;
  update public.wastage set voided_at = now(), voided_by = auth.uid(), void_reason = 'Deleted in Stock tab' where id = p_id;
  return private.done(false);
end $$;

-- ---------- purchases ----------
-- Adds p_qty to "purchased" on the outlet/day stock entry (void + re-insert; never edits in place).
create function private.add_purchased(p_outlet text, p_day date, p_material uuid, p_delta numeric, p_reason text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare e public.stock_entries; last_close numeric;
begin
  select * into e from public.stock_entries
   where outlet = p_outlet and day = p_day and material_id = p_material and voided_at is null for update;
  if e.id is not null then
    update public.stock_entries set voided_at = now(), voided_by = auth.uid(), void_reason = p_reason where id = e.id;
    insert into public.stock_entries(outlet, day, material_id, opening, purchased, stock_in, stock_out, closing)
    values (p_outlet, p_day, p_material, e.opening, greatest(0, e.purchased + p_delta), e.stock_in, e.stock_out, e.closing);
  elsif p_delta > 0 then
    select closing into last_close from public.stock_entries
     where outlet = p_outlet and material_id = p_material and day < p_day and voided_at is null and closing is not null
     order by day desc limit 1;
    insert into public.stock_entries(outlet, day, material_id, opening, purchased, closing)
    values (p_outlet, p_day, p_material, coalesce(last_close, 0), p_delta, null);
  end if;
end $$;

-- p_lines = [{"rm":uuid|null,"new_name":text,"new_unit":text,"qty":n,"rate":n,"amt":n,"bn":text}]
create function public.save_purchase(p_req uuid, p_outlet text, p_day date, p_supplier text, p_invoice text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sd public.stock_days; sup uuid; bill uuid; l jsonb; n int := 0; mid uuid; mat public.materials;
        q numeric; rt numeric; amt numeric; cur numeric;
begin
  perform private.require_outlet(p_outlet);
  if not private.begin_request(p_req, 'save_purchase') then return private.done(true); end if;
  sd := private.lock_day(p_outlet, p_day);
  if sd.closed then perform private.bad('That day is closed. Reopen it in Stock first.'); end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then perform private.bad('Nothing to save.'); end if;

  p_supplier := btrim(coalesce(p_supplier, '')); p_invoice := btrim(coalesce(p_invoice, ''));
  if p_supplier <> '' then
    select id into sup from public.suppliers where lower(btrim(name)) = lower(p_supplier);
    if sup is null then insert into public.suppliers(name) values (p_supplier) returning id into sup; end if;
  end if;
  begin
    insert into public.purchase_bills(outlet, day, supplier_id, invoice_no) values (p_outlet, p_day, sup, left(p_invoice, 60))
    returning id into bill;
  exception when unique_violation then
    perform private.bad('Invoice ' || p_invoice || coalesce(' from ' || nullif(p_supplier, ''), '') || ' is already saved for '
                        || p_outlet || '. It was not saved again.');
  end;

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    q := private.num(l, 'qty'); rt := private.num(l, 'rate'); amt := private.num(l, 'amt');
    if not (q > 0) then perform private.bad('Line ' || n || ': quantity must be above 0'); end if;
    if not (rt > 0) then perform private.bad('Line ' || n || ': price missing'); end if;
    if amt is null or amt <= 0 then amt := q * rt; end if;
    if coalesce(l ->> 'rm', '') = '' then
      mid := private.new_material(l ->> 'new_name', l ->> 'new_unit', 0, false);
      insert into public.material_prices(material_id, effective_date, price, note) values (mid, date '2000-01-01', round(rt, 2), 'Initial (bill)');
    else
      select * into mat from public.materials where id = (l ->> 'rm')::uuid;
      if mat.id is null or mat.archived_at is not null then perform private.bad('Line ' || n || ': material no longer exists.'); end if;
      if mat.is_prep then perform private.bad('Line ' || n || ': sauces/prep items cannot be bought.'); end if;
      mid := mat.id;
      select price into cur from public.material_prices
       where material_id = mid and voided_at is null and effective_date <= p_day order by effective_date desc limit 1;
      if cur is null or abs(rt - cur) > 0.005 then
        perform private.require_price_rights(p_day);
        perform private.put_price(mid, p_day, round(rt, 2), 'Bill' || coalesce(' ' || nullif(p_invoice, ''), ''),
                                  'Replaced by a later bill price for the same date');
        update public.materials set version = version + 1, updated_at = now(), updated_by = auth.uid() where id = mid;
      end if;
    end if;
    insert into public.purchase_lines(bill_id, outlet, day, material_id, qty, rate, amount, bill_name)
    values (bill, p_outlet, p_day, mid, q, rt, amt, left(coalesce(l ->> 'bn', ''), 200));
    perform private.add_purchased(p_outlet, p_day, mid, q, 'Purchase added');
  end loop;
  perform private.bump_day(p_outlet, p_day);
  return private.done(false, jsonb_build_object('lines', n, 'bill_id', bill));
end $$;

create function public.void_purchase_line(p_req uuid, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare pl public.purchase_lines; sd public.stock_days;
begin
  perform private.require_staff();
  if not private.begin_request(p_req, 'void_purchase_line') then return private.done(true); end if;
  select * into pl from public.purchase_lines where id = p_id;
  if not found then perform private.bad('That purchase no longer exists.'); end if;
  perform private.require_outlet(pl.outlet);
  sd := private.lock_day(pl.outlet, pl.day);
  select * into pl from public.purchase_lines where id = p_id for update;
  if pl.voided_at is not null then return private.done(true); end if;
  if sd.closed then perform private.bad('That day is closed. Reopen it in Stock first.'); end if;
  update public.purchase_lines set voided_at = now(), voided_by = auth.uid(), void_reason = 'Deleted in Buy tab' where id = p_id;
  perform private.add_purchased(pl.outlet, pl.day, pl.material_id, -pl.qty, 'Purchase deleted');
  update public.purchase_bills set voided_at = now(), voided_by = auth.uid(), void_reason = 'All lines deleted'
   where id = pl.bill_id and voided_at is null
     and not exists (select 1 from public.purchase_lines where bill_id = pl.bill_id and voided_at is null);
  perform private.bump_day(pl.outlet, pl.day);
  return private.done(false);
end $$;

-- After a save got no reply, the app asks which of its outstanding request ids the database applied
-- (only the caller's own), so it never re-enters something that was saved after all.
create function public.applied_requests(p_ids uuid[]) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(id), '{}'::uuid[]) from public.client_requests
   where id = any(p_ids[1:200]) and user_id = auth.uid() and private.is_staff()
$$;

-- ---------------------------------------------------------------------
-- Integrity report (used by the backup verification job). Every row
-- should report 0 problems.
-- ---------------------------------------------------------------------
create function private.integrity_report() returns table(check_name text, problems bigint)
language sql stable set search_path = public, pg_temp as $$
  select 'purchase line outlet/day differs from its bill', count(*) from public.purchase_lines l
    join public.purchase_bills b on b.id = l.bill_id where l.outlet <> b.outlet or l.day <> b.day
  union all
  select 'recipe version with no ingredients', count(*) from public.recipe_versions v
    where v.voided_at is null and not exists (select 1 from public.recipe_items i where i.recipe_version_id = v.id)
  union all
  select 'prep recipe using a prep item', count(*) from public.recipe_versions v
    join public.recipe_items i on i.recipe_version_id = v.id join public.materials m on m.id = i.material_id
    where v.prep_material_id is not null and m.is_prep
  union all
  select 'voided_by set without voided_at', (select count(*) from public.sales where voided_at is null and voided_by is not null)
       + (select count(*) from public.stock_entries where voided_at is null and voided_by is not null)
  union all
  select 'active staff without outlet (non-owner)', count(*) from public.staff s
    where s.active and s.role <> 'owner' and not exists (select 1 from public.staff_outlets so where so.user_id = s.user_id)
$$;

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
