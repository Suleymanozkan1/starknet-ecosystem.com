# NEBULA FRONTIER — Project rules (Claude + CodeRabbit)

Original persistent 3D space MMO (browser + Android + iOS) with a Solana **devnet** reward economy.
pnpm monorepo, Node 22, TypeScript 5.9 strict, ESM. See `docs/ARCHITECTURE.md` and `docs/research/TEAM_BRIEF.md`.

## Architecture
- `apps/web` (React/Vite SPA, also the Capacitor web layer), `apps/game-client` (Three.js world + Phaser radar/HUD layer), `apps/game-server` (Colyseus, authoritative), `apps/api` (Fastify REST), `apps/blockchain-service` (only holder of treasury key; withdrawal queue), `apps/admin`, `apps/mobile` (Capacitor).
- `packages/shared` (types, protocol, API DTOs), `config` (data-driven JSON game balance), `game-core` (deterministic simulation shared by client prediction + server), `economy`, `blockchain`, `database` (Prisma 7 + double-entry ledger), `authentication`, `validation`, `telemetry`, `game-renderer`, `game-network`, `game-ui`.

## Coding standards
- Strict TS; no `any`; no TS `enum`/namespaces/parameter properties (erasable syntax). Shared types from `@nebula/shared`.
- No hardcoded balance/prices — use `@nebula/config` data or DB (`EconomyConfig`, `ShopProduct`).
- Never silence problems with `eslint-disable`, `@ts-ignore`, skipped tests.
- Validate all external input with zod.

## Security rules
- Secrets only from env / secret manager; never log secrets, private keys, JWTs, cookies. Treasury key only in `apps/blockchain-service`.
- Auth: httpOnly Secure SameSite cookies, short-lived access + rotating refresh, CSRF header check for cookie-auth mutations, RBAC for admin, audit logs for admin actions.
- Wallet login: server nonce → signed message → server signature verification; nonce single-use + expiry (replay protection).
- Rate limit auth, wallet, withdrawal (very strict), chat, purchase, marketplace.

## Multiplayer rules
- Server authoritative. Clients send intents only. Validate & sanitize every message; enforce cooldowns/fire rate/speed server-side; flag anomalies via risk signals.
- Interest management (AOI) for large battles; batch DB writes; idempotent persistence (unique `originRef`/`idempotencyKey`).

## Database rules
- Non-destructive migrations. Every money movement through the ledger (`@nebula/database` `post`) inside a transaction with an idempotency key. Ledger rows are immutable; corrections are compensating entries.

## Economy rules
- Player spending ≠ player profit. Reward budget = seasonRevenue × rewardBudgetRatio (capped), treasury health multipliers, hard emission cap, daily/weekly/season caps, eligibility & risk review, circuit breakers.
- Never use investment terminology (APY, interest, guaranteed return, passive income, daily profit) in player UI.
- No unlimited mint; fixed max supply.

## Blockchain rules
- Devnet only. Verify network, mint, amount, recipient, memo, sender, confirmation and signature uniqueness for deposits. Withdrawals: idempotent, signature persisted before confirmation, never COMPLETED without confirmation, retry with backoff, durable queue in Postgres.

## Testing & review loop
IMPLEMENT → typecheck → lint → test → build → `coderabbit review --agent` → fix → re-test → re-review → clean.
Commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. CodeRabbit config: `/.coderabbit.yaml` (repo root). Review report: `docs/CODERABBIT_REPORT.md`.
