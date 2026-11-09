#!/usr/bin/env bash
# LOCAL backup + disaster-recovery rehearsal. Never touches Supabase.
#   tests/local/env.sh up && tests/backup-rehearsal.sh
# Runs the nightly pipeline exactly like .github/workflows/backup.yml (same postgres:17 image, a
# separate empty scratch PostgreSQL, the same encrypt/decrypt commands), then follows
# docs/RECOVERY.md: decrypt the artifact and restore it with scripts/restore.sh into a NEW database
# as a non-superuser, and checks it. Source database = the local test stack (port 54329).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
NET=ean-rehearsal; RUNNER=ean-rehearsal-runner; SCRATCH=ean-rehearsal-scratch
SRC=postgresql://postgres@localhost:54329/eatatnest
SRC_FROM_DOCKER=postgresql://postgres@host.docker.internal:54329/eatatnest
PASSPHRASE=local-rehearsal-passphrase-not-a-secret
pass=0; failn=0
ok() { if [ "$2" = 1 ]; then pass=$((pass+1)); echo "PASS  $1"; else failn=$((failn+1)); echo "FAIL  $1${3:+  — $3}"; fi; }
P() { psql "$SRC" -XqAt -v ON_ERROR_STOP=1 "$@"; }
R() { docker exec -e DATABASE_URL="$SRC_FROM_DOCKER" -e RESTORE_ADMIN_URL=postgresql://postgres:scratch@$SCRATCH:5432/postgres \
        -e BACKUP_PASSPHRASE="$PASSPHRASE" -w /work "$RUNNER" bash -c "$1"; }

cleanup() { docker rm -f "$RUNNER" "$SCRATCH" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT; cleanup
docker network create "$NET" >/dev/null
docker run -d --name "$SCRATCH" --network "$NET" -e POSTGRES_PASSWORD=scratch postgres:17 >/dev/null
docker run -d --name "$RUNNER" --network "$NET" --add-host host.docker.internal:host-gateway \
  -v "$ROOT:/repo:ro" postgres:17 sleep infinity >/dev/null
docker exec "$RUNNER" bash -c 'mkdir -p /work && apt-get update -qq && apt-get install -y -qq --no-install-recommends gnupg ca-certificates >/dev/null' \
  || { echo "could not prepare the runner container"; exit 1; }
for i in $(seq 1 30); do docker exec "$SCRATCH" pg_isready -q && break; sleep 1; done
R 'pg_dump --version; psql "$DATABASE_URL" -XAtqc "select 1" >/dev/null && echo "runner reaches the local source database"' || { echo "runner cannot reach localhost:54329"; exit 1; }

reset_src() { tests/local/env.sh reset >/dev/null 2>&1; }
seed_owner() { P -c "insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000a1','owner@example.test')" \
                 -c "insert into public.staff(user_id,email,name,role) values ('00000000-0000-0000-0000-0000000000a1','owner@example.test','Owner','owner')"; }

# The workflow's three steps, verbatim apart from paths: dump, restore+verify, encrypt+prove-decrypt.
pipeline() {
  R 'rm -rf out rec *.tar *.gpg
     bash /repo/scripts/backup.sh out >backup.log 2>&1 || { cat backup.log; echo "STEP dump FAILED"; exit 11; }
     bash /repo/scripts/verify-restore.sh out >verify.log 2>&1 || { cat verify.log; echo "STEP verify FAILED"; exit 12; }
     cat verify.log
     set -euo pipefail
     STAMP=$(date -u +%Y-%m-%d_%H%M)
     tar -C out -cf backup.tar db.dump manifest.txt counts_before.tsv counts_after.tsv counts_restored.tsv schema.tsv
     printf %s "$BACKUP_PASSPHRASE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
       --symmetric --cipher-algo AES256 -o "eatatnest-db-$STAMP.tar.gpg" backup.tar
     printf %s "$BACKUP_PASSPHRASE" | gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 \
       -d "eatatnest-db-$STAMP.tar.gpg" | cmp - backup.tar
     rm -rf out backup.tar
     echo "ENCRYPTED+DECRYPT-VERIFIED $(ls eatatnest-db-*.tar.gpg) $(gpg --list-packets --batch --passphrase "$BACKUP_PASSPHRASE" --pinentry-mode loopback eatatnest-db-*.tar.gpg 2>/dev/null | grep -o "cipher 9" | head -1)"' 2>&1
}

expect_fail() { # name, expected message, setup...
  local name=$1 want=$2; shift 2
  reset_src; for s in "$@"; do eval "$s" >/dev/null || { ok "$name (setup)" 0; return; }; done
  local out; out=$(pipeline); local code=$?
  [ $code -eq 12 ] && grep -q "$want" <<<"$out" && ! grep -q 'RESTORE VERIFIED' <<<"$out" && ! grep -q ENCRYPTED <<<"$out"
  ok "$name → restore test fails: \"$want\", nothing encrypted/kept" $(( $? == 0 )) "$(grep -E 'FAILED|STEP' <<<"$out" | head -2 | tr '\n' ' ')"
}

echo; echo "== 1. Empty tables (like production today): owner only, 0 sales"
reset_src; seed_owner
out=$(pipeline); code=$?
echo "$out" | grep -E 'RESTORE|app_state ok|ENCRYPTED' | sed 's/^/      /'
ok "empty tables: dump + RESTORE VERIFIED + encrypted (AES-256) + decrypt verified" $(( code == 0 && $(grep -c 'RESTORE VERIFIED' <<<"$out") == 1 && $(grep -c 'ENCRYPTED+DECRYPT-VERIFIED.*cipher 9' <<<"$out") == 1 ))

echo; echo "== 2. Existing records (database left by the full db.test.mjs run: sales, voids, purchases, stock, audit log)"
(cd tests && node db.test.mjs > /tmp/ean-dbtest.log 2>&1); dbt=$?
ok "db.test.mjs populated the source ($(tail -1 /tmp/ean-dbtest.log))" $(( dbt == 0 ))
echo "      source rows: $(P -c "select string_agg(t||'='||n, ' ') from (select 'sales' t, count(*) n from sales union all select 'voided_sales', count(*) from sales where voided_at is not null union all select 'purchase_lines', count(*) from purchase_lines union all select 'stock_entries', count(*) from stock_entries union all select 'audit_log', count(*) from audit_log union all select 'staff', count(*) from staff) x")"
out=$(pipeline); code=$?
echo "$out" | grep -E 'RESTORE|app_state ok|ENCRYPTED' | sed 's/^/      /'
ok "existing records: dump + RESTORE VERIFIED + encrypted + decrypt verified" $(( code == 0 && $(grep -c 'RESTORE VERIFIED' <<<"$out") == 1 && $(grep -c 'ENCRYPTED+DECRYPT-VERIFIED' <<<"$out") == 1 ))

echo; echo "== 3. Disaster recovery from that encrypted artifact, following docs/RECOVERY.md §2-3"
R 'set -e; mkdir -p rec && cd rec
   printf %s "$BACKUP_PASSPHRASE" | gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 -d ../eatatnest-db-*.tar.gpg > backup.tar
   mkdir backup && tar -C backup -xf backup.tar && cat backup/manifest.txt | sed -n "1,3p;7p"' 2>&1 | sed 's/^/      /'
ok "artifact decrypts and extracts (§2)" $(( ${PIPESTATUS[0]} == 0 ))
R 'printf wrong-passphrase | gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 -d eatatnest-db-*.tar.gpg >/dev/null 2>&1'
ok "wrong passphrase cannot open the artifact" $(( $? != 0 ))
# "new Supabase project": an empty database whose owner is NOT a superuser, with Supabase's roles + auth schema
R 'set -e; A="$RESTORE_ADMIN_URL"
   psql "$A" -Xq -v ON_ERROR_STOP=1 -c "drop database if exists newproj with (force)" \
     -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '"'"'newproj_owner'"'"') then create role newproj_owner login nosuperuser password '"'"'np'"'"'; end if; end \$\$" \
     -c "create database newproj owner newproj_owner" >/dev/null
   psql "${A%/*}/newproj" -Xq -v ON_ERROR_STOP=1 -f /repo/tests/local/bootstrap.sql >/dev/null 2>&1
   psql "${A%/*}/newproj" -Xq -v ON_ERROR_STOP=1 -c "alter schema public owner to newproj_owner" -c "grant usage on schema auth to newproj_owner" \
     -c "grant execute on function auth.uid() to newproj_owner" -c "grant select on auth.users to newproj_owner"' >/dev/null 2>&1
NEWPROJ=postgresql://newproj_owner:np@$SCRATCH:5432/newproj
R "cd rec && bash /repo/scripts/restore.sh backup/db.dump $NEWPROJ" 2>&1 | sed 's/^/      /'
ok "restore.sh into a NEW empty database as a non-superuser (§3 step 3)" $(( ${PIPESTATUS[0]} == 0 ))
src=$(P -c "select (select count(*) from sales)||'/'||(select count(*) from audit_log)||'/'||(select count(*) from purchase_lines)||'/'||(select count(*) from staff)")
dst=$(R "psql $NEWPROJ -XAtqc \"select (select count(*) from sales)||'/'||(select count(*) from audit_log)||'/'||(select count(*) from purchase_lines)||'/'||(select count(*) from staff)\"")
ok "restored data matches the source (sales/audit_log/purchase_lines/staff = $dst)" $([ "$src" = "$dst" ] && echo 1 || echo 0) "source $src"
R "cd rec && bash /repo/scripts/restore.sh backup/db.dump $NEWPROJ" >/tmp/ean-r2 2>&1
ok "restore.sh refuses a database that already has the tables (cannot overwrite live data)" $(( $? == 2 )) "$(cat /tmp/ean-r2)"
R "cd rec && cp backup/db.dump bad.dump && printf x >> bad.dump && mkdir -p badset && mv bad.dump badset/db.dump && cp backup/manifest.txt badset/ && bash /repo/scripts/restore.sh badset/db.dump postgresql://postgres:scratch@$SCRATCH:5432/postgres" >/tmp/ean-r3 2>&1
ok "restore.sh refuses a corrupted dump (checksum)" $(( $? == 3 )) "$(cat /tmp/ean-r3)"
R "cd rec && mkdir -p nomani && cp backup/db.dump nomani/ && bash /repo/scripts/restore.sh nomani/db.dump postgresql://postgres:scratch@$SCRATCH:5432/postgres" >/tmp/ean-r4 2>&1
ok "restore.sh refuses a dump without its manifest" $(( $? == 3 )) "$(cat /tmp/ean-r4 | head -1)"
# privileges/structure on the recovered database: scripts/verify-production.sql (run as superuser, like the SQL Editor)
vp=$(R "psql \"\${RESTORE_ADMIN_URL%/*}/newproj\" -XAt -F '|' -f /repo/scripts/verify-production.sql" 2>&1)
echo "$vp" | sed 's/^/      /'
# expected here: no logins yet; owner role is "newproj_owner" (on Supabase it is postgres); API schema list not readable from SQL
notpass=$(grep -vE '^PASS\|' <<<"$vp" | grep -vE "^CHECK\|private schema not exposed|^FAIL\|every ACTIVE staff member has a matching login|^FAIL\|tables owned by postgres \(backups read past RLS\)\|newproj_owner$")
ok "verify-production.sql on the recovered database: all PASS except the 3 rows expected in this stand-in" $([ -z "$notpass" ] && echo 1 || echo 0) "$notpass"
ok "…'every ACTIVE staff member has a matching login' is FAIL before logins are recreated (as the runbook says)" $(grep -qE '^FAIL\|every ACTIVE staff member has a matching login' <<<"$vp" && echo 1 || echo 0)

echo; echo "== 4. The restore test must refuse broken backups"
expect_fail "missing owner (no staff at all)"         "no active owner"
expect_fail "inactive owner"                           "no active owner" seed_owner \
  "P -c 'alter table public.staff disable trigger user' -c 'update public.staff set active=false' -c 'alter table public.staff enable trigger user'"
expect_fail "delete protection removed from staff"     "delete/truncate protection missing after restore: no_delete on staff" seed_owner "P -c 'drop trigger no_delete on public.staff'"
expect_fail "truncate protection removed from sales"   "delete/truncate protection missing after restore: no_truncate on sales" seed_owner "P -c 'drop trigger no_truncate on public.sales'"
expect_fail "delete protection removed from purchase_lines (a table not exercised directly)" "no_delete on purchase_lines" seed_owner "P -c 'drop trigger no_delete on public.purchase_lines'"
expect_fail "delete protection DISABLED (not dropped) on audit_log" "no_delete on audit_log" seed_owner "P -c 'alter table public.audit_log disable trigger no_delete'"
expect_fail "guard function replaced by one that allows deletes" "protection missing after restore" seed_owner \
  "P -c 'create or replace function private.forbid_delete() returns trigger language plpgsql as \$\$ begin return old; end \$\$'"

echo; echo "$pass passed, $failn failed"
reset_src
exit $(( failn > 0 ))
