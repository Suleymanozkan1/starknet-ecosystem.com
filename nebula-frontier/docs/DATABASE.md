# NEBULA FRONTIER — Database

PostgreSQL 16 via Prisma 7 (`prisma-client` generator, driver adapter `@prisma/adapter-pg`),
schema `prisma/schema.prisma` (83 models), client exported by `@nebula/database`
(`getDb()`, `createDb()`, `withSerializableTx()`, ledger helpers). Redis holds only
non-authoritative state (rate-limit counters, presence, invites, idempotency caches, locks) — losing
Redis never loses money or items.

## 1. Schema overview

| Domain | Models | Notes |
|---|---|---|
| Identity & security | `User`, `Session`, `Device`, `Wallet`, `WalletNonce`, `AdminUser`, `AuditLog` | Session = refresh-token family (hash only). WalletNonce single-use (`usedAt`) with expiry. AuditLog append-only. |
| Factions | `Faction`, `PlayerFaction` | PlayerFaction PK = userId (a pilot chooses once). |
| Ships & gear | `Ship`, `ShipInstance`, `ShipStats`, `ShipUpgrade`, `ShipLoadout`, `ShipSkin`, `Weapon`, `WeaponInstance`, `Module`, `ModuleInstance`, `Drone`, `DroneInstance`, `Pet` | Catalog rows (`Ship`, `Weapon`, …) mirror `packages/config` JSON in `data` and allow admin overrides. `ShipInstance` unique per (user, ship). Loadouts store inventory-item ids per slot family. |
| Items & resources | `Item`, `InventoryItem`, `Resource`, `PlayerResource`, `CraftJob` | `InventoryItem.originRef` UNIQUE (every grant is traceable and non-replayable), `lockedBy` (escrow), `version` (optimistic concurrency). |
| World | `Galaxy`, `Sector`, `StarSystem`, `Map`, `Zone`, `NPC`, `NPCSpawn`, `GameRoom`, `GameMatch`, `GameMatchPlayer` | `GameRoom` heartbeats from game servers (admin overview). |
| Progression | `PlayerStat`, `Quest`, `UserQuest`, `Achievement`, `UserAchievement`, `Season`, `SeasonReward`, `BattlePass`, `Event`, `EventParticipation`, `Leaderboard`, `LeaderboardEntry` | `UserQuest` unique (user, quest, periodKey) → daily/weekly quests once per period. |
| Market | `MarketplaceListing`, `Auction`, `AuctionBid`, `Trade` | Listings/auctions carry `version`; `Trade.referenceId` UNIQUE (one settlement per listing/auction). |
| Social | `Clan`, `ClanMember`, `ClanWar`, `ClanTerritory`, `ClanStation`, `ClanStationModule`, `Squad`, `SquadMember`, `Friend`, `ChatMessage`, `ChatReport`, `Notification`, `Mail`, `Bounty` | `ClanMember` PK = userId (one clan per player). Clan treasury: see §2.3. |
| Shop | `ShopProduct`, `Purchase` | `Purchase` unique (userId, idempotencyKey). Prices only here. |
| Ledger & economy | `BalanceAccount`, `BalanceLedger`, `Reward`, `RewardClaim`, `RewardLiability`, `Deposit`, `Withdrawal`, `ChainTransaction`, `EconomyConfig`, `EconomySnapshot`, `CircuitBreaker`, `RiskSignal`, `FeatureFlag`, `AnalyticsEvent` | See §2. |

Money is always `BigInt` base units (credits/gems integers; NEBX/SOL lamports) and travels as
decimal strings in the API.

## 2. Double-entry ledger

`packages/database/src/ledger.ts`:

- `BalanceAccount` — one row per `(type, userId?, asset)` with a unique `key`
  (`USER_WALLET:<uid>:CREDITS`, `GAME_SINK:CREDITS`, …) and a cached `balance`. Only
  `GAME_ISSUANCE` and `EXTERNAL_CHAIN` may go negative (they represent flows).
- `BalanceLedger` — immutable journal row per transfer (`debitAccountId` → `creditAccountId`,
  `amount`, `type`, `reference`, `metadata`, `correlationId`) with a UNIQUE `idempotencyKey`.
- `post(tx, …)` first checks the idempotency key, then performs a **conditional decrement**
  (`UPDATE … SET balance = balance - x WHERE balance >= x`) — overdraft is impossible under any
  concurrency — and the matching increment, all inside the caller's transaction.
- Corrections are compensating postings (`reverse()`); rows are never updated or deleted.
- `verifyLedgerIntegrity()` asserts Σ balances = 0 per asset (checked by the integration tests);
  `replayBalance()` recomputes any account from the journal for reconciliation.

### 2.1 Flows used by the API

| Operation | From → To | Idempotency key |
|---|---|---|
| Quest / achievement / mail / battle-pass credits | `GAME_ISSUANCE:CREDITS` → `USER_WALLET` | `quest:<userQuestId>:credits`, `ach:<uid>:<id>:credits`, `mail:<id>:credits`, `bp:<season>:<track>:<tier>:<uid>:credits` |
| Shop (credits) | `USER_WALLET:CREDITS` → `GAME_SINK:CREDITS` | `purchase:<purchaseId>` |
| Shop / upgrades (gems) | `USER_WALLET:GEMS` → `PREMIUM_REVENUE:GEMS` | `purchase:<id>`, `ship-upgrade:<uid>:<key>:gems` |
| Ship / item upgrade, crafting, clan creation | `USER_WALLET` → `GAME_SINK` | `ship-upgrade:<uid>:<key>:credits`, `craft:<jobId>:credits`, `clan:<id>:create` |
| Market sale | buyer → seller (price − fee); buyer → `MARKETPLACE_REVENUE` (fee) | `market:<listingId>:proceeds`, `market:<listingId>:fee` |
| Auction listing / cancellation fee | seller → `AUCTION_REVENUE` | `auction:<id>:listing`, `auction:<id>:cancelfee` |
| Auction bid (escrow) / outbid refund | bidder → `ESCROW`; `ESCROW` → previous bidder | `auction:<id>:bid:<bidId>`, `auction:<id>:refund:<bidId>` |
| Auction settlement | `ESCROW` → seller (bid − fee), `ESCROW` → `AUCTION_REVENUE` | `auction:<id>:proceeds`, `auction:<id>:salefee` |
| Bounty escrow / expiry refund | creator → `ESCROW`; `ESCROW` → creator | `bounty:<uid>:<key>`, `bounty:<id>:refund` |
| Clan treasury deposit / withdraw / spend | member ↔ `ESCROW`; `ESCROW` → `GAME_SINK` | `clan:<id>:dep:<uid>:<key>`, `clan:<id>:wd:<uid>:<key>`, `clanstation:<id>:<module>:<level>` |

Deposits, withdrawals, rewards and treasury flows are documented by the economy workstream
(`docs/ECONOMY.md`).

### 2.2 Concurrency model

- Multi-step money/item operations run in `withSerializableTx` (SERIALIZABLE isolation, automatic
  retry with jittered backoff on `40001`/deadlock).
- State transitions are conditional updates: `status = 'ACTIVE' AND version = n` (listings,
  auctions), `lockedBy IS NULL AND version = n` (items), `claimedAt IS NULL` (quests, mail, crafts),
  `NOT (tier = ANY(claimedFree))` (battle pass), `usedAt IS NULL` (nonces). A zero row count
  aborts the transaction with `409`.
- Items are escrowed by setting `lockedBy = 'listing:<id>' | 'auction:<id>'`; transfer requires the
  exact lock; cancel/expiry releases it.

### 2.3 Clan treasury

Clan funds are held in the ledger's `ESCROW:CREDITS` account; `Clan.bankCredits` is the per-clan
sub-ledger updated in the same transaction (conditional decrement). Σ `Clan.bankCredits` +
open auction bids + active bounties = `ESCROW:CREDITS` balance (reconciliation query).

## 3. Indexes (selection)

| Table | Index | Serves |
|---|---|---|
| `BalanceLedger` | UNIQUE `idempotencyKey`; `(userId, createdAt)`, `(type, createdAt)`, `(reference)`, `(asset, createdAt)` | idempotency, history, reconciliation |
| `BalanceAccount` | UNIQUE `key`; `(userId, asset)`, `(type, asset)` | balance lookups |
| `InventoryItem` | UNIQUE `originRef`; `(userId, itemId)`, `(lockedBy)` | grants, inventory, escrow |
| `MarketplaceListing` | `(status, itemId, price)`, `(sellerId)`, `(expiresAt)` | market browse, expiry job |
| `Auction` | `(status, endsAt)`, `(itemId)` | settlement job |
| `AuctionBid` | `(auctionId, amount)`, `(bidderId, createdAt)` | bid history, abuse checks |
| `Purchase` | UNIQUE `(userId, idempotencyKey)`; `(createdAt)` | idempotency, revenue aggregates |
| `Session` | UNIQUE `refreshTokenHash`; `(userId)`, `(expiresAt)` | auth |
| `WalletNonce` | UNIQUE `nonce`; `(address)`, `(expiresAt)` | SIWS, cleanup job |
| `Device` | UNIQUE `(userId, fingerprint)`; `(fingerprint)`, `(ip)` | new-device + wash-trade detection |
| `UserQuest` | UNIQUE `(userId, questId, periodKey)`; `(userId, status)` | quest log |
| `RiskSignal` | `(userId, createdAt)`, `(type, createdAt)` | risk queue |
| `AuditLog` | `(action, createdAt)`, `(actorId)`, `(targetType, targetId)` | audit search |
| `Reward` | UNIQUE `(userId, source, sourceRef)` | duplicate reward prevention |

## 4. Migrations & seed

- Migrations live in `prisma/migrations` and are **non-destructive** (add columns/tables/indexes;
  renames done as add → backfill → switch → drop in a later release). Apply with
  `pnpm db:migrate` (`prisma migrate deploy`) before rolling out new API/game-server versions.
- `pnpm db:seed` (`prisma/seed.ts`) is idempotent: creates missing catalog rows from
  `packages/config` (factions, ships, weapons, modules, drones, items, resources, NPCs, quests,
  achievements, seasons + rewards, events, shop products, galaxy/sectors/systems/maps/zones/spawns,
  leaderboards), system ledger accounts for CREDITS/GEMS/NEBX, inactive circuit breakers, economy
  runtime defaults, feature flags and the SUPER_ADMIN (`ADMIN_EMAIL`/`ADMIN_PASSWORD`; dev defaults
  `admin@nebula.local` / `change-me-dev-only`, printed in development only). Existing rows are left
  untouched so admin overrides survive; `SEED_SYNC_CATALOG=true` re-syncs catalog rows from JSON.

## 5. Backups, retention, disaster recovery

| Item | Policy |
|---|---|
| Logical backup | Daily `pg_dump --format=custom` of the whole database, encrypted (age/KMS), stored off-site (object storage with object lock / WORM), retained 35 days + monthly copies for 12 months. |
| PITR | Continuous WAL archiving (e.g. `wal-g`/pgBackRest or managed-provider PITR) with weekly base backups; point-in-time restore window ≥ 14 days. |
| Replicas | One synchronous standby in another AZ (failover), async read replica for analytics/admin aggregates. |
| Targets | RPO ≤ 5 min (WAL shipping), RTO ≤ 1 h for the primary region. |
| Restore drills | Monthly automated restore of the latest dump into a scratch instance, followed by `verifyLedgerIntegrity()` and row-count checks; quarterly PITR drill. |
| Ledger reconciliation | Daily job: Σ balances per asset = 0, `replayBalance()` spot checks, `ESCROW` vs open escrow objects, on-chain treasury vs `EXTERNAL_CHAIN`/`TREASURY` accounts. |
| Audit retention | `AuditLog`, `BalanceLedger`, `RiskSignal`, `Deposit`, `Withdrawal`, `ChainTransaction`: append-only, retained ≥ 2 years online (7 years archived for financial records), never deleted by application code; the DB role used by the API has no `DELETE` on these tables in production. |
| Personal data | Account deletion anonymises `User` (email/username/devices/IPs) while keeping ledger/audit rows keyed by id (legal retention). IPs in `Session`/`Device` older than 180 days are nulled by a maintenance job. |
| Redis | Not backed up (rebuildable): rate limits, presence, invites, idempotency caches. |
| DR runbook | 1) freeze writes (circuit breakers + maintenance flag) 2) promote standby / restore PITR 3) run integrity + reconciliation 4) re-enable game servers, then API, then withdrawals last. |
