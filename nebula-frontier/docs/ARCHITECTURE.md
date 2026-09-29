# Architecture

```
                 Cloudflare (CDN, TLS, WAF)
                          │
                    nginx (edge)  ── static: apps/web, apps/admin
             ┌────────────┼──────────────────────┐
         /api/*        /game/* (WebSocket)        │
     apps/api (N×)   apps/game-server (N×) ── Redis presence/driver (room discovery, pub/sub)
   (stateless)          (authoritative sim)
        │   ╲               │
        │    ╲── internal ──┼──► apps/blockchain-service (1 active + standby; ONLY treasury key holder)
        │                   │         │  BullMQ queue (Redis) + durable ChainTransaction rows (Postgres)
        └──────── PostgreSQL (source of truth) ◄──┘         │
                                                    Solana devnet RPC
```

## Workspaces
| Path | Responsibility |
|---|---|
| `apps/web` | React SPA (menus, hangar, wallet, market…) and the Capacitor web layer. Mounts `apps/game-client`. |
| `apps/game-client` | Three.js world renderer + Phaser 2D radar/HUD layer, input (keyboard/mouse/gamepad/touch API), audio, prediction/interpolation. |
| `apps/game-server` | Colyseus rooms (sector, pvp, arena, boss, gate, raid, clan war, event, lobby/galaxy); fixed-tick authoritative simulation; persistence. |
| `apps/api` | Fastify REST: auth, profile, ships, inventory, shop, crafting, quests, market, auction, clan, social, economy, admin. Stateless. |
| `apps/blockchain-service` | Withdrawal/tx queue, confirmations, retries, treasury operations, economy controller jobs. |
| `apps/admin` | Admin dashboards (ops, economy, profitability, moderation). |
| `apps/mobile` | Capacitor Android/iOS shell around `apps/web/dist`. |
| `packages/shared` | Types, enums, protocol, API DTOs, bigint money helpers. |
| `packages/config` | Data-driven game content (JSON) + typed loaders + integrity validation. |
| `packages/game-core` | Deterministic simulation (movement, combat, stats, loot, AI, anti-cheat, quests, progression, matchmaking) shared by server and client prediction. |
| `packages/economy` | Reward engine, caps, eligibility, treasury health, emission, circuit breakers, fees, risk, simulation. |
| `packages/blockchain` | Solana Kit helpers: wallet signature verification, deposit verification, payouts, NFT metadata. |
| `packages/database` | Prisma client (pg adapter) + double-entry ledger. |
| `packages/authentication` | JWT access/refresh, game tickets, password hashing, wallet-login helpers. |
| `packages/validation` | Zod schemas for REST bodies and game messages. |
| `packages/telemetry` | Pino logging with redaction, correlation ids, Prometheus metrics. |
| `packages/game-renderer` | Procedural modular ship factory, effects, camera, hangar viewer, performance tiers. |
| `packages/game-network` | Typed Colyseus client, interpolation buffer, reconciliation. |
| `packages/game-ui` | Shared holographic React components. |

## Key decisions
- **Location:** the monorepo lives in `nebula-frontier/` because the Git repository previously hosted an unrelated site; that site is archived under `legacy/` and is inactive.
- **Server authority:** clients send intents (`ClientMessages`); every outcome is computed server-side with `game-core` and persisted by the server.
- **Game tickets:** the API issues a 60-second single-use JWT (`aud=game`) that the game server verifies in `onAuth`; the game server never sees refresh tokens.
- **Money:** integer base units (`bigint`), all movements through the append-only double-entry ledger with idempotency keys; user accounts can never go negative (conditional UPDATE).
- **Critical state in Postgres:** Redis holds presence, rate limits, queues and caches only. Chain operations are mirrored in `ChainTransaction`/`Withdrawal` rows so a Redis or service crash never loses a payout.
- **Scaling:** API stateless (N replicas); game servers scale horizontally with `@colyseus/redis-presence` + `@colyseus/redis-driver`; per-region deployments (EU/NA/ASIA) advertise `REGION` in room metadata; AOI filtering keeps bandwidth bounded for 50v50.
- **Data-driven balance:** JSON in `packages/config/data`, catalog mirrored to DB on seed; admin overrides via DB rows and `EconomyConfig` (audited).
- **Prisma 7 (stable)** rather than the Prisma 8 RC found on the repo's main branch.
- **Colyseus 0.18** (latest) with `@colyseus/schema` 5.

## Observability
Request ids (`x-request-id`), correlation ids across API → blockchain-service, match ids on game logs, transaction signatures on chain logs. `/health`, `/ready`, `/metrics` on every service.
