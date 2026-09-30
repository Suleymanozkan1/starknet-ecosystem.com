# Blockchain (Solana devnet)

NEBULA FRONTIER uses Solana **devnet only**. `SOLANA_NETWORK` accepts `devnet` / `testnet` / `localnet`; anything that looks like mainnet is refused at startup (`packages/blockchain/src/rpc.ts`), and the RPC's genesis hash is checked against the devnet genesis before any deposit is accepted or payout sent.

| Piece | Location | Role |
|---|---|---|
| `@nebula/blockchain` | `packages/blockchain` | `@solana/kit` 8.4 helpers: RPC, SIWS login message + signature verification, deposit verification, payout build/send/confirm, memo idempotency lookup, NFT metadata/mint, mock RPC |
| blockchain-service | `apps/blockchain-service` | **The only process that holds the treasury key.** Withdrawal queue (BullMQ + Postgres), confirmations, retries, economy controller, reward expiry, internal HTTP |
| API wallet routes | `apps/api/src/routes/wallet.ts` | Wallet link, deposits, withdrawal requests (no keys) |
| Settlement program | `programs/nebula_settlement` | Anchor 1.2 program (reward verification / escrow / tournament settlement). Built for SBF, tested on-chain in LiteSVM, **deployed + initialized on devnet**. Withdrawals pay through `verify_reward` when `ONCHAIN_SETTLEMENT_ENABLED=true` (see [On-chain settlement](#on-chain-settlement-feature-flag)) |

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

- Loaded **only** from `TREASURY_SECRET` or, when unset, the file named by `TREASURY_SECRET_FILE` (64‑byte JSON array as written by `solana-keygen` / `scripts/devnet-setup.ts`, or base58) by `loadTreasurySigner()`, which throws unless `SERVICE_ROLE=blockchain` (set by the blockchain-service npm scripts). API and game server only know `TREASURY_PUBLIC_KEY`.
- The signer uses a non-extractable WebCrypto key; the byte buffer is zeroed after import; the secret never appears in logs or error messages (the service logger additionally redacts `secret|private|token|seed|keypair` keys). If `TREASURY_PUBLIC_KEY` is set, the loaded key must match it.
- Devnet: `scripts/devnet-setup.ts` generates the key with `generateKeyPairSigner(true)`, writes `.secrets/treasury-devnet.json` (mode 600, gitignored) and upserts `TREASURY_PUBLIC_KEY` / `TREASURY_SECRET_FILE` (the path, never the secret) into the gitignored shared `.env`, removing any legacy `TREASURY_SECRET` line (the API and game server load that `.env` too).
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

## The Anchor program

`programs/nebula_settlement` (Anchor 1.2, builds for SBF, see [Build and on-chain tests](#build-and-on-chain-tests)) contains real instruction handlers with account validation and events:
- **Admin:** `initialize` (only the program's upgrade authority, checked via `ProgramData`), `update_config` (rotate the reward signer and change the fee / per-claim cap / per-epoch emission cap), two-step authority transfer (`propose_authority` → `accept_authority`), and `set_paused`.
- **Rewards:** `fund_vault` and `verify_reward`. `verify_reward` needs a reward-signer co-signature and creates a per-reward receipt PDA, so a reward can't be claimed twice. It also enforces the per-claim cap, a **per-epoch emission cap** and a vault rent floor.
- **SOL escrow:** `open_escrow`, `release_escrow`, `refund_escrow`. Opening is rejected while paused.
- **Tournaments:**
  - `create_tournament`.
  - `join_tournament` (rejected while paused).
  - `settle_tournament`: pays out via remaining accounts; the fee is capped at `fee_bps ≤ 10%`.
  - `cancel_tournament`.
  - `refund_entry`: refunds fee + rent when cancelled, and rent only after settlement.

**Hardening steps** (the devnet deployment uses the deployer as authority and the treasury as reward signer; do these before anything beyond devnet):
1. Create a dedicated deployer / upgrade-authority keypair at `.secrets/program-deployer-devnet.json`. It must never be the treasury key. Run `anchor deploy`, then call `initialize`, signed by that upgrade authority. `initialize` rejects any other signer.
2. Create a **separate admin key**, ideally a multisig, and hand config authority to it with `propose_authority(<admin>)`, signed by the deployer, then `accept_authority`, signed by the admin. The deployer then keeps only upgrade rights. Consider moving those to the multisig as well, or making the program immutable.
3. Set the reward signer with `update_config`. The reward signer is the game-reward co-signing key, distinct from both the treasury and the admin. Also set the per-claim and per-epoch emission caps.

The Anchor provider wallet is a dedicated deployer key (`.secrets/program-deployer-devnet.json`), never the treasury key. The `[scripts] test` entry in `Anchor.toml` runs `cargo test -p nebula_settlement`: the Rust unit tests plus the LiteSVM on-chain tests described below.

### Build and on-chain tests

**Toolchain** (verified 2026-09-30 in the dev container, Linux x86_64):

| Tool | Version | How it was installed |
|---|---|---|
| Rust (host) | rustc / cargo 1.94.1 | preinstalled (rustup) |
| Solana / Agave CLI | `solana-cli 4.3.0` (Agave, src 44b42d45) | `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`, then `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"` |
| SBF toolchain | `cargo-build-sbf 4.4.0`, platform-tools v1.57 | bundled with the Agave install (platform tools are downloaded on the first build) |
| Anchor CLI | `anchor-cli 1.2.0` (matches `anchor-lang = "1.2.0"`) | prebuilt binary: `curl -sSfL -o ~/.local/bin/anchor https://github.com/solana-foundation/anchor/releases/download/v1.2.0/anchor-1.2.0-x86_64-unknown-linux-gnu && chmod +x ~/.local/bin/anchor` (`avm` / `cargo install --git` also work but compile for a long time) |
| LiteSVM (dev-dependency) | `litesvm 0.16.0` (agave 4.2.x runtime) | Cargo. 0.17 needs rustc >= 1.97.1; see the comment in `nebula_settlement/Cargo.toml` |

**Build** (from `programs/`):

```bash
anchor build --ignore-keys   # → target/deploy/nebula_settlement.so, target/idl/nebula_settlement.json, target/types/nebula_settlement.ts
# or, without Anchor (no IDL): cd nebula_settlement && cargo build-sbf
```

`Anchor.toml` lists the workspace member explicitly (`[workspace] members = ["nebula_settlement"]`) because the crate lives in `programs/nebula_settlement`, not in Anchor's default `programs/*` under the Anchor.toml directory. Without that entry `anchor build` finds no program and does nothing. `--ignore-keys` is needed because the reserved devnet program ID (`Huqa9x…vPQH`, in `declare_id!`) has no keypair in this checkout; the build writes a throwaway `target/deploy/nebula_settlement-keypair.json` (git-ignored). Do **not** run `anchor keys sync`, because it would rewrite the program ID. Result: `nebula_settlement.so`, 340,232 bytes, `ELF 64-bit LSB, eBPF`; IDL is 36,857 bytes.

**Tests** (from `programs/`; build first, because the on-chain tests load the `.so`):

```bash
cargo test -p nebula_settlement
```

- 6 unit tests in `src/lib.rs` for the pure helpers.
- 7 on-chain tests in `nebula_settlement/tests/litesvm.rs`. These run the compiled SBF program in LiteSVM, an in-process SVM with no validator and no network. The program is loaded through the upgradeable loader and its `ProgramData` upgrade authority is set to a test key, so the real `initialize` gate is exercised. Every keypair is generated per test. The tests cover:
  - `initialize`: rejects any signer that is not the upgrade authority, rejects a fee above `MAX_FEE_BPS`, per-claim > per-epoch and a zero epoch; a second initialize fails; checks the stored fields.
  - Admin: `update_config`, `set_paused` and `propose_authority` reject non-authorities. The two-step transfer rejects accept with nothing pending and accept by the wrong key. After the transfer the old authority loses its rights.
  - `verify_reward`: rejects a wrong reward signer, a zero amount and an amount above the per-claim cap. A duplicate reward id fails (receipt PDA) with no second payout. The per-epoch emission cap is enforced and rolls over after the epoch (clock warp). Rejected while paused; the vault rent floor is kept.
  - Escrow: `release_escrow` is authority-only and pays the taker (rent goes back to the maker, account closed). `refund_escrow` needs expiry for the maker but the authority can refund any time; invalid amount and expiry are rejected; opening is rejected while paused.
  - Tournaments: `create_tournament` is authority-only (and needs `max_players >= 2`); one entry per player; `TournamentFull`. `settle_tournament` checks authority, `PayoutExceedsPot`, a house fee above `fee_bps` (`FeeTooHigh`) and winner/payout count mismatch. A settled tournament cannot be settled again. `refund_entry` is blocked while open, returns only rent after settlement, and fee + rent after `cancel_tournament`.

Result on 2026-09-30: `test result: ok. 6 passed` (unit) and `test result: ok. 7 passed` (`tests/litesvm.rs`, about 2 s).

**Local validator smoke test** (optional, 127.0.0.1 only, never devnet or mainnet). `solana-test-validator --reset --upgradeable-program DvgysAhNTnrBjGxo7qXd8QpvP1XNpJvkfXqjwzqTQohL target/deploy/nebula_settlement.so <local-authority-pubkey> --mint <local-authority-pubkey>` loads the program with a throwaway local upgrade authority, created with `solana-keygen new` in a temp directory and never committed. The `initialize` instruction was then sent with a small `@solana/kit` script that uses the IDL discriminator and a borsh-encoded argument layout. It succeeded (13,259 CU). The config PDA `Auhoeu2x…SFJJ` is owned by the program and stores the right authority, reward signer, `fee_bps` = 500 and the caps.

**Devnet deployment (2026-09-30):**

| | |
|---|---|
| Program id | `DvgysAhNTnrBjGxo7qXd8QpvP1XNpJvkfXqjwzqTQohL` |
| Upgrade authority | `6MoFW2YkhGmV3ugUm2i7MGbva3jd9TVPStcxt3zmTk8U` (dedicated deployer; keypair kept out of git in `.secrets/`) |
| Deploy tx | `3xC9je4QCXhC56vAoKa5ouU67bjBsimb6CMY5fLafXPB1tEESgwW3Qb2oCQR8XsYayV97F8hNMGc48TznTdTjZpj` |
| Initialize tx | `2Yx2kQDYKyAiz6j1Za5gEznH7f2StMRLjq7a4h4esXwWbwswTJwDjawTMW27hygDkBZN5DM7p6PQacSuRPUZyxd5` |
| Config PDA | `GG6QLkLk9VzTWdpjH7bTfNF71r9AjbM5n94okZMQ4UjH` (reward signer = treasury, fee 500 bps, 1 SOL/claim, 2 SOL/epoch, 1-day epoch) |

Deploy: `solana program deploy target/deploy/nebula_settlement.so --program-id <program-keypair> --keypair <deployer> --upgrade-authority <deployer> --url devnet --use-rpc` (`--use-rpc` avoids the public RPC's TPU write limits). Initialize: `node scripts/devnet-initialize.mjs <deployer-keypair> <reward-signer>` (refuses any non-devnet genesis). The program id changed from the originally reserved `Huqa9x…` because that keypair was never available; the old id was never deployed.

## On-chain settlement (feature flag)

Off by default. `ONCHAIN_SETTLEMENT_ENABLED=true` (+ optional `SETTLEMENT_PROGRAM_ID`, default the devnet id above) makes blockchain-service pay native-SOL withdrawals through `verify_reward` instead of a plain treasury transfer. The off-chain economy policy (eligibility, caps, risk review, breakers, treasury health) stays the gate: the program is only reached after `preflightGate`, and the treasury key signs as reward signer.

| Step | Where | What happens |
|---|---|---|
| Choose the path | `apps/blockchain-service/src/processor.ts` `choosePayoutMode` | `checkSettlementEligibility` reads the Config PDA + vault and mirrors the program's checks (not paused, reward signer = treasury, ≤ per-claim cap, epoch emission, vault above its rent floor). Any failure → **direct transfer fallback**, logged and counted (`withdrawal_settlement_fallback_total`). SPL-mint payouts always go direct |
| Pay | `packages/blockchain/src/settlement.ts` `sendSettlementPayout` | One tx: `verify_reward(reward_id = sha256("nf-reward:" + withdrawalId), amount)` + the same SPL memo (`nebula:wd:<id>`) as a direct payout. Treasury = fee payer + reward signer. Signature persisted **before** broadcast (same `onSigned` as direct payouts) |
| Confirm / recover | `findGenuinePayout` | The memo lookup finds either kind. A candidate that is not a treasury transfer is checked with `verifySettlementPayout`: success, treasury fee payer, memo, exact vault → player CPI transfer, and the on-chain receipt names the same player + amount |
| Never twice | receipt PDA `["reward", reward_id]` | A second `verify_reward` for the withdrawal fails on chain. While a receipt exists the processor never resubmits and never refunds (even after max attempts) — it holds and logs until the signature is found |
| Vault | `scripts/settlement-fund-vault.ts` | `fund_vault` from the treasury (devnet only, ≤ 2 SOL per call); `--status` prints vault liquidity, caps and epoch emission |

Metrics: `settlement_enabled`, `withdrawal_payouts_by_mode_total{mode="settlement"|"direct"}`, `withdrawal_settlement_fallback_total`, `withdrawal_receipt_without_signature_total`.

Tests: `packages/blockchain/src/settlement.test.ts` (PDAs of the deployed program, account layouts, single claim, wrong signer, spoof, eligibility), `apps/blockchain-service/src/processor.test.ts` "on-chain settlement" (vault payout + receipt + ledger, fallbacks for empty vault / cap / pause, flag off, adoption of a landed payout, dropped tx resubmitted only after expiry, receipt without signature → hold, no refund) and `e2e-mock.test.ts --settlement`. The mock RPC emulates `verify_reward` / `fund_vault` with the program's checks (`installMockSettlement`).

**Devnet run (2026-09-30):** `settlement:fund 100000000` → `fund_vault` tx `3mMrJVyrByHZh3ctFgYduiW2CcrtTespmbS4ht9PSUknBrc5yb4hmvc6fUvDZWhppmhQAiAh94D9HTt34Zo7QYeP`; then `devnet:e2e:settlement`: withdrawal `cmunudmdb0008eu7dgoql9yno` paid by the processor through `verify_reward`, tx `5XqKEeWg4dQAbSccJonLrqKpRz9DVpS2d1792oyfCCRgK5MD48j1BcL1CoCmct3dNnmiUFzR82xgn8iBEGDLmaCN` (logs: `Instruction: VerifyReward`, receipt account created (89 bytes), vault `AXvUbYig…BVfeX` → player 8,795,000 lamports, memo `nebula:wd:cmunudmdb0008eu7dgoql9yno`), status COMPLETED, receipt matches, a duplicate `verify_reward` for the same withdrawal was rejected, ledger integrity true.

Before enabling it beyond devnet: a professional program audit, upgrade-authority governance (multisig) and a reward signer separate from the treasury fee payer.

## Scripts

| Command | What it does |
|---|---|
| `npx tsx --env-file=.env scripts/devnet-setup.ts` | Generate/reuse treasury + test player keypairs in `.secrets/`, update `.env`, request faucet airdrops with retries |
| `npx tsx --env-file=.env scripts/economy-bootstrap.ts` | Reconcile ledger funding with the real treasury balance |
| `SERVICE_ROLE=blockchain npx tsx --env-file=.env scripts/devnet-e2e.ts [--mock]` | Real end-to-end: fund player, deposit+verify, bootstrap, reward, withdrawal, payout via the processor. `--mock` runs the identical code against the in-process mock RPC and an isolated DB schema |
| `pnpm --filter @nebula/blockchain-service devnet:e2e:settlement` | Same flow, payout through `verify_reward` (tops up the vault if needed); `--mock --settlement` against the emulated program |
| `pnpm --filter @nebula/blockchain-service settlement:fund <lamports>` / `-- --status` | Fund the settlement vault from the treasury / print vault + caps |
| `NFT_MINTING_ENABLED=true SERVICE_ROLE=blockchain npx tsx --env-file=.env scripts/mint-devnet-nft.ts --owner <addr>` | Mint one devnet NFT |
| `pnpm --filter @nebula/blockchain-service dev` | Run the service |

### Devnet status (2026-09-28)

- Treasury: `Hd6r6rGc8CNXRzYV8DwsU6vqh8aPM3711r2UC8Z3vbhe`, test player: `FHVpwWukg972VAU7pvk5VuWKVQzxkt6mWGX9mUdLZtDY`.
- The public devnet faucet (`requestAirdrop`) answered **429 "airdrop limit reached / faucet dry"** for every attempt from this environment (1 SOL, 0.5 SOL, 0.1 SOL; retried over the session), and other public devnet RPCs require API keys. The treasury is therefore unfunded; the real-devnet e2e stops at the funding check. Fund it (e.g. https://faucet.solana.com) and run `scripts/devnet-e2e.ts`.
- The identical code path runs green against the local mock RPC (`--mock`, and `apps/blockchain-service/src/e2e-mock.test.ts`): a real signed transfer+memo is decoded by the mock chain, verified by `verifyDepositTransaction`, credited, and a payout is signed, persisted, broadcast, confirmed and settled by the processor.

## Environment variables

`SOLANA_NETWORK`, `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `SOLANA_COMMITMENT`, `TREASURY_PUBLIC_KEY`, `TREASURY_SECRET` / `TREASURY_SECRET_FILE` (blockchain-service only), `SERVICE_ROLE=blockchain` (blockchain-service only), `REWARD_MINT`, `REWARD_MINT_DECIMALS`, `BLOCKCHAIN_SERVICE_PORT`, `BLOCKCHAIN_SERVICE_HOST`, `BLOCKCHAIN_SERVICE_URL`, `INTERNAL_SERVICE_TOKEN`, `REDIS_URL`, `DATABASE_URL`, `WITHDRAWAL_MAX_ATTEMPTS` (5), `WITHDRAWAL_BACKOFF_MS` (15000), `WITHDRAWAL_CONFIRM_POLL_MS` (4000), `WITHDRAWAL_CONCURRENCY` (2), `ECONOMY_CONTROLLER_INTERVAL_MS` (300000), `CHAIN_SWEEP_INTERVAL_MS` (60000), `NFT_MINTING_ENABLED`.
