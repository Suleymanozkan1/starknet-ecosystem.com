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
| [#2](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/2) | game-server, game-core, telemetry | 75 | Round 1: 22 findings, all fixed. Round 2: 2 follow-ups, fixed. Round 3: 16 findings, all fixed in `ebe3881`. Round 4 queued |
| [#3](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/3) | economy, ledger, blockchain, withdrawal service, Anchor program, audit tooling | 85 | Round 1: 32 findings, all resolved. Round 2 (refreshed branch, 86 files): 14 findings, all fixed in `424ae31` |
| [#4](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/4) | API (`apps/api`) | 64 | The 93-file review failed at 23:12 UTC (CodeRabbit gave no reason), so the slice was split; retry at 00:00 UTC |
| [#8](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/8) | shared, validation, authentication, Prisma | 30 | Split from #4; review queued at 01:02 UTC |
| [#5](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/5) | web app | 91 | Queued (rate limit) |
| [#6](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/6) | game client, renderer, networking | 72 | Queued (rate limit) |
| [#7](https://github.com/Suleymanozkan1/starknet-ecosystem.com/pull/7) | admin, game-ui, config data, mobile config, Docker, tests | 91 | Queued (rate limit) |

## Summary (all completed rounds)

| Metric | Count |
|---|---|
| Files reviewed | 160 (PR #2 75 + PR #3 85) |
| Findings | 86 (PR #2: 22 + 2 + 16; PR #3: 32 + 14) |
| Critical | 1 |
| High (CodeRabbit "Major") | 41 |
| Warning (CodeRabbit "Minor") | 34 |
| Info (CodeRabbit "Trivial"/nitpick) | 10 |
| Fixed | 85 |
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

## Remaining / follow-up

- PR #2 round 4 and PR #3 round 3: re-reviews of the fix commits (scheduled one hour apart because of the rate limit).
- PR #4–#7 cover the API, web, client and platform. Their results are added here as they arrive.

## History note

A development Redis snapshot (`dump.rdb`) was committed once in WIP commit `769aac3` and removed in a later commit, and `*.rdb` is now git-ignored. I checked its contents: local game cache and rate-limit keys only, with no secrets, tokens or keys.
