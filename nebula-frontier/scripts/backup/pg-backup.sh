#!/bin/sh
# Daily logical backup of the NEBULA FRONTIER database (custom format, compressed) with retention.
# Usage: DATABASE_URL=postgresql://... BACKUP_DIR=/backups RETENTION_DAYS=30 scripts/backup/pg-backup.sh
# Point-in-time recovery additionally needs WAL archiving on the server (see docs/DEPLOYMENT.md).
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/nebula-$stamp.dump"
# Prisma-style ?schema= query params are not understood by libpq; strip them.
url=$(printf '%s' "$DATABASE_URL" | sed 's/[?&]schema=[^&]*//')
pg_dump --format=custom --compress=6 --no-owner --file="$out.partial" "$url"
# Verify the archive is readable before publishing it.
pg_restore --list "$out.partial" >/dev/null
mv "$out.partial" "$out"
sha256sum "$out" > "$out.sha256"
find "$BACKUP_DIR" -name 'nebula-*.dump*' -type f -mtime +"$RETENTION_DAYS" -delete
echo "backup ok: $out ($(wc -c < "$out") bytes)"
