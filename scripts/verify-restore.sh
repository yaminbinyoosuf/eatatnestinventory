#!/usr/bin/env bash
# Restores a backup made by backup.sh into a NEW, EMPTY database on a separate
# server and proves it is complete and usable. Exits non-zero on any problem.
#   RESTORE_ADMIN_URL=postgresql://postgres:pw@host:5432/postgres  scripts/verify-restore.sh <backup-dir>
# RESTORE_ADMIN_URL must be a scratch server: a database "restore_check" is
# dropped and re-created on it. Never point this at production.
set -euo pipefail
: "${RESTORE_ADMIN_URL:?set RESTORE_ADMIN_URL}"
DIR=${1:?usage: verify-restore.sh <backup-dir>}
HERE=$(cd "$(dirname "$0")/.." && pwd)
case "$RESTORE_ADMIN_URL" in *supabase.co*|*supabase.com*) echo "Refusing: RESTORE_ADMIN_URL points at Supabase. Use a scratch server." >&2; exit 2;; esac
TARGET="${RESTORE_ADMIN_URL%/*}/restore_check"
fail() { echo "RESTORE VERIFICATION FAILED: $*" >&2; exit 1; }

for f in manifest.txt counts_before.tsv counts_after.tsv schema.tsv db.dump; do [ -s "$DIR/$f" ] || fail "$f missing or empty"; done
# The restore runs as an ordinary (non-superuser) database owner, exactly like `postgres` on a
# new Supabase project, so anything only a superuser could restore fails here every night.
psql "$RESTORE_ADMIN_URL" -XqAt -v ON_ERROR_STOP=1 -c "drop database if exists restore_check with (force)" \
  -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'restore_owner') then create role restore_owner login nosuperuser password 'restore_check_pw'; end if; end \$\$" \
  -c "create database restore_check owner restore_owner"
# Supabase-provided pieces the schema references (roles, auth.uid) — same as a Supabase project has.
psql "$TARGET" -Xq -v ON_ERROR_STOP=1 -f "$HERE/tests/local/bootstrap.sql" >/dev/null 2>"$DIR/bootstrap.err" \
  || { cat "$DIR/bootstrap.err" >&2; fail "could not prepare the scratch database (tests/local/bootstrap.sql)"; }
psql "$TARGET" -Xq -v ON_ERROR_STOP=1 -c "alter schema public owner to restore_owner" \
  -c "grant usage on schema auth to restore_owner" -c "grant execute on function auth.uid() to restore_owner" \
  || fail "could not prepare the scratch database (ownership/grants)"
HOSTPART=${RESTORE_ADMIN_URL#*://}; HOSTPART=${HOSTPART#*@}; HOSTPART=${HOSTPART%%/*}
"$HERE/scripts/restore.sh" "$DIR/db.dump" "postgresql://restore_owner:restore_check_pw@$HOSTPART/restore_check" || fail "restore reported errors"

# 1. every table restored with a plausible row count
sql=$(psql "$TARGET" -XAtq -c "select string_agg(format('select %L, count(*) from public.%I', tablename, tablename), ' union all ' order by tablename) from pg_tables where schemaname='public'")
psql "$TARGET" -XAtq -F $'\t' -c "$sql" | sort > "$DIR/counts_restored.tsv"
join -t $'\t' "$DIR/counts_before.tsv" "$DIR/counts_after.tsv" | join -t $'\t' - "$DIR/counts_restored.tsv" > "$DIR/counts_joined.tsv"
[ "$(wc -l < "$DIR/counts_joined.tsv")" -eq "$(wc -l < "$DIR/counts_before.tsv")" ] || fail "table list differs between source and restore"
awk -F'\t' '{ if ($4 < $2 || $4 > $3) { print "  " $1 ": restored " $4 ", expected between " $2 " and " $3; bad=1 } } END { exit bad }' "$DIR/counts_joined.tsv" || fail "row counts do not match"

# 2. same structure (tables, constraints incl. foreign keys, triggers, RLS policies, functions, indexes)
psql "$TARGET" -XAtq -F $'\t' -f "$HERE/scripts/fingerprint.sql" | sort > "$DIR/schema_restored.tsv"
diff "$DIR/schema.tsv" "$DIR/schema_restored.tsv" || fail "schema objects differ"

# 3. relationships intact: every foreign key is present and validated
psql "$TARGET" -XAtq -c "select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.contype='f' and not c.convalidated" | grep -qx 0 || fail "unvalidated foreign keys"
# 4. business invariants
bad=$(psql "$TARGET" -XAtq -c "select coalesce(string_agg(check_name || '=' || problems, ', '), '') from private.integrity_report() where problems > 0")
[ -z "$bad" ] || fail "integrity report: $bad"
# 5. the app can actually read it: app_state() as the first active owner, exactly as the browser calls it
owner=$(psql "$TARGET" -XAtq -c "select user_id from public.staff where role='owner' and active limit 1")
if [ -n "$owner" ]; then
  psql "$TARGET" -XAtq -v ON_ERROR_STOP=1 -c "begin; set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"$owner\",\"role\":\"authenticated\"}', true);
     select format('app_state ok: %s materials, %s menu items, %s sales, %s purchases, %s stock rows',
       jsonb_array_length(s->'rm'), jsonb_array_length(s->'menu'), jsonb_array_length(s->'sales'), jsonb_array_length(s->'buy'), jsonb_array_length(s->'inv'))
     from (select public.app_state() s) x; commit;" | grep 'app_state ok' || fail "app_state() failed on the restored database"
else
  fail "no active owner in the restored database: nobody could administer it after a recovery"
fi
# 6. deletes are still blocked in the restored copy
# 6a. every protected table (the migration's list, as in verify-production.sql) has both guards, enabled:
#     no_delete = BEFORE DELETE FOR EACH ROW, no_truncate = BEFORE TRUNCATE, both calling private.forbid_delete()
missing=$(psql "$TARGET" -XAtq -c "
  select coalesce(string_agg(g || ' on ' || t, ', ' order by t, g), '')
  from unnest(array['outlets','staff','settings','materials','material_prices','menu_items','recipe_versions',
                    'recipe_items','pos_aliases','suppliers','stock_days','stock_entries','wastage','sales_imports',
                    'sales','purchase_bills','purchase_lines','client_requests','audit_log']) t
  cross join unnest(array['no_delete','no_truncate']) g
  where not exists (
    select 1 from pg_trigger tr join pg_class c on c.oid = tr.tgrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = tr.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
     where n.nspname = 'public' and c.relname = t and tr.tgname = g and tr.tgenabled <> 'D'
       and pn.nspname = 'private' and p.proname = 'forbid_delete'
       and ((g = 'no_delete' and tr.tgtype & 11 = 11) or (g = 'no_truncate' and tr.tgtype & 34 = 34)))")
[ -z "$missing" ] || fail "delete/truncate protection missing after restore: $missing"
# 6b. and they really fire, with the guard's own error (not some other error).
# truncate fires the statement-level no_truncate trigger even when the table is empty;
# staff always has the owner row (step 5), so the row-level no_delete trigger really fires.
out=$(psql "$TARGET" -XAtq -c "truncate public.sales" 2>&1) && fail "truncate protection missing after restore"
grep -q 'is not allowed' <<<"$out" || fail "truncate failed for an unexpected reason: $out"
out=$(psql "$TARGET" -XAtq -c "delete from public.staff" 2>&1) && fail "delete protection missing after restore"
grep -q 'is not allowed' <<<"$out" || fail "delete failed for an unexpected reason: $out"
echo "RESTORE VERIFIED: $(awk -F'\t' '{s+=$4} END {print s}' "$DIR/counts_joined.tsv") rows across $(wc -l < "$DIR/counts_joined.tsv" | tr -d ' ') tables; structure, foreign keys, integrity and app read all OK."
