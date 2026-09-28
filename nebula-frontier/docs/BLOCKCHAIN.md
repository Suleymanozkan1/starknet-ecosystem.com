# Blockchain (Solana devnet)

NEBULA FRONTIER uses Solana **devnet only**. `SOLANA_NETWORK` accepts `devnet` / `testnet` / `localnet`; anything that looks like mainnet is refused at startup (`packages/blockchain/src/rpc.ts`), and the RPC's genesis hash is checked against the devnet genesis before any deposit is accepted or payout sent.

| Piece | Location | Role |
|---|---|---|
| `@nebula/blockchain` | `packages/blockchain` | `@solana/kit` 8.4 helpers: RPC, SIWS login message + signature verification, deposit verification, payout build/send/confirm, memo idempotency lookup, NFT metadata/mint, mock RPC |
| blockchain-service | `apps/blockchain-service` | **The only process that holds the treasury key.** Withdrawal queue (BullMQ + Postgres), confirmations, retries, economy controller, reward expiry, internal HTTP |
| API wallet routes | `apps/api/src/routes/wallet.ts` | Wallet link, deposits, withdrawal requests (no keys) |
| Settlement program | `programs/nebula_settlement` | Anchor 1.2 program (reward verification / escrow / tournament settlement). **Not deployed in the MVP** |

## Wallet authentication (Sign-In-With-Solana)

1. `POST /api/auth/nonce { address, purpose }` → the server stores a `WalletNonce` row and returns the exact message built by `buildLoginMessage({ domain, address, nonce, issuedAt, expiresAt, purpose })`:
   ```
   <domain> wants you to sign in with your Solana account:
   <address>

   <statement>

   URI: https://<domain>
   Version: 1
   Chain ID: solana:devnet
   Purpose: LOGIN | LINK_WALLET
   Nonce: <nonce>
   Issued At: <iso>
   Expiration Time: <iso>
   ```
2. The wallet signs the UTF‑8 bytes (`signMessage`) — no transaction, no fee.
3. `POST /api/auth/verify` (login) or `POST /api/wallet/connect` / `POST /api/auth/link-wallet` (link) consumes the nonce atomically (single use, expiry, purpose, optional IP binding) and calls `verifyWalletSignature(address, message, signatureBase58)`, which uses `getPublicKeyFromAddress` + `verifySignature` (ed25519, WebCrypto). Malformed input returns `false`, never throws.
4. Linking a new wallet notifies the player, writes an audit log, records a `WALLET_CHANGE` risk signal and starts the **48 h withdrawal lock** (`withdrawal.walletChangeLockHours`). Withdrawals may only go to a verified wallet linked to the account.

## Treasury key

- Loaded **only** from `TREASURY_SECRET` (64‑byte JSON array as written by `solana-keygen` / `scripts/devnet-setup.ts`, or base58) by `loadTreasurySigner()`, which throws unless `SERVICE_ROLE=blockchain` (set by the blockchain-service npm scripts). API and game server only know `TREASURY_PUBLIC_KEY`.
- The signer uses a non-extractable WebCrypto key; the byte buffer is zeroed after import; the secret never appears in logs or error messages (the service logger additionally redacts `secret|private|token|seed|keypair` keys). If `TREASURY_PUBLIC_KEY` is set, the loaded key must match it.
- Devnet: `scripts/devnet-setup.ts` generates the key with `generateKeyPairSigner(true)`, writes `.secrets/treasury-devnet.json` (mode 600, gitignored) and upserts `TREASURY_PUBLIC_KEY` / `TREASURY_SECRET` into the gitignored `.env`.
- Production path: KMS/HSM-backed signer (see SECURITY.md / DEPLOYMENT.md). The `TransactionSigner` abstraction in `buildAndSendPayout` accepts any kit signer, so a KMS signer drops in without touching the pipeline.

## Deposit flow (devnet SOL)

```
client                         API                                   chain
  │ POST /api/wallet/deposit/prepare {amount, purpose GEMS|BALANCE, idempotencyKey}
  │──────────────────────────────► Deposit(PREPARED, memo=nebula:dep:<random>, recipient=TREASURY_PUBLIC_KEY, 30 min)
  │◄────────────── {depositId, recipient, amount, memo}
  │ wallet: SystemProgram.transfer(amount → treasury) + Memo(memo) ─────────────────────────► tx
  │ POST /api/wallet/deposit/verify {depositId, signature}
  │──────────────────────────────► verifyDepositTransaction(rpc, {...}) ──getSignatureStatuses/getTransaction──►
  │                                  credit ledger (SERIALIZABLE, idempotent)
  │◄────────────── {deposit CREDITED, balances, gems}
```

`verifyDepositTransaction(rpc, { signature, expectedRecipient, expectedAmount, mint, memo, expectedSender, minConfirmations })` checks, in order: signature format → cluster (genesis hash) → status exists & no error & commitment ≥ `confirmed`/`finalized` → `getTransaction` (`jsonParsed`, `maxSupportedTransactionVersion: 0`) → memo present (SPL Memo v1/v2 parsed, or p-memo raw data) → expected sender is a **signer** → SOL: sum of parsed system transfers sender→treasury (top-level + inner), cross-checked with the treasury's pre/post balance delta; SPL: token-balance deltas of owner=treasury / owner=sender for the mint → exact amount. Result is `{ ok: true, … }` or a typed rejection: `INVALID_SIGNATURE, WRONG_NETWORK, NOT_FOUND, NOT_CONFIRMED, TX_FAILED, MEMO_MISMATCH, WRONG_RECIPIENT, WRONG_MINT, AMOUNT_MISMATCH, WRONG_SENDER, MALFORMED, RPC_ERROR` with a `retryable` flag (`NOT_FOUND`/`NOT_CONFIRMED`/`RPC_ERROR` → HTTP 202, client retries).

Crediting (`creditDeposit`): `Deposit.signature` is `@unique` (one signature can never credit twice, across users) and ledger postings use `deposit:<id>` idempotency keys.
- `BALANCE`: `EXTERNAL_CHAIN:SOL → USER_WALLET:<uid>:SOL`
- `GEMS`: `EXTERNAL_CHAIN:SOL → PREMIUM_REVENUE:SOL` (revenue; active `Season.revenue += amount`) and `GAME_ISSUANCE:GEMS → USER_WALLET:<uid>:GEMS` at the gem-pack rate from `shop.json` / `ShopProduct` (exact pack price, or the base pack rate).
- Suspicious rejections (wrong recipient/sender/amount/memo, failed tx, signature reuse) record a `FAKE_TRANSACTION` risk signal.

## Withdrawal flow

```
POST /api/wallet/withdraw {amount, address, idempotencyKey}     (authenticate + very strict rate limit)
  └─ createWithdrawal (SERIALIZABLE):
       checks: min/max, daily limit, cooldown, balance, account age, wallet-change lock,
               destination = linked wallet, risk (CRITICAL → reject, ≥MEDIUM → review),
               velocity, amount ≥ reviewThreshold, WITHDRAWAL_REVIEW breaker
       ledger hold: USER_WALLET:NEBX → WITHDRAWAL_RESERVE:NEBX (final + networkFee)
                    USER_WALLET:NEBX → FEE_REVENUE:NEBX (serviceFee)
       rows: Withdrawal(PENDING | PENDING_REVIEW) + ChainTransaction(CREATED)
  └─ POST blockchain-service /internal/withdrawals/:id/enqueue  (non-fatal; the sweeper re-enqueues from Postgres)
```

Quote (`GET /api/wallet/withdraw/quote?amount=`): `serviceFee = ceil(amount × withdrawalServicePercent) + withdrawalFlat`, `networkFee = estimatedNetworkFee`, `final = amount − serviceFee − networkFee` (all bigint lamports).

### Transaction queue states (`apps/blockchain-service/src/processor.ts`)

| Withdrawal.status | chainState | Meaning |
|---|---|---|
| PENDING | CREATED | Requested; funds held |
| PENDING_REVIEW | CREATED | Manual review (risk, size, breaker) — admin approves (→ PENDING) or rejects (→ CANCELLED + refund) |
| PROCESSING | QUEUED | Passed the pre-payout gate (risk / breaker / account re-checked) |
| PROCESSING | SUBMITTED | Signed; **signature + lastValidBlockHeight persisted before broadcast** |
| PROCESSING | CONFIRMING | Broadcast, waiting for `confirmed` |
| COMPLETED | CONFIRMED | Confirmed on chain ⇒ ledger settle `WITHDRAWAL_RESERVE → EXTERNAL_CHAIN` (final) + `→ FEE_REVENUE` (network fee) |
| PROCESSING | RETRYING | Previous attempt provably failed/expired; exponential backoff (`WITHDRAWAL_BACKOFF_MS × 2^(attempt−1)`) |
| FAILED | FAILED | `maxAttempts` exhausted ⇒ compensating entries return principal **and** fees to the player |

Double-payment protection:
- Before (re)submitting, the treasury's recent signatures are searched for the withdrawal memo `nebula:wd:<id>` (`findPayoutByMemo`, SPL Memo v2 so RPC indexes it). If found, that signature is adopted.
- A tx is rebuilt only when the old one **cannot land any more**: blockhash expired (`getBlockHeight > lastValidBlockHeight`) and signature unknown, or it landed with an error. A broadcast error after signing leaves the row SUBMITTED; the next step re-checks the signature instead of resending.
- Attempts are claimed with an optimistic `updateMany(where: {chainState, attempts, signature: null})`, so two workers can never submit the same attempt.
- COMPLETED is written only in `finalize()`, reachable only from a `CONFIRMED` status returned by the chain.

Durability: BullMQ (`nebula-withdrawals`, jobId `wd-<withdrawalId>` dedupes) is only a scheduler. Postgres is the source of truth: on boot and every `CHAIN_SWEEP_INTERVAL_MS` (60 s) every withdrawal in `PENDING` or `PROCESSING/{CREATED,QUEUED,SUBMITTED,CONFIRMING,RETRYING}` is re-enqueued, so losing Redis never loses a payout. Worker steps never fail a job: unexpected errors reschedule with backoff (`moveToDelayed` + `DelayedError`).

### Internal HTTP (blockchain-service, `BLOCKCHAIN_SERVICE_PORT`, default host 127.0.0.1)

| Route | Auth | Purpose |
|---|---|---|
| `POST /internal/withdrawals/:id/enqueue` | `Authorization: Bearer $INTERNAL_SERVICE_TOKEN` (constant-time compare) | Enqueue a withdrawal |
| `GET /health` | none | Liveness |
| `GET /ready` | none | DB, Redis, RPC latency/slot, queue depth, treasury balance (503 if not ready) |
| `GET /metrics` | bearer | Prometheus text: submits, retries, completions, failures, reviews, queue depth, RPC latency, treasury coverage, reward rate |

The service also runs `EconomyController.run()` + `expireRewards()` every `ECONOMY_CONTROLLER_INTERVAL_MS` (5 min).

## Ledger accounts

| Account | Asset(s) | Meaning |
|---|---|---|
| `EXTERNAL_CHAIN` | SOL, NEBX | Mirror of on-chain flows (may be negative): funding & deposits in, payouts out |
| `TREASURY` | NEBX | Unallocated treasury reserve (backs rewards) |
| `PLAYER_REWARD_POOL` | NEBX | Funded reward pool; claims move from here to players. Outstanding liabilities ≤ this balance |
| `OPERATING_RESERVE`, `EMERGENCY_RESERVE`, `REWARD_RESERVE` | NEBX | Reserve buckets (bootstrap split by ratio) |
| `WITHDRAWAL_RESERVE` | NEBX | Held player funds for in-flight withdrawals |
| `FEE_REVENUE` | NEBX | Withdrawal service + network fees |
| `PREMIUM_REVENUE` | SOL, GEMS | Gem sales (SOL) and premium spend (gems) |
| `MARKETPLACE_REVENUE`, `AUCTION_REVENUE` | CREDITS | Market fees |
| `GAME_ISSUANCE` / `GAME_SINK` | CREDITS, GEMS | Soft-currency mint / burn |
| `USER_WALLET:<uid>` | all | Player balances (never negative) |

Treasury bootstrap (`scripts/economy-bootstrap.ts` → `bootstrapTreasury`): reads the real on-chain balance at a slot, computes what the ledger already accounts for (−`EXTERNAL_CHAIN:NEBX` − `EXTERNAL_CHAIN:SOL`), keeps a fee buffer and books only the positive difference as `ADMIN_ADJUSTMENT EXTERNAL_CHAIN → TREASURY` (idempotent per slot), then splits by `rewardBudgetRatio` / `operatingReserveRatio` / `emergencyReserveRatio` into the pool/reserves and adds the pool share to the active season's `rewardBudget`. If the chain holds less than the ledger expects, it refuses to fund and warns. **The reward pool therefore can never exceed real treasury funds.** `GET /api/admin/treasury` shows the live reconciliation delta.

## NFTs (feature-flagged)

`packages/blockchain/src/nft.ts`: Metaplex JSON builder (name ≤ 32 B, symbol, description, image, attributes: family, item, rarity, ship class, faction, edition) and `buildMintNftInstructions` using `@metaplex-foundation/mpl-token-metadata-kit` `createNft` → `[createV1, mintV1]` (works with kit 8). Families: `LEGENDARY_SHIP`, `LIMITED_SKIN`, `FOUNDER_COSMETIC` — only definitions with `nftEligible: true`, never power items. Disabled unless `NFT_MINTING_ENABLED=true`; devnet script `scripts/mint-devnet-nft.ts`.

## Why the Anchor program is not deployed in the MVP

`programs/nebula_settlement` (Anchor 1.2, `cargo check` clean) contains real instruction handlers with account validation and events:
- **Admin:** `initialize` (only the program's upgrade authority, checked via `ProgramData`), `update_config` (rotate the reward signer and change the fee / per-claim cap / per-epoch emission cap), two-step authority transfer (`propose_authority` → `accept_authority`), and `set_paused`.
- **Rewards:** `fund_vault` and `verify_reward`. `verify_reward` needs a reward-signer co-signature and creates a per-reward receipt PDA, so a reward can't be claimed twice. It also enforces the per-claim cap, a **per-epoch emission cap** and a vault rent floor.
- **SOL escrow:** `open_escrow`, `release_escrow`, `refund_escrow`. Opening is rejected while paused.
- **Tournaments:**
  - `create_tournament`.
  - `join_tournament` (rejected while paused).
  - `settle_tournament`: pays out via remaining accounts; the fee is capped at `fee_bps ≤ 10%`.
  - `cancel_tournament`.
  - `refund_entry`: refunds fee + rent when cancelled, and rent only after settlement.

The Anchor provider wallet is a dedicated deployer key (`.secrets/program-deployer-devnet.json`), never the treasury key. `anchor test` runs `cargo test`, which runs the Rust unit tests for the config and emission checks, fee cap and refund rules. On-chain (bankrun) tests are not written yet.

It is intentionally **not deployed** for the MVP because:
1. The economy's safety controls (eligibility, caps, bot/risk review, circuit breakers, treasury health throttling) live off-chain and change often; moving settlement on-chain now would duplicate them or bypass them.
2. Treasury transfers through one audited service give a single choke point with idempotency, manual review and compensating ledger entries; an on-chain vault would need an audit, upgrade-authority governance and key management first.
3. Deploying requires the Solana BPF toolchain and program-deploy SOL; the MVP only needs system transfers.
The path forward: deploy to devnet behind a feature flag, have blockchain-service call `verify_reward` / `settle_tournament` instead of plain transfers, keep the off-chain policy as the signer's gate.

## Scripts

| Command | What it does |
|---|---|
| `npx tsx --env-file=.env scripts/devnet-setup.ts` | Generate/reuse treasury + test player keypairs in `.secrets/`, update `.env`, request faucet airdrops with retries |
| `npx tsx --env-file=.env scripts/economy-bootstrap.ts` | Reconcile ledger funding with the real treasury balance |
| `SERVICE_ROLE=blockchain npx tsx --env-file=.env scripts/devnet-e2e.ts [--mock]` | Real end-to-end: fund player, deposit+verify, bootstrap, reward, withdrawal, payout via the processor. `--mock` runs the identical code against the in-process mock RPC and an isolated DB schema |
| `NFT_MINTING_ENABLED=true SERVICE_ROLE=blockchain npx tsx --env-file=.env scripts/mint-devnet-nft.ts --owner <addr>` | Mint one devnet NFT |
| `pnpm --filter @nebula/blockchain-service dev` | Run the service |

### Devnet status (2026-09-28)

- Treasury: `Hd6r6rGc8CNXRzYV8DwsU6vqh8aPM3711r2UC8Z3vbhe`, test player: `FHVpwWukg972VAU7pvk5VuWKVQzxkt6mWGX9mUdLZtDY`.
- The public devnet faucet (`requestAirdrop`) answered **429 "airdrop limit reached / faucet dry"** for every attempt from this environment (1 SOL, 0.5 SOL, 0.1 SOL; retried over the session), and other public devnet RPCs require API keys. The treasury is therefore unfunded; the real-devnet e2e stops at the funding check. Fund it (e.g. https://faucet.solana.com) and run `scripts/devnet-e2e.ts`.
- The identical code path runs green against the local mock RPC (`--mock`, and `apps/blockchain-service/src/e2e-mock.test.ts`): a real signed transfer+memo is decoded by the mock chain, verified by `verifyDepositTransaction`, credited, and a payout is signed, persisted, broadcast, confirmed and settled by the processor.

## Environment variables

`SOLANA_NETWORK`, `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `SOLANA_COMMITMENT`, `TREASURY_PUBLIC_KEY`, `TREASURY_SECRET` (blockchain-service only), `SERVICE_ROLE=blockchain` (blockchain-service only), `REWARD_MINT`, `REWARD_MINT_DECIMALS`, `BLOCKCHAIN_SERVICE_PORT`, `BLOCKCHAIN_SERVICE_HOST`, `BLOCKCHAIN_SERVICE_URL`, `INTERNAL_SERVICE_TOKEN`, `REDIS_URL`, `DATABASE_URL`, `WITHDRAWAL_MAX_ATTEMPTS` (5), `WITHDRAWAL_BACKOFF_MS` (15000), `WITHDRAWAL_CONFIRM_POLL_MS` (4000), `WITHDRAWAL_CONCURRENCY` (2), `ECONOMY_CONTROLLER_INTERVAL_MS` (300000), `CHAIN_SWEEP_INTERVAL_MS` (60000), `NFT_MINTING_ENABLED`.
