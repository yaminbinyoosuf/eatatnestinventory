#!/usr/bin/env bash
# Local stack for tests: PostgreSQL 17 (port 54329) + PostgREST (54330).
# Usage: tests/local/env.sh up|down|reset|psql [db]
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH
DATA=.localdb/data; PORT=54329; DB=${2:-eatatnest}
export JWT_SECRET=local-test-jwt-secret-at-least-32-chars-long
up_pg() {
  [ -d $DATA ] || { initdb -D $DATA -U postgres --auth=trust -E UTF8 --locale=C >/dev/null; }
  pg_ctl -D $DATA -o "-p $PORT -k /tmp" -l .localdb/pg.log status >/dev/null 2>&1 || pg_ctl -D $DATA -o "-p $PORT -k /tmp" -l .localdb/pg.log -w start >/dev/null
}
mkdb() {
  psql -h localhost -p $PORT -U postgres -qc "drop database if exists $DB with (force)" -c "create database $DB" >/dev/null
  psql -h localhost -p $PORT -U postgres -d $DB -q -v ON_ERROR_STOP=1 -f tests/local/bootstrap.sql -f supabase/migrations/20261108000000_init.sql >/dev/null
}
up_rest() {
  pkill -f "postgrest .localdb/postgrest.conf" 2>/dev/null || true
  cat > .localdb/postgrest.conf <<C
db-uri = "postgres://authenticator:authenticator_local_pw@localhost:$PORT/eatatnest"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-port = 54330
C
  nohup postgrest .localdb/postgrest.conf > .localdb/postgrest.log 2>&1 &
  for i in $(seq 1 50); do curl -s localhost:54330 >/dev/null && return; sleep 0.2; done; echo "postgrest failed"; cat .localdb/postgrest.log; exit 1
}
case "${1:-up}" in
  up) mkdir -p .localdb; up_pg; mkdb; up_rest; echo "stack up: pg :$PORT  rest :54330";;
  reset) mkdir -p .localdb; up_pg; mkdb; pkill -USR1 -f "postgrest .localdb/postgrest.conf" || true; sleep 0.5;;
  down) pkill -f "postgrest .localdb/postgrest.conf" || true; pg_ctl -D $DATA stop -m fast >/dev/null 2>&1 || true;;
  psql) exec psql -h localhost -p $PORT -U postgres -d $DB;;
esac
