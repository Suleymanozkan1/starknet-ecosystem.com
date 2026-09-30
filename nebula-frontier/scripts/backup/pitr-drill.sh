#!/usr/bin/env bash
# Point-in-time recovery (PITR) drill for NEBULA FRONTIER (requirement INF-07).
#
# Runs entirely on a throwaway PostgreSQL cluster (never touches an existing cluster):
#   1. initdb a scratch cluster with WAL archiving (wal_level=replica, archive_mode=on,
#      archive_command copying segments into a local archive directory);
#   2. apply the Prisma migrations (prisma migrate deploy) and optionally seed (tsx prisma/seed.ts);
#   3. take a pg_basebackup;
#   4. write drill data (marker rows + a drill user/account/ledger posting), snapshot key row counts,
#      record the recovery target time T;
#   5. after T: delete the markers, insert a "post-T" marker and TRUNCATE ... CASCADE the key tables;
#   6. force a WAL switch and wait until the segment is archived;
#   7. restore the base backup into a new data dir with restore_command + recovery_target_time=T +
#      recovery.signal, start it and verify: markers present, post-T change absent, key row counts
#      equal to the pre-T snapshot.
# Prints a PASS/FAIL summary with timings; exits non-zero on failure. Cleanup is idempotent (trap).
#
# Usage (from the repo root; as root the cluster runs as the `postgres` OS user):
#   scripts/backup/pitr-drill.sh
# Environment:
#   PITR_WORK_DIR   scratch directory (default: mktemp -d). Must be traversable by the postgres user.
#   PITR_PORT       port of the scratch cluster and of the restored cluster (default 55432 / +1)
#   PITR_SEED       1 = run the Prisma seed after migrating (default 1)
#   PITR_KEEP       1 = keep the work directory after the run (default 0)
#   PG_BINDIR       PostgreSQL bin directory (default: pg_config --bindir, else newest /usr/lib/postgresql/*/bin)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${PITR_PORT:-55432}"
RESTORE_PORT="$((PORT + 1))"
SEED="${PITR_SEED:-1}"
KEEP="${PITR_KEEP:-0}"
DB_NAME="nebula_pitr"
KEY_TABLES=(User BalanceAccount BalanceLedger Withdrawal Reward AuditLog)

log() { printf '[pitr-drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '[pitr-drill] FAIL: %s\n' "$*" >&2; exit 1; }
now_ms() { date +%s%3N; }

# --- locate PostgreSQL binaries --------------------------------------------------------------
find_bindir() {
  if [[ -n "${PG_BINDIR:-}" ]]; then printf '%s' "$PG_BINDIR"; return; fi
  local d=""
  if command -v pg_config >/dev/null 2>&1; then d="$(pg_config --bindir)"; fi
  if [[ -z "$d" || ! -x "$d/initdb" ]]; then
    d="$(find /usr/lib/postgresql -maxdepth 2 -type d -name bin 2>/dev/null | sort -V | tail -n1 || true)"
  fi
  printf '%s' "$d"
}
BINDIR="$(find_bindir)"
for b in initdb pg_ctl pg_basebackup psql; do
  [[ -x "$BINDIR/$b" ]] || die "PostgreSQL binary '$b' not found in '$BINDIR' (set PG_BINDIR)"
done

# PostgreSQL refuses to run as root: run server-side commands as the postgres OS user.
if [[ "$(id -u)" -eq 0 ]]; then
  id postgres >/dev/null 2>&1 || die "running as root but no 'postgres' OS user exists"
  PG_USER="postgres"
  as_pg() { runuser -u postgres -- "$@"; }
else
  PG_USER="$(id -un)"
  as_pg() { "$@"; }
fi

# --- scratch layout + cleanup ----------------------------------------------------------------
if [[ -n "${PITR_WORK_DIR:-}" ]]; then
  WORK="$PITR_WORK_DIR"
  [[ -e "$WORK" && -n "$(ls -A "$WORK" 2>/dev/null)" ]] && die "PITR_WORK_DIR '$WORK' exists and is not empty"
  mkdir -p "$WORK"
  CREATED_WORK=1
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/nebula-pitr.XXXXXX")"
  CREATED_WORK=1
fi
PRIMARY="$WORK/primary"
RESTORED="$WORK/restored"
ARCHIVE="$WORK/wal-archive"
BASEBACKUP="$WORK/basebackup"
# Unix socket paths are limited to ~107 bytes, so the socket dir lives in a short path.
SOCK="$(mktemp -d /tmp/pitr-sock.XXXXXX)"

cleanup() {
  local rc=$?
  set +e
  if [[ "$rc" -ne 0 ]]; then
    for l in "$WORK"/primary.log "$WORK"/restored.log; do
      [[ -f "$l" ]] && { echo "--- tail $l" >&2; tail -n 20 "$l" >&2; }
    done
  fi
  for d in "$RESTORED" "$PRIMARY"; do
    if [[ -f "$d/postmaster.pid" ]]; then
      if ! as_pg "$BINDIR/pg_ctl" -D "$d" -m immediate -w stop >/dev/null 2>&1; then
        # Never leave an orphaned postmaster behind: fall back to SIGQUIT (immediate shutdown).
        pid="$(head -n1 "$d/postmaster.pid" 2>/dev/null)"
        [[ "$pid" =~ ^[0-9]+$ ]] && kill -QUIT "$pid" 2>/dev/null && sleep 1
      fi
    fi
  done
  if [[ "$KEEP" == "1" ]]; then
    log "keeping work dir $WORK"
  elif [[ "${CREATED_WORK:-0}" == "1" && -n "$WORK" && -d "$WORK" ]]; then
    rm -rf -- "$WORK"
  fi
  [[ -n "${SOCK:-}" && -d "$SOCK" ]] && rm -rf -- "$SOCK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$ARCHIVE"
chmod 700 "$WORK"
if [[ "$PG_USER" != "$(id -un)" ]]; then chown -R "$PG_USER" "$WORK" "$SOCK"; fi
as_pg test -w "$WORK" || die "postgres user cannot write to $WORK (every parent dir must be traversable)"

psql_at() { # psql_at <port> <db> <sql>  -> unaligned, tuples only
  as_pg "$BINDIR/psql" -X -v ON_ERROR_STOP=1 -h "$SOCK" -p "$1" -U "$PG_USER" -d "$2" -qAtc "$3"
}
counts() { # counts <port>  -> "Table=n ..." for KEY_TABLES
  local out="" t
  for t in "${KEY_TABLES[@]}"; do out+="$t=$(psql_at "$1" "$DB_NAME" "SELECT count(*) FROM \"$t\"") "; done
  printf '%s' "${out% }"
}

log "PostgreSQL: $("$BINDIR/pg_ctl" --version) ($BINDIR); work dir $WORK"
T0=$(now_ms)

# --- 1. scratch primary with WAL archiving ---------------------------------------------------
as_pg "$BINDIR/initdb" -D "$PRIMARY" -U "$PG_USER" --auth=trust -E UTF8 --locale=C >/dev/null
cat >>"$PRIMARY/postgresql.conf" <<EOF
# --- pitr-drill ---
listen_addresses = 'localhost'
port = $PORT
unix_socket_directories = '$SOCK'
wal_level = replica
archive_mode = on
# Atomic publish (copy to a temp name, then rename) so a restore never sees a partial segment.
archive_command = 'test ! -f $ARCHIVE/%f && cp %p $ARCHIVE/%f.tmp && mv $ARCHIVE/%f.tmp $ARCHIVE/%f'
archive_timeout = 60
max_wal_senders = 4
fsync = off
EOF
as_pg "$BINDIR/pg_ctl" -D "$PRIMARY" -l "$WORK/primary.log" -w start >/dev/null
psql_at "$PORT" postgres "CREATE DATABASE $DB_NAME" >/dev/null
DB_URL="postgresql://$PG_USER@localhost:$PORT/$DB_NAME"

# --- 2. schema (+ seed) ----------------------------------------------------------------------
log "applying Prisma migrations"
(cd "$REPO_ROOT" && DATABASE_URL="$DB_URL" npx --no-install prisma migrate deploy >"$WORK/migrate.log" 2>&1) \
  || { cat "$WORK/migrate.log" >&2; die "prisma migrate deploy failed"; }
if [[ "$SEED" == "1" ]]; then
  log "seeding (tsx prisma/seed.ts)"
  (cd "$REPO_ROOT" && DATABASE_URL="$DB_URL" NODE_ENV=development npx --no-install tsx prisma/seed.ts >"$WORK/seed.log" 2>&1) \
    || { tail -n 40 "$WORK/seed.log" >&2; die "seed failed"; }
fi
psql_at "$PORT" "$DB_NAME" 'CREATE TABLE pitr_drill_marker (id serial PRIMARY KEY, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp())'
T_SCHEMA=$(now_ms)

# --- 3. base backup --------------------------------------------------------------------------
log "taking pg_basebackup"
as_pg "$BINDIR/pg_basebackup" -h "$SOCK" -p "$PORT" -U "$PG_USER" -D "$BASEBACKUP" -Fp -X stream -c fast >/dev/null
T_BASE=$(now_ms)

# --- 4. drill data after the base backup (only recoverable via WAL replay), then T -----------
RUN_ID="pitr$(date +%s)"
psql_at "$PORT" "$DB_NAME" "
BEGIN;
INSERT INTO pitr_drill_marker(label) SELECT 'pre-T-' || g FROM generate_series(1, 5) g;
INSERT INTO \"User\"(id, username, \"updatedAt\") VALUES ('${RUN_ID}_user', '${RUN_ID}_pilot', now());
INSERT INTO \"BalanceAccount\"(id, key, type, asset, \"userId\", \"allowNegative\", \"updatedAt\") VALUES
  ('${RUN_ID}_src', '${RUN_ID}:issuance', 'SYSTEM', 'CREDITS', NULL, true, now()),
  ('${RUN_ID}_dst', '${RUN_ID}:user', 'USER', 'CREDITS', '${RUN_ID}_user', false, now());
INSERT INTO \"BalanceLedger\"(id, \"debitAccountId\", \"creditAccountId\", \"userId\", type, asset, amount, reference, \"idempotencyKey\")
  SELECT '${RUN_ID}_l' || g, '${RUN_ID}_src', '${RUN_ID}_dst', '${RUN_ID}_user', 'PITR_DRILL', 'CREDITS', 100 * g, 'pitr-drill', '${RUN_ID}:' || g
  FROM generate_series(1, 3) g;
COMMIT;" >/dev/null
PRE_MARKERS=$(psql_at "$PORT" "$DB_NAME" "SELECT count(*) FROM pitr_drill_marker WHERE label LIKE 'pre-T-%'")
PRE_COUNTS=$(counts "$PORT")
sleep 1
T_TARGET=$(psql_at "$PORT" "$DB_NAME" "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sleep 1
log "recovery target T = $T_TARGET"
log "pre-T snapshot: markers=$PRE_MARKERS $PRE_COUNTS"

# --- 5. destructive change after T (scratch cluster only) ------------------------------------
psql_at "$PORT" "$DB_NAME" "
BEGIN;
SET LOCAL client_min_messages = warning;
DELETE FROM pitr_drill_marker;
INSERT INTO pitr_drill_marker(label) VALUES ('post-T-disaster');
TRUNCATE \"BalanceLedger\", \"BalanceAccount\", \"User\" CASCADE;
COMMIT;" >/dev/null
POST_COUNTS=$(counts "$PORT")
log "after destructive change: $POST_COUNTS"
T_DISASTER=$(now_ms)

# --- 6. force WAL switch and wait for archiving ----------------------------------------------
LAST_WAL=$(psql_at "$PORT" "$DB_NAME" "SELECT pg_walfile_name(pg_switch_wal())")
archived() { [[ "$(psql_at "$PORT" postgres "SELECT coalesce(last_archived_wal >= '$LAST_WAL', false) FROM pg_stat_archiver")" == "t" ]]; }
for _ in $(seq 1 60); do
  archived && break
  sleep 0.5
done
archived || die "WAL segment $LAST_WAL was not archived (see $WORK/primary.log)"
log "archived through $LAST_WAL ($(find "$ARCHIVE" -maxdepth 1 -type f | wc -l) files in archive)"
# The primary is "lost" from here on.
as_pg "$BINDIR/pg_ctl" -D "$PRIMARY" -m immediate -w stop >/dev/null

# --- 7. restore base backup + replay WAL up to T ---------------------------------------------
T_RESTORE_START=$(now_ms)
cp -a "$BASEBACKUP" "$RESTORED"
cat >>"$RESTORED/postgresql.conf" <<EOF
# --- pitr-drill restore ---
port = $RESTORE_PORT
archive_mode = off
restore_command = 'cp $ARCHIVE/%f %p'
recovery_target_time = '$T_TARGET'
recovery_target_inclusive = true
recovery_target_action = 'promote'
EOF
as_pg touch "$RESTORED/recovery.signal"
as_pg "$BINDIR/pg_ctl" -D "$RESTORED" -l "$WORK/restored.log" -w -t 120 start >/dev/null
for _ in $(seq 1 120); do
  [[ "$(psql_at "$RESTORE_PORT" postgres 'SELECT pg_is_in_recovery()' 2>/dev/null || true)" == "f" ]] && break
  sleep 0.5
done
[[ "$(psql_at "$RESTORE_PORT" postgres 'SELECT pg_is_in_recovery()')" == "f" ]] || die "restored cluster did not finish recovery"
T_RESTORE_END=$(now_ms)

# --- verify ----------------------------------------------------------------------------------
REC_MARKERS=$(psql_at "$RESTORE_PORT" "$DB_NAME" "SELECT count(*) FROM pitr_drill_marker WHERE label LIKE 'pre-T-%'")
REC_POST=$(psql_at "$RESTORE_PORT" "$DB_NAME" "SELECT count(*) FROM pitr_drill_marker WHERE label = 'post-T-disaster'")
REC_LEDGER=$(psql_at "$RESTORE_PORT" "$DB_NAME" "SELECT coalesce(sum(amount), 0) FROM \"BalanceLedger\" WHERE \"idempotencyKey\" LIKE '${RUN_ID}:%'")
REC_COUNTS=$(counts "$RESTORE_PORT")
LAST_REPLAYED=$(grep -Eo 'last completed transaction was at log time [^"]+' "$WORK/restored.log" | tail -n1 || true)

fail=0
check() { if [[ "$2" == "$3" ]]; then printf '  PASS  %-34s %s\n' "$1" "$2"; else printf '  FAIL  %-34s expected=%s got=%s\n' "$1" "$3" "$2"; fail=1; fi; }
echo
echo "================ PITR drill summary ================"
echo "  recovery target T          : $T_TARGET"
echo "  ${LAST_REPLAYED:-last replayed transaction: (not reported)}"
check "pre-T marker rows restored" "$REC_MARKERS" "$PRE_MARKERS"
check "post-T marker absent" "$REC_POST" "0"
check "drill ledger postings (sum)" "$REC_LEDGER" "600"
check "key-table row counts == pre-T" "$REC_COUNTS" "$PRE_COUNTS"
echo "  pre-T counts               : $PRE_COUNTS"
echo "  post-disaster counts       : $POST_COUNTS"
echo "  restored counts            : $REC_COUNTS"
echo "  timings (ms)               : schema+seed=$((T_SCHEMA - T0)) basebackup=$((T_BASE - T_SCHEMA)) restore+replay(RTO)=$((T_RESTORE_END - T_RESTORE_START)) total=$((T_RESTORE_END - T0))"
echo "  data loss window (RPO)     : 0 committed transactions before T lost (WAL archived through $LAST_WAL; disaster at +$((T_DISASTER - T_BASE)) ms after base backup)"
if [[ "$fail" == "0" ]]; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL (logs: $WORK/*.log; rerun with PITR_KEEP=1 to inspect)"
  exit 1
fi
