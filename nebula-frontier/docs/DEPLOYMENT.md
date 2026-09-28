# Deployment

## Topology (production)
| Tier | Component | Scaling | Notes |
|---|---|---|---|
| Edge | Cloudflare (DNS, TLS, CDN, WAF, rate limiting) | global | WebSockets enabled for `/game/*`. |
| Static | `apps/web`, `apps/admin` bundles (nginx or Cloudflare Pages / R2) | CDN | Admin additionally behind Cloudflare Access / IP allowlist. |
| API | `apps/api` | stateless, N replicas behind LB | Needs `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `GAME_TICKET_SECRET`, `INTERNAL_SERVICE_TOKEN`. |
| Game | `apps/game-server` | horizontal, per region (EU/NA/ASIA) | Redis presence + driver for matchmaking across processes; sticky WebSocket routing (`ip_hash` or Colyseus proxy). |
| Worker | `apps/blockchain-service` | single active (leader) + warm standby | The only process with `TREASURY_SECRET`. Separate network segment, no public ingress. |
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
- PostgreSQL: daily `pg_dump` (retain 30 days) + continuous WAL archiving for point-in-time recovery; weekly restore drill. `EconomyConfig`, `FeatureFlag`, `ShopProduct` are additionally exported to object storage on every admin change. `AuditLog` retained ≥ 2 years (append-only role).
- Blockchain service crash: queued work lives in `Withdrawal`/`ChainTransaction` rows; on boot the service re-enqueues non-terminal states and re-checks signatures before resubmitting (no double payouts).
- Game server crash: players' progress is persisted on events and periodically; reconnect restores from DB.
- Redis loss: sessions, balances, inventory, rewards and queue records remain in Postgres; only presence/rate-limit counters reset.

## Monitoring
Prometheus scrapes `/metrics` (API, game-server, blockchain-service): CPU/RAM (node exporter), DB & Redis latency, RPC latency, active rooms/players, tick duration, packet rate, error rate, withdrawal queue depth, rewards and treasury gauges. Alert on: treasury health WARNING/CRITICAL, circuit breaker activation, withdrawal queue age > 15 min, tick p95 > 45 ms, 5xx rate > 1%.
