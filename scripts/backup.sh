#!/usr/bin/env bash
# Full logical backup of the eat@nest business data (schemas public + private).
#   DATABASE_URL=postgresql://...  scripts/backup.sh <out-dir>
# Writes: <out-dir>/db.dump (pg_dump custom format), counts_before.tsv,
#         counts_after.tsv, schema.tsv, manifest.txt
# Because business rows can never be deleted, row counts only grow: a correct
# dump has, for every table, counts_before <= rows in dump <= counts_after.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
OUT=${1:?usage: backup.sh <out-dir>}; mkdir -p "$OUT"
counts() {
  local sql
  sql=$(psql "$DATABASE_URL" -XAtq -c "select string_agg(format('select %L, count(*) from public.%I', tablename, tablename), ' union all ' order by tablename) from pg_tables where schemaname='public'")
  psql "$DATABASE_URL" -XAtq -F $'\t' -c "$sql" | sort
}
schema() { psql "$DATABASE_URL" -XAtq -F $'\t' -f "$(dirname "$0")/fingerprint.sql" | sort; }
counts > "$OUT/counts_before.tsv"
schema > "$OUT/schema.tsv"
pg_dump "$DATABASE_URL" --format=custom --no-owner --schema=public --schema=private --file="$OUT/db.dump"
counts > "$OUT/counts_after.tsv"
{
  echo "eat@nest database backup"
  echo "created_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "pg_dump: $(pg_dump --version)"
  echo "server: $(psql "$DATABASE_URL" -XAtqc 'show server_version')"
  echo "dump_sha256: $(sha256sum "$OUT/db.dump" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$OUT/db.dump" | cut -d' ' -f1)"
  echo "dump_bytes: $(wc -c < "$OUT/db.dump" | tr -d ' ')"
  echo "business_rows: $(awk '{s+=$2} END {print s}' "$OUT/counts_after.tsv")"
} > "$OUT/manifest.txt"
cat "$OUT/manifest.txt"
