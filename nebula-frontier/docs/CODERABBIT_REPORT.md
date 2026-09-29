# CodeRabbit Report — NEBULA FRONTIER

**Review Date:** 2026-09-28 (rounds 16:38–now, UTC)
**CodeRabbit Version:** CodeRabbit GitHub App, OSS plan (assertive profile). The report header says "Plan: Advanced" because the repository is public, so the OSS tier applies. The CLI (`coderabbit review --agent`) was not usable in this sandbox, so every review ran through the GitHub App on pull requests.
**Configuration:** `/.coderabbit.yaml`, with per-area `path_instructions` (security, multiplayer, economy, blockchain, database, UI, tests) and `path_filters` that exclude `legacy/`, `tools/reference-repos/`, generated Prisma code, lockfiles and build output. The project rules the reviewer enforces are in `nebula-frontier/CLAUDE.md`.

## How the review was run

The OSS plan limits a pull request to **100 files**, allows roughly **one review per hour**, and reviews only on request (this repository has fewer than 10 stars). The project has about 700 source files, so it is reviewed in subsystem slices.

`tools/review-branch.sh <name> <paths…>` builds two commits:
- a **base** commit: the project tree minus the slice, parented on the merge base with `main`;
- a **head** commit: the full tree, parented on base.

The pull request diff therefore contains exactly one subsystem, as of the development branch head. After fixes, the pair is rebuilt from the new head and CodeRabbit is re-triggered with `@coderabbitai review`.

Review output was treated as **untrusted input**: its shell snippets and suggested commands were never run. Each finding was verified against the code before any fix. No finding was "fixed" with `eslint-disable`, `@ts-ignore` or a skipped test.

| PR | Slice | Files | Status |
|---|---|---|---|
| [#2](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/2) | game-server, game-core, telemetry | 75 | Round 1: 22 findings, all fixed. Round 2: 2 follow-ups, fixed. Round 3: 16 findings, all fixed in `ebe3881`. Round 4 (refreshed, 75 files): 16 inline findings plus 2 clan-war concerns from the security summary, all fixed in `b0f9418`, `4c99561`, `76d7627` |
| [#3](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/3) | economy, ledger, blockchain, withdrawal service, Anchor program, audit tooling | 85 | Round 1: 32 findings, all resolved. Round 2 (refreshed branch, 86 files): 14 findings, all fixed in `424ae31` |
| [#4](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/4) | API (`apps/api`) | 64 | Full review (after the 93-file attempt failed and the slice was split): 40 findings, all fixed in `ff7c7ca`, with a reply on every thread |
| [#8](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/8) | shared, validation, authentication, Prisma | 30 | Split from #4 (refreshed to 32 files): 30 findings, 29 fixed and 1 partly fixed (FKs added, catalog and listing FKs declined with reasons) in `baa8a73`, `5aa2550`, `f51c2bc`, with a reply on every thread |
| [#5](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/5) | web app | 91 | Queued (rate limit) |
| [#6](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/6) | game client, renderer, networking | 72 | Queued (rate limit) |
| [#7](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/7) | admin, game-ui, config data, mobile config, Docker, tests | 91 | Queued (rate limit) |

## Summary (all completed rounds)

| Metric | Count |
|---|---|
| Files reviewed | 256 (PR #2 75 + PR #3 85 + PR #4 64 + PR #8 32) |
| Findings | 174 (PR #2: 22 + 2 + 16 + 18; PR #3: 32 + 14; PR #4: 40; PR #8: 30) |
| Critical | 1 |
| High (CodeRabbit "Major") | 72 |
| Warning (CodeRabbit "Minor") | 71 |
| Info (CodeRabbit "Trivial"/nitpick) | 30 |
| Fixed | 172 (plus 1 partly fixed: PR #8 gear/listing FKs) |
| Accepted as already addressed | 1 (PR #3 BC-05/BC-07 audit paths, already correct) |
| Remaining open | 0 from completed rounds |

### Security
- **Game tickets:**
  - `REDIS_URL` is required in production, so ticket replay protection is shared across processes.
  - The game server alone enforces single use with `SET gt:<jti> NX`.
- **Chat:** tag characters and other invisible code points are stripped.
- **Treasury key:**
  - It is no longer written to the shared root `.env`; it uses `TREASURY_SECRET_FILE` with 0600 permissions.
  - `.env` is forced to 0600.
  - The Anchor workspace uses a dedicated deployer key.
- **Payout adoption:** a memo match is verified before it is adopted as a payout (fee payer, signer, exact amount, recipient, mint and memo). A spoofed inbound transaction can no longer complete a withdrawal.
- **Mock RPC:** it is no longer in the production barrel; it is only in `@nebula/blockchain/testing`.
- **Economy config:** prototype-pollution keys are rejected in config paths.
- **Anchor program:**
  - `initialize` is restricted to the program's upgrade authority.
  - It has signer rotation, a two-step authority transfer, and a per-epoch on-chain emission cap.
  - The paused state blocks new escrow and tournament deposits.

### Data integrity and economy
- **Ledger:**
  - `post()` requires a transaction.
  - Idempotency races resolve as duplicates.
  - `reverse()` has a fixed key and refuses COMPENSATION entries.
  - The integrity check compares every account with its journal, which detects drift.
- **Isolation and races:**
  - SERIALIZABLE config updates, breaker toggles and risk updates.
  - Conditional reward review and claim transitions.
  - Starter-kit row lock.
  - Escrow-safe ammo consumption.
  - Duplicate-safe `chargeCredits`.
- **Deposits:**
  - The gem grant is locked on the deposit when it is prepared.
  - One bad signature no longer strands a paid, memo-bound deposit.
- **Budgets and baselines:**
  - The daily emission cap is scoped per season.
  - The DAU baseline comes from snapshot history.
- **Treasury bootstrap:** SOL never backs NEBX in SPL-mint mode (this was the one **Critical** finding).
- **Raids:** the minimum pilot count, the daily entry limit, and loot/XP/credit scaling by participation.

### Performance
- Fire-rate tick drift is fixed: sustained DPS had been about 5% low at 20 Hz.
- Matchmaking keeps parties whole and in one region.
- The gear score uses the equipped loadout.
- The pool size (`DB_POOL_SIZE`) is validated.

### Architecture
- Money in game-core is now `bigint` base units, through `toMoney` and `mulMoney`.
- There is one shared blockchain-service notifier.
- Rules and tuning overrides use strict schemas, fall back to defaults, and validate ranges after defaults are applied.
- The build configs exclude tests, and typecheck includes them.

## PR #2 — game server, game-core, telemetry

- **Round 1** (22 findings: 9 Major, 11 Minor, 2 Trivial) was fixed in `7bf5e20`. There is one regression test per finding. Details: `docs/audit/coderabbit/pr2-round1-resolution.md`. CodeRabbit verified and resolved 20 threads.
- **Round 2** had 2 follow-ups:
  - **Partial tuning overrides could invert the hit-chance range.** Fixed in `dca30c3`: the range is validated against the merged defaults. Test #20 was extended.
  - **Partial raids got unscaled loot.** Fixed in `dca30c3`/`a5935fa`: `rollLoot` gained a `scale` option that scales the number of rolls, and `npcDied` passes the raid reward scale. Test "#12 raid loot follows the raid reward scale".
- **Round 3:** re-review requested on the refreshed branch.

- **Round 3** (16 findings: 10 Major, 3 Minor, 3 Trivial) was fixed in `ebe3881`, and every thread got a reply. The Major findings:
  - **Persistence durability:**
    - A failed final flush after a player leaves goes into a process-wide retry queue with backoff. It is drained on dispose and shutdown, and a dropped delta is counted in a metric.
    - Post-commit work can no longer merge a committed delta back, which had applied it twice.
    - Pet writes are scoped to the owner.
  - **Admission:**
    - Portal and event tickets must match the target map (Event, Gate, Raid and PvP rooms).
    - The raid daily limit is checked and claimed atomically under a user-row lock.
  - **Clan missions:** bounded aggregates, and stable event IDs with a unique receipt table (migration), so retries are no-ops.
  - **Security:**
    - A remote plain-HTTP internal URL is rejected when a token is set.
    - `bot_` usernames are reserved, because the bot runner selects accounts by that prefix.
  - **Bots:** CLI input validated with zod; the run deadline is respected.

  The Minor and Trivial findings:
  - unbounded `processedLoot` and `pvpKillLog`;
  - the `toMoney` safe-integer guard;
  - a deterministic PvP test spot;
  - restoring the environment in tests;
  - a concurrent ticket-redemption test, in memory and in Redis.

A **load test** after round 3 (100 bots, 50v50 scale) found two regressions, which I fixed myself:
- **Anti-cheat false positives:** `MovementBudget` flagged honest input clumps after network jitter as SPEED_HACK. It now allows a 1-second burst and flags only sustained excess (25%). Test: honest jitter is not flagged, 2× rate is.
- **Dropped risk signals:** the SERIALIZABLE transaction introduced for the PR #3 risk finding caused `TransactionWriteConflict` across users under load. It is now a per-user row lock (`FOR UPDATE`), which keeps the fix's guarantee without cross-user conflicts. Test: `risk.db.test.ts`.

## PR #3 — economy, ledger, blockchain

32 findings: 1 Critical, 16 Major, 11 Minor, 4 Trivial. By category: 9 data integrity, 8 security, 8 correctness, 3 stability, 4 maintainability.

The fixes are in `dca30c3` (Anchor program and audit tooling) and `460386f` (ledger, economy, blockchain, API). Every thread has a reply naming the commit and the change.

| Finding | Severity | Resolution |
|---|---|---|
| bootstrap adds SOL + NEBX | Critical | Native-SOL mode was already correct: one wallet backs both assets, so both claims are subtracted. SPL mode is fixed: NEBX is reconciled only against the reward-token balance. Test `bootstrap.db.test.ts` |
| `post` accepts a non-transactional client | Major | Takes `Tx` only, with a runtime guard; idempotency races resolve as duplicates |
| `ensureAccount` catches every error | Major | Insert-or-skip, then re-read; other errors propagate |
| `reverse` allows repeat/compensation reversals | Major | Fixed key `reverse:<id>`; `NOT_REVERSIBLE` for COMPENSATION entries |
| `verifyLedgerIntegrity` cannot see drift | Major | Aggregate per-account replay comparison; drift test |
| breaker toggle and audit not atomic | Major | One SERIALIZABLE transaction |
| config update not SERIALIZABLE | Major | `withSerializableTx` |
| DAU baseline pins the activity multiplier | Major | Average of daily maxima of `EconomySnapshot.dau` |
| gem pack re-derived at credit time | Major | `Deposit.productId`/`gems` (migration), locked at prepare |
| reward review/claim unconditional | Major | Conditional `updateMany`, which requires exactly one row |
| risk update not atomic | Major | SERIALIZABLE |
| deposit permanently rejected on one bad signature | Major | Records the failure reason and risk signal; the deposit stays creditable |
| memo-matched transaction adopted without verification | Major | `verifyPayoutTransaction` plus `findPayoutsByMemo`; spoof test |
| treasury secret in the shared `.env` | Major | `TREASURY_SECRET_FILE` (0600) |
| treasury key as Anchor wallet | Major | Dedicated deployer key |
| `initialize` front-running | Major | Upgrade-authority check through `ProgramData` |
| no rotation or emission cap on-chain | Major | `update_config`, two-step authority transfer, epoch cap |
| `DB_POOL_SIZE`, prototype keys, season-scoped cap, `mulRatioCeil`, `.env` 0600, unknown `--item`, paused deposits, `TournamentEntry` rent, audit runtime status | Minor | Fixed as suggested, each with a test |
| shared notifier, secret-leak test assertion, mock barrel, finally-restore in test | Trivial | Fixed |
| BC-05/BC-07 evidence paths | Minor | Already correct in the current code |

Verification after the fixes:
- `pnpm lint`: clean.
- `pnpm typecheck`: all workspaces pass.
- vitest for the affected packages: 16 files, 134 tests passed.
- `cargo test -p nebula_settlement`: 6 passed.

### PR #3 round 2 (14 findings: 6 Major, 7 Minor, 1 Trivial), all fixed in `424ae31`

| Finding | Severity | Resolution |
|---|---|---|
| Admin can approve their own withdrawal or reward | Major | `SELF_REVIEW` in `reviewWithdrawal` and `reviewReward` (four-eyes rule); tests |
| Restriction added after the grant does not freeze the claim | Major | `claimReward` re-checks `REWARD_BLOCKING_RESTRICTIONS`; test |
| Money config accepts fractional or unsafe values; subtree bypasses the leaf type check | Major | `units()` safe-integer check on every money field; recursive `sameShape`; tests |
| Duplicated `TREASURY_SECRET` line survives in `.env` | Major | Every matching line is removed; test |
| Mint CLI arguments are not validated | Major | zod `mintArgsSchema` (Solana owner, http(s) URIs); test |
| Mint does not check the cluster | Major | `assertRpcCluster` before `mintNft` |
| Missing internal token sends `Bearer ` | Minor | `internalServiceToken()` fails fast (at least 32 characters); test |
| Admin treasury view wrong in SPL mode | Minor | Mode-aware reconciliation plus reward-token delta (shared `getTokenBalance`) |
| READ COMMITTED replay reports `INSUFFICIENT_BALANCE` | Minor | Re-reads the idempotency key and returns `duplicate` |
| Spoof signals repeated and blamed on the victim | Minor | Attributed only to the player's own linked fee payer; deduplicated per signature under an advisory lock (`3f49a2c`, after a CodeRabbit follow-up); concurrency test |
| Fractional gem grants | Minor | Safe positive integers only |
| `DEPOSIT_SPIKE` uses a NEBX floor for SOL deposits | Minor | `circuitBreaker.depositSpikeFloorLamports` |
| Bootstrap audit records only lamports | Minor | Records the mode, backing balance and lamports |
| Audit header out of date | Trivial | Updated |

Verification: lint clean, typecheck and build pass on every workspace, and the full vitest suite passes (60 files, 464 tests).

## PR #4 — API (`apps/api`, 64 files)

40 findings: 14 Major, 17 Minor, 9 Trivial. All are fixed in `ff7c7ca`, and every thread has a reply. Three parallel work groups were each assigned their own files, and the combined result was validated as a whole.

**Money and economy integrity**
- Item and ship upgrades now record each attempt durably (a new `UpgradeAttempt` table, keyed by user, kind and idempotency key). A retry returns the stored outcome without rolling again or consuming resources.
- Crypto rewards from progress and quest claims go into a durable `RewardSettlement` outbox inside the claim transaction. A background job retries them with backoff, capped at 1 h, and marks a row FAILED after 8 attempts.
- Bounties are duplicate-safe under concurrent retries. Before this, a second bounty could be created without any credits backing it.
- The purchase fallback now also compares quantity.
- Gear stats count only items the ship owner holds that are not locked.
- A pet unlock is now an explicit serializable request that binds the pet item, so one item can no longer unlock pets on several accounts.
- The loadout PUT uses an optimistic `updatedAt` guard.
- Grants with duplicate item IDs get unique `originRef` values.
- Crafting reads equipped items inside its transaction.

**Authorization and races**
- Clan treasury withdrawals and kicks re-check membership and role inside the serializable transaction; withdrawals use the strict withdrawal rate limit.
- Clan-mission baselines are tied to the member's join time, so leaving and rejoining can no longer inflate progress. Mission stats use bigint arithmetic.
- The username cooldown is reserved atomically in Redis.
- Market and auction cancels respect MARKET_PAUSE.

**Operations and security**
- Production requires `DATABASE_URL` and a `METRICS_TOKEN` of at least 32 characters.
- `cache-control: no-store` is set on every response.
- Feature-flag rules are validated with zod, and malformed rules disable the flag.
- RPC errors are sanitized before they reach admins.
- Admin mail caps come from `@nebula/config`.
- The blockchain-service URL must use https in production unless it points at loopback.

**Jobs and delivery**
- Jobs run through `createJobRunner`: each job has a running guard and a tokenized Redis lock that is extended while the job runs.
- Idempotency and notification locks use tokens, with compare-and-delete on release.
- The HTTP/2 push client has an overall timeout.
- Notifications are inserted in batches (`notifyMany`).
- A single failing auction no longer blocks settlement of the rest of the batch.
- Analytics flushes are serialized.
- Faction-war standings are read-only, with territory sync moved to a job.
- The market DTOs no longer run one query per listing.

**Other**
- Leaderboard scores are sent as exact decimal strings, and the shared DTO and web pages were updated to match.
- Reward decimals come from the mint.
- Chat reports go to moderation instead of hiding the message automatically.
- GET requests for clan missions and pets no longer write.

A regression surfaced during validation: a game-server test expected a fixed base XP, but a live event (1.3× XP) became active when the date changed. The test now derives the expected XP from the room's multiplier.

Verification: lint clean; typecheck and build pass on all workspaces; the full vitest suite, 535 tests in 78 files, was green after that test fix.

**Round 2 (CodeRabbit re-check of the fix replies).** CodeRabbit confirmed 38 threads and asked for two more changes, both now fixed:
- The clan treasury withdrawal now also runs the `app.rateLimitWithdrawal` preHandler after `app.authenticate`. Before this, only the per-minute limit applied; now the per-hour withdrawal limit applies too, as on the wallet route.
- Craft starts are durably idempotent. `CraftJob.idempotencyKey` is a new column with a unique (userId, idempotencyKey) index, added by the non-destructive migration `20260930090000_craft_job_idempotency`. A retry reads the stored job inside the transaction, and a concurrent duplicate that hits the unique key (P2002) gets the winner's job. Either way, nothing is charged twice even if the Redis cache is lost. When `withIdempotency` finds the key no longer ours at result-write time, it now fails with 409 `IDEMPOTENCY_LOCK_LOST` instead of returning an uncached success; callers are durably idempotent, so the retry returns the committed outcome.
- New tests: a Redis-loss replay test for crafting, and an updated test for a lost lock.

Verification after round 2: typecheck and lint clean; vitest 536 tests in 78 files, all green.

## PR #8 — Core (shared, validation, authentication, Prisma; 32 files)

30 findings: 10 Major, 11 Minor, 9 Trivial. Every thread has a reply. Commits `baa8a73` (database and treasury), `5aa2550` (shared, auth, validation) and `f51c2bc` (money types, seed).

**Database integrity**
- A new migration, `20260929140000_integrity_constraints`, adds:
  - CHECK constraints: positive ledger amounts, distinct debit and credit accounts, no negative balance unless `allowNegative`, and withdrawal amounts matching the fee formula;
  - a trigger that makes `BalanceLedger` rows immutable;
  - `ON DELETE RESTRICT` from users to ledger, account, deposit, withdrawal, reward and purchase rows (no more cascade or `SET NULL`);
  - FKs from gear instances to `InventoryItem`, and from `FactionSeasonScore` to `Faction` and `Season`.
- The migration never deletes data. If orphan rows exist, adding the FKs fails and the migration stops for an operator.
- Two FK requests were declined, with reasons given on the thread:
  - catalog FKs, because the catalog's source of truth is `@nebula/config` and the DB tables only mirror it;
  - listing and auction FKs, because those rows double as sale history, and the escrow `lockedBy` guard already protects items while a listing is active.
- The future-dated craft migration is renamed to `20260929130000`.
- The clan treasury posts to the ledger first and updates the `bankCredits` cache only for a non-duplicate posting. A concurrency test covers it.

**Money precision**
- Money in `economy.json` and `shop.json` is written as decimal integer strings.
- `@nebula/config` parses these strictly (zod) into exact `bigint`. Stored overrides accept strings or older safe-integer numbers. Emission math is exact.
- `toBigInt` requires safe integers.
- `parseUnits` rejects excess fraction digits instead of truncating them.
- `formatUnits` validates `decimals`; `mulRatio` rejects non-finite ratios and documents its rounding.

**Security**
- `safeEqual` compares SHA-256 digests, so timing no longer leaks the input length. The refresh-token check uses it.
- `riskLevel` is removed from the player-facing `/api/me`.
- Player text rejects C1 control, bidi and zero-width characters.
- Client message lookup uses only the schema table's own keys.
- Token TTLs are validated. New tests cover expiry, a foreign issuer and a `kid` mismatch.
- The seed script:
  - never logs an operator-supplied admin password;
  - has no hardcoded DB URL;
  - writes the admin user, stats, roles and audit row in one transaction, and audits only when something changed;
  - replaces season rewards and NPC spawns transactionally, and validates prices with the SKU named in errors.

**Correctness**
- `banned=false` now parses as false.
- Admin event dates accept ISO strings only.
- `ClientMsg` no longer lists server-only events, and `FormationMsg` is typed `DroneFormation`.
- `clamp` and `wrapAngle` reject or neutralise non-finite input.
- The unused `@solana/kit` dependency is removed.

Verification: typecheck, lint and build are clean on all workspaces; vitest passes 580 tests in 81 files.

## PR #2 round 4 — game server, game-core, telemetry (75 files)

16 inline findings (5 Major, 9 Minor, 2 Trivial) and 2 High concerns from the security-architecture summary. All are fixed, and every inline thread has a reply. Commits: `b0f9418`, `4c99561` and `76d7627`.

**Persistence and economy integrity**
- Player flushes are idempotent:
  - each `PendingDelta` carries a stable `flushId`;
  - every flush first inserts a `PlayerFlush` guard row (`ON CONFLICT DO NOTHING`), so a retry after a lost COMMIT response never re-applies XP, resources or counters;
  - failed deltas are carried as separate entries with their own ID;
  - migration `20260929150000_player_flush_idempotency` only adds new objects.
- Loot and issuance money is `bigint` via `toMoney`. Fractional resources are floored, and the remainder is carried forward instead of aborting the flush.
- The retry queue keeps per-user order within a pass.
- A bounty payout is reported only after its transaction commits, and one failed bounty no longer blocks the rest.

**Rewards and anti-abuse**
- Raid scale, raid crypto weight and NPC reward factors count only qualifying contributors, so low-damage alts cannot inflate rewards.
- Clan-war rooms admit only an accepted, active war's two clans. Teams are fixed, and the war's reward is a single conditional claim, so a second match cannot award it again.
- The `GalaxyRoom` ping handler is rate-limited per client.

**Security and operations**
- `/metrics` requires a `METRICS_TOKEN` bearer token, compared in constant time. Production requires the token (at least 32 characters, documented in `.env.example`) and returns 404 without it.
- The logger also scrubs `Basic` credentials and credentials in URLs, and its `err` serializer handles non-`Error` values.
- A failed event-trigger subscription is caught and logged instead of causing an unhandled rejection.
- `nextEventWindow` guards a non-positive period, and tuning overrides require `minResist < maxResist`.
- Bot CLI: a timed stop resolves even when leaving fails, and the `mine` intent is sent only when it changes.
- The suite restores the environment variables it sets.

**Validation note:** one full-suite run hit an intermittent failure in the vertical-slice loot test. The loot roll can be resources only, and the test counted only items and credits. The test now also counts resources; the pilot starts with none, so the check stays meaningful.

Verification: typecheck, lint and build are clean; vitest passes 609 tests in 83 files.

## Remaining / follow-up

- PR #3 round 3: re-review of the fix commits (scheduled one hour apart because of the rate limit).
- PR #5–#7 cover web, client and platform. Their results are added here as they arrive.

## History note

A development Redis snapshot (`dump.rdb`) was committed once in WIP commit `769aac3` and removed in a later commit, and `*.rdb` is now git-ignored. I checked its contents: local game cache and rate-limit keys only, with no secrets, tokens or keys.
