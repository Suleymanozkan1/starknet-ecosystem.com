# Economy

All balance numbers live in `packages/config/data/economy.json` (defaults) and can be overridden at runtime through `EconomyConfig` rows (dot-path keys such as `caps.daily`), edited only by admins via `POST /api/admin/economy/config` (validated + audited with old/new value). `loadEconomyConfig(db)` returns the merged config. Code never hardcodes prices or rates.

Package: `@nebula/economy` (`packages/economy/src`).

| Module | Responsibility |
|---|---|
| `config.ts` | defaults ⊕ DB overrides, validation (allocation ≤ 100 %, reserve ratios ≤ 100 %, ordering of caps/thresholds), audited updates |
| `rewardBudget.ts` | season budget = revenue × `rewardBudgetRatio` + recorded pool funding (never unlimited), allocation buckets, per-bucket remaining |
| `treasury.ts` | treasury health = available reserve ÷ projected 30-day liabilities → HEALTHY / WATCH / WARNING / CRITICAL + multiplier |
| `emission.ts` | rate = base × activity × season × treasury-health × throttle, hard-capped at `maxRewardRate` |
| `eligibility.ts`, `caps.ts` | account age, risk, playtime, matches, eligible modes, claim cooldown; daily / weekly / season caps |
| `rewards.ts` | `grantCryptoReward`, `claimReward(s)`, `expireRewards`, `reviewReward` |
| `risk.ts` | `recordRiskSignal`, bot-farming heuristics, account clustering |
| `controller.ts` | `EconomyController`: supply/flow metrics, inflation, snapshots, anomalies, circuit breakers, throttle |
| `fees.ts` | marketplace / auction / trade / withdrawal fee math (bigint, rounded up) |
| `withdrawals.ts`, `deposits.ts`, `bootstrap.ts` | ledger-side withdrawal/deposit logic and treasury funding |
| `simulation.ts` | deterministic simulation using the production policy functions |

## Currencies

| Currency | Kind | Decimals | Earned by | Spent on |
|---|---|---|---|---|
| Credits (CR) | soft, minted by gameplay (`GAME_ISSUANCE`) | 0 | NPC kills, quests, loot, market sales | ammo, repairs, travel, upgrades, market/auction fees (`GAME_SINK`) |
| Gems (GEM) | premium, no cash value, not withdrawable | 0 | verified devnet SOL deposit (gem packs) | cosmetics, convenience, battle pass premium |
| NEBX | reward asset (fixed supply), settled on devnet as SOL (or `REWARD_MINT`) | 9 | **Battle Rewards, Season Rewards, Tournament Rewards** from the funded pool | withdrawal to the player's verified wallet |

### Tokenomics (NEBX)

- **Fixed max supply: 1,000,000,000 NEBX.** Mint authority is disabled after genesis (`mintAuthorityDisabledAfterGenesis: true`). There is **no infinite mint**: rewards are paid from a pool funded with real, recorded treasury funds — they are never created on demand.

| Allocation | Share |
|---|---:|
| Rewards (player reward pools, released per season) | 35 % |
| Treasury | 20 % |
| Liquidity | 10 % |
| Operations | 10 % |
| Team (vested) | 10 % |
| Ecosystem | 10 % |
| Marketing | 5 % |

On devnet the reward asset is native devnet SOL (no value). Allocation sums to 100 % and is validated.

### Fees (transparent, shown in `GET /api/economy/fees`)

| Fee | Value | Destination |
|---|---:|---|
| Marketplace sale | 7.5 % (rounded up) | `MARKETPLACE_REVENUE` (credit sink) |
| Auction listing / sale / cancellation | 1 % / 5 % / 2 % | `AUCTION_REVENUE` |
| Player trade tax | 2 % | sink |
| Withdrawal service fee | 2 % + 0.001 NEBX | `FEE_REVENUE` |
| Withdrawal network fee | 5,000 lamports (Solana base fee) | `FEE_REVENUE` (treasury pays the real fee) |

Withdrawal quote: `{ requested, serviceFee, networkFee, final }` with `final = requested − serviceFee − networkFee`.

## Crypto rewards

`grantCryptoReward(db, { userId, source, sourceRef, weight, reason, seasonId?, matchId?, mode? })` → `{ status, amount, reasons, rewardId? }`

Order of checks:
1. **DUPLICATE** — `Reward` is unique by `(userId, source, sourceRef)`; concurrent duplicates collapse to one row (the loser gets DUPLICATE and a `DUPLICATE_REWARD` risk signal).
2. **PAUSED** — `REWARD_PAUSE` circuit breaker active.
3. **INELIGIBLE** — account age ≥ 72 h, playtime ≥ 120 min, ≥ 10 completed matches, not banned/restricted, eligible mode (RANKED, ARENA, RAID, LARGE_SCALE, CLAN_WAR, GATE).
4. Emission rate from treasury health (hard cap) → `amount = weight × rewardUnitLamports × rate / baseRate`.
5. Clipped by per-player caps (0.05 / 0.25 / 2 NEBX per day / week / season), the season bucket's remaining budget, the daily emission cap (`budget × rate`) and **pool coverage** (outstanding liability + amount ≤ `PLAYER_REWARD_POOL`). Zero ⇒ **CAPPED**.
6. `Reward` + `RewardLiability(OUTSTANDING)` created in one SERIALIZABLE transaction. HIGH/CRITICAL risk ⇒ **PENDING_REVIEW** (a human approves or rejects; never an automatic ban).

`claimReward(db, userId, rewardId)`: `PLAYER_REWARD_POOL:NEBX → USER_WALLET:<uid>:NEBX` (idempotency key `reward-claim:<rewardId>`), `RewardClaim` (unique per reward), reward `CLAIMED`, liability `SETTLED`. Re-claiming returns the original claim. Claim cooldown 60 min per claim action (`POST /api/rewards/claim` accepts one id, a list, or `all`). Unclaimed rewards expire after 30 days (`expireRewards`, run by blockchain-service).

Reward budget: `seasonRewardBudget = seasonRevenue × 20 % + funded pool share`. Allocation buckets: Leaderboard 30 %, Tournament 25 %, World events 15 %, Faction wars 10 %, Raids 10 %, Achievements 5 %, Special campaigns 5 % (sum validated ≤ 100 %; sources map to buckets, e.g. PVP/RANKED → Leaderboard, WORLD_BOSS/EVENT/GATE → World events).

## Treasury health & emission

`coverage = availableReserve / (outstandingLiability + 30 × avgDailyEmission7d)` where `availableReserve = PLAYER_REWARD_POOL + REWARD_RESERVE + TREASURY`.

| Health | Coverage | Emission multiplier |
|---|---|---:|
| HEALTHY | ≥ 2.0 | 1.0 |
| WATCH | ≥ 1.5 | 0.8 |
| WARNING | ≥ 1.0 (or reserve < `minTreasuryReserve`) | 0.5 |
| CRITICAL | < 1.0 | 0.1 |

`rate = baseRate (1 %, admin override via /reward-rate) × activity (DAU trend, ≤ 1.5) × seasonMultiplier × healthMultiplier × controllerThrottle`, **hard-capped at 3 %** of the season budget per day.

## Economy controller & circuit breakers

`EconomyController.run()` (every 5 min in blockchain-service, or `POST /api/admin/economy/controller/run`):
- measures issued / burned / spent / stored / withdrawn / deposited per asset from the ledger; daily / weekly / 30-day inflation of minted credits; writes `EconomySnapshot` rows (NEBX, CREDITS, SOL);
- detects anomalies and toggles `CircuitBreaker` rows with audit logs:

| Anomaly | Trigger (config) | Breaker | Throttle |
|---|---|---|---|
| Reserve too low | coverage < `reserveCoverageMin` | REWARD_PAUSE, EVENT_PAUSE | yes |
| Liability too high | outstanding > 80 % of pool | REWARD_PAUSE | yes |
| Withdrawal spike | 24 h > 3 × 7-day avg (floor: daily limit) | WITHDRAWAL_REVIEW | – |
| Deposit spike | 24 h > 5 × avg | WITHDRAWAL_REVIEW | – |
| Bot spike | > 15 % of rewarded users HIGH/CRITICAL risk | REWARD_PAUSE | yes |
| Inflation spike | credits > 5 %/day | EVENT_PAUSE | yes (reward ×0.8) |
| Market manipulation | fee volume > 4 × avg and > 50 % from one seller | MARKET_PAUSE | – |
| Duplicate claims | > 5 duplicate-reward signals / hour | REWARD_PAUSE | – |
| Abnormal outflow | claims + withdrawals > 4 × avg | WITHDRAWAL_REVIEW | yes |

Breakers set by the controller are released automatically when the condition clears; breakers set by an admin stay until an admin releases them. `WITHDRAWAL_REVIEW` routes every new payout to manual review; `MARKET_PAUSE` blocks marketplace/auction mutations (API `assertMarketOpen`).

## Risk & anti-bot

`recordRiskSignal(db, { userId, type, score, details, source })` stores a `RiskSignal`, recomputes the 30-day score (capped at 100) and level (MEDIUM ≥ 25, HIGH ≥ 50, CRITICAL ≥ 80), audits level changes. Heuristics (`detectBotFarming`): > 60 rewards / 24 h, metronome-regular reward intervals (CV < 0.08), account clusters (≥ 3 accounts sharing device fingerprint, IP, or wallet relationships through wallets, deposits and withdrawal destinations). Consequences are **review-only**: rewards → PENDING_REVIEW, withdrawals → PENDING_REVIEW (CRITICAL withdrawals rejected pending review). Bans are a human decision in the admin panel.

## Player-facing terminology

Use: **Battle Rewards, Season Rewards, Tournament Rewards, Marketplace Earnings**. Never use: APY, interest, yield, guaranteed return, passive income, investment, staking returns. The rules text shown in `GET /api/economy/rewards` is generated from live config and states that rewards are earned through gameplay only, carry no promise of value, are finite, and that devnet tokens have no monetary value.

## API

| Route | Auth | Notes |
|---|---|---|
| `GET /api/economy/status` | public | treasury health, pool remaining, season budget, current rate, active breakers, fees |
| `GET /api/economy/fees` | public | `FeesResponse` |
| `GET /api/economy/rewards` | user | rewards, claimable, caps + usage, eligibility reasons, rules, next claim time |
| `GET /api/economy/transactions?limit&cursor&asset` | user | own ledger entries (`LedgerEntryDto`) |
| `POST /api/rewards/claim {rewardId \| rewardIds \| all}` | user, strict limit | idempotent claims |
| `POST /api/wallet/connect` | user | link wallet (nonce + signature, purpose LINK_WALLET), starts 48 h withdrawal lock |
| `GET /api/wallet` | user | `WalletResponse` |
| `POST /api/wallet/deposit/prepare` / `verify` | user, strict limit | see BLOCKCHAIN.md |
| `GET /api/wallet/withdraw/quote?amount=` | user | quote + limits |
| `GET /api/wallet/withdraw/check?amount&address` | user | dry-run of all withdrawal checks |
| `POST /api/wallet/withdraw` | user, withdrawal limiter | creates hold + queue record |
| `GET /api/wallet/withdrawals/:id` | user | status incl. chain state + explorer URL |
| `GET /api/admin/economy` | SUPER_ADMIN / ECONOMY_MANAGER / ADMIN | `AdminEconomyResponse` incl. 30-day series |
| `POST /api/admin/economy/config`, `/reward-rate`, `/circuit-breaker`, `/controller/run` | SUPER_ADMIN / ECONOMY_MANAGER | audited |
| `GET /api/admin/withdrawals`, `POST /api/admin/withdrawals/:id/approve` \| `reject` | admin / economy manager | review queue |
| `GET /api/admin/economy/rewards/review`, `POST /api/admin/economy/rewards/:id/review` | admin / economy manager | reward review |
| `GET /api/admin/economy/risk` | admin | risk queue |
| `GET /api/admin/treasury` | admin | on-chain balance vs ledger reconciliation, integrity, system accounts |

## Simulation

`pnpm economy:simulate` runs 11 scenarios × 6 user counts (1k–1M) × 4 horizons (30–365 days) plus a combined worst case through the production policy functions and writes `docs/ECONOMY_SIMULATION.md` and `docs/ECONOMY_HEALTH_REPORT.md`. It exits non-zero if any run lets outstanding liability exceed the funded pool.
