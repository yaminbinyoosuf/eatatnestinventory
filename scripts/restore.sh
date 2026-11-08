#!/usr/bin/env bash
# THE restore procedure (used by disaster recovery AND by the nightly restore test).
#   scripts/restore.sh <path/to/db.dump> <target-database-url>
# Target must be a database WITHOUT the eat@nest tables (a new Supabase project,
# or a scratch database). It refuses to touch a database that already has them,
# so it can never overwrite live data.
set -euo pipefail
DUMP=${1:?usage: restore.sh <db.dump> <target-url>}; TARGET=${2:?usage: restore.sh <db.dump> <target-url>}
if [ "$(psql "$TARGET" -XAtqc "select to_regclass('public.materials') is not null")" = "t" ]; then
  echo "Refusing: the target already contains eat@nest tables. Restore into a NEW project/database." >&2; exit 2
fi
# Integrity of the file itself: compare with the checksum recorded when the backup was made.
MANIFEST="$(dirname "$DUMP")/manifest.txt"
if [ -f "$MANIFEST" ]; then
  want=$(sed -n 's/^dump_sha256: //p' "$MANIFEST")
  have=$( (sha256sum "$DUMP" 2>/dev/null || shasum -a 256 "$DUMP") | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$have" ] || { echo "Refusing: $DUMP does not match the checksum in manifest.txt (corrupted or wrong file)." >&2; exit 3; }
  echo "checksum OK"
elif [ "${ALLOW_NO_MANIFEST:-}" = "1" ]; then
  echo "WARNING: no manifest.txt next to the dump; checksum NOT verified (ALLOW_NO_MANIFEST=1)." >&2
else
  echo "Refusing: no manifest.txt next to the dump, so it cannot be checked. The archive may be incomplete." >&2
  echo "Only if you are sure the file is complete: ALLOW_NO_MANIFEST=1 scripts/restore.sh ..." >&2; exit 3
fi
LIST=$(mktemp); trap 'rm -f "$LIST"' EXIT
# Skip: the "public" schema's CREATE/COMMENT (it always exists already), and DEFAULT ACL entries
# (Supabase's default-privilege rules for roles such as supabase_admin: a non-superuser cannot
# recreate them, the new project has its own, and harden-privileges.sql sets the real table rights).
pg_restore --list "$DUMP" | grep -vE ' SCHEMA - public | COMMENT - SCHEMA public | DEFAULT ACL ' > "$LIST"
pg_restore --no-owner --exit-on-error --use-list="$LIST" --dbname="$TARGET" "$DUMP"
psql "$TARGET" -Xq -c "grant usage on schema public to anon, authenticated, service_role" 2>/dev/null || true
# A new Supabase project re-grants broad default privileges on restored tables: take them back.
psql "$TARGET" -Xq -v ON_ERROR_STOP=1 -f "$(cd "$(dirname "$0")" && pwd)/harden-privileges.sql" >/dev/null
echo "privileges re-applied (scripts/harden-privileges.sql)"
echo "restore complete: $(psql "$TARGET" -XAtqc "select count(*) from pg_tables where schemaname='public'") tables"
