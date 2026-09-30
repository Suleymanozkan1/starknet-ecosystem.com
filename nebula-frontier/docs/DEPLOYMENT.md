# Deployment

## Topology (production)
| Tier | Component | Scaling | Notes |
|---|---|---|---|
| Edge | Cloudflare (DNS, TLS, CDN, WAF, rate limiting) | global | WebSockets enabled for `/game/*`. |
| Static | `apps/web`, `apps/admin` bundles (nginx or Cloudflare Pages / R2) | CDN | Admin additionally behind Cloudflare Access / IP allowlist. |
| API | `apps/api` | stateless, N replicas behind LB | Needs `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `GAME_TICKET_SECRET`, `INTERNAL_SERVICE_TOKEN`. |
| Game | `apps/game-server` | horizontal, per region (EU/NA/ASIA) | Redis presence + driver for matchmaking across processes; sticky WebSocket routing (`ip_hash` or Colyseus proxy). |
| Worker | `apps/blockchain-service` | single active (leader) + warm standby | The only process with `TREASURY_SECRET` (or a `TREASURY_SECRET_FILE` mounted secret). Separate network segment, no public ingress. |
| Data | PostgreSQL 16 (managed, PITR) | primary + replica | Source of truth. |
| Cache/Queue | Redis 7 (AOF) | primary + replica | Non-critical state only. |

## Local (docker compose)
```bash
cp .env.example .env   # fill secrets
docker compose up --build
# web: http://localhost:8088  api: :8080  game: :2567
```
The `migrate` service runs `prisma migrate deploy` + seed before services start.

## VPS (single host)
1. Install Docker + compose plugin; clone repo; create `.env` with production secrets (never commit).
2. `docker compose up -d --build`.
3. Put Cloudflare in front (proxy DNS to the host, "Full (strict)" TLS with an origin certificate, enable WebSockets).
4. Restrict ports 5432/6379 to localhost (remove `ports:` for postgres/redis in production overrides).

## Secrets
- MVP: environment secrets injected by the orchestrator.
- Production: KMS/HSM/Secret Manager — the treasury key must be a KMS-backed signer (or HSM) used only by blockchain-service; rotate `JWT_SECRET`/`GAME_TICKET_SECRET` with dual-key verification.

## Backup & disaster recovery
- **PostgreSQL daily backup:** `scripts/backup/pg-backup.sh` writes a custom-format, compressed `pg_dump`, verifies it with `pg_restore --list`, writes a sha256 checksum, and keeps 30 days. It runs as the `backup` service in `docker-compose.yml` once every 24 h, into the `backups` volume.
- **Restore drill:** `scripts/backup/pg-restore-drill.sh` restores the newest dump into a scratch database and compares row counts of the critical tables (users, ledger, balances, withdrawals, rewards, audit log). Run it weekly.
- **Point-in-time recovery (PITR):** WAL archiving is enabled on the compose `postgres` service (`wal_level=replica`, `archive_mode=on`, `archive_timeout=60`, segments copied atomically — `cp` to `%f.tmp` then `mv` — into the `walarchive` volume). A point-in-time restore = a base backup (`pg_basebackup`) + the WAL archive replayed up to a `recovery_target_time`.
  - **Drill:** `scripts/backup/pitr-drill.sh` (run from the repo root; as root it runs the cluster as the `postgres` OS user). It never touches an existing cluster: it `initdb`s a throwaway cluster (port `PITR_PORT`, default 55432; restore on 55433) in a `mktemp -d` work dir (`PITR_WORK_DIR` to override; must be traversable by `postgres`), applies `prisma migrate deploy`, seeds (`PITR_SEED=0` to skip), takes a `pg_basebackup`, writes marker rows plus a drill user/account/3 ledger postings, snapshots row counts of `User`, `BalanceAccount`, `BalanceLedger`, `Withdrawal`, `Reward`, `AuditLog`, records the target time T, then simulates a disaster after T (deletes the markers, `TRUNCATE "User", "BalanceAccount", "BalanceLedger" CASCADE`), forces `pg_switch_wal()` and waits for `pg_stat_archiver`, "loses" the primary (immediate stop), restores the base backup into a new data dir with `restore_command` + `recovery_target_time=T` + `recovery.signal`, and verifies: markers present, post-T change absent, ledger postings intact, key-table counts equal to the pre-T snapshot. Prints `RESULT: PASS`/`FAIL` (non-zero exit on failure) and removes everything on exit (`PITR_KEEP=1` keeps the work dir). PG binaries: `PG_BINDIR`, else `pg_config --bindir`, else newest `/usr/lib/postgresql/*/bin`. Run it monthly and after any Postgres/Prisma upgrade.
  - **Observed in the drill (2026-09-30, PostgreSQL 16.13, seeded schema):** `RESULT: PASS`; pre-T / restored counts `User=2 BalanceAccount=47 BalanceLedger=3 Withdrawal=0 Reward=0 AuditLog=1` (post-disaster `User=0 BalanceAccount=0 BalanceLedger=0`); 5/5 markers restored, post-T marker absent. **RPO = 0** committed transactions before T (everything up to the last archived WAL is recoverable; on an idle server the worst case is bounded by `archive_timeout` = 60 s, plus loss of the un-archived current segment if the WAL disk itself is lost). **RTO ≈ 1.2 s** for base-backup copy + WAL replay + promote on this tiny data set (whole drill ≈ 21 s incl. migrate+seed ≈ 8 s and base backup ≈ 8 s); production RTO scales with database size and WAL volume since the last base backup — budget minutes to tens of minutes and take daily base backups to keep replay short.
  - **Lesson from the drill:** a plain `cp %p archive/%f` archive_command can expose a partially written segment (recovery aborted with `archive file ... has wrong size`); archive commands must publish atomically (temp file + rename, as now in compose and the drill).
  - **Production equivalent:** prefer a managed Postgres with built-in PITR (e.g. AWS RDS/Aurora automated backups with a ≥ 7-day retention window, Cloud SQL PITR, Azure Flexible Server) and drill a "restore to time" into a new instance quarterly. Self-managed: **pgBackRest** or **WAL-G** (daily full/differential base backups + continuous WAL push to encrypted, versioned object storage in a second region, `archive-async`, retention ≥ 14 days) — restore with `pgbackrest restore --type=time --target="<T>"` / `wal-g backup-fetch` + `restore_command='wal-g wal-fetch %f %p'` + `recovery_target_time`, and run the same verification queries as `pitr-drill.sh`. Target RPO ≤ 1 min, RTO ≤ 1 h.
- `EconomyConfig`, `FeatureFlag`, `ShopProduct` are additionally exported to object storage on every admin change. `AuditLog` retained ≥ 2 years (append-only role).
- Blockchain service crash: queued work lives in `Withdrawal`/`ChainTransaction` rows; on boot the service re-enqueues non-terminal states and re-checks signatures before resubmitting (no double payouts).
- Game server crash: players' progress is persisted on events and periodically; reconnect restores from DB.
- Redis loss: sessions, balances, inventory, rewards and queue records remain in Postgres; only presence/rate-limit counters reset.

## Monitoring
Prometheus scrapes `/metrics` (API, game-server, blockchain-service): CPU/RAM (node exporter), DB & Redis latency, RPC latency, active rooms/players, tick duration, packet rate, error rate, withdrawal queue depth, rewards and treasury gauges. Alert on: treasury health WARNING/CRITICAL, circuit breaker activation, withdrawal queue age > 15 min, tick p95 > 45 ms, 5xx rate > 1%.
