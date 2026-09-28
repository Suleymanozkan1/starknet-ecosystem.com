#!/bin/sh
# Restore drill: restores the newest backup into a scratch database and compares key row counts
# with the source. Usage: DATABASE_URL=... BACKUP_DIR=./backups scripts/backup/pg-restore-drill.sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
latest=$(ls -1t "$BACKUP_DIR"/nebula-*.dump 2>/dev/null | head -n1)
[ -n "$latest" ] || { echo "no backup found in $BACKUP_DIR" >&2; exit 1; }
sha256sum -c "$latest.sha256" >/dev/null
url=$(printf '%s' "$DATABASE_URL" | sed 's/[?&]schema=[^&]*//')
base=${url%/*}
drill_db="nebula_restore_drill_$$"
psql "$url" -qAtc "CREATE DATABASE $drill_db" >/dev/null
trap 'psql "$url" -qAtc "DROP DATABASE IF EXISTS $drill_db" >/dev/null' EXIT
pg_restore --no-owner --dbname="$base/$drill_db" "$latest"
fail=0
for t in '"User"' '"BalanceLedger"' '"BalanceAccount"' '"Withdrawal"' '"Reward"' '"AuditLog"'; do
  a=$(psql "$url" -qAtc "SELECT count(*) FROM $t")
  b=$(psql "$base/$drill_db" -qAtc "SELECT count(*) FROM $t")
  echo "$t source=$a restored=$b"
  [ "$a" = "$b" ] || fail=1
done
[ "$fail" = 0 ] && echo "restore drill ok: $latest" || { echo "restore drill FAILED" >&2; exit 1; }
