# Engineering brief (shared by all workstreams)

NEBULA FRONTIER — original persistent 3D space MMO (DarkOrbit-like *depth*, fully original IP), browser + Android + iOS, Solana **devnet** reward economy.
Monorepo root: `/home/user/starknet-ecosystem.com/nebula-frontier` (pnpm workspace, Node 22, TypeScript 5.9 strict, ESM). Do NOT touch `/home/user/starknet-ecosystem.com/legacy`.

## Ground rules
- Real, working code only. No `// TODO connect`, no mock balances, no fake transactions, no pretend server state. Where credentials are needed, read env vars (see `.env.example` at root; local dev `.env` exists).
- Server-authoritative: clients send intents only; server decides HP, damage, XP, credits, loot, inventory, cooldowns, positions, rewards.
- Game balance is data-driven: `packages/config/data/*.json` loaded through `@nebula/config` (exports typed arrays + `*_BY_ID` maps, `validateGameData()`), and DB (`EconomyConfig`, `ShopProduct`). Never hardcode prices/balance numbers in code.
- Strict TS, avoid `any` (eslint errors on it). Erasable syntax: no TS `enum`, no constructor parameter properties. Use `@nebula/shared` const-object enums.
- Internal packages are consumed as TS source (`"main": "./src/index.ts"`). Node apps build with `tsup` (bundle `@nebula/*`, keep npm deps external) and run in dev with `tsx`. Import paths inside packages use `.js` suffix (e.g. `./ledger.js`).
- Tests: vitest (root `vitest.config.ts` picks up `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts`, `tests/**/*.test.ts`). Run a subset with `npx vitest run <path>`. Local PostgreSQL (`postgresql://nebula:nebula@localhost:5432/nebula`) and Redis (`redis://localhost:6379`) are running; DB tests should create their own users with unique ids and not assume empty tables.
- Adding deps: `pnpm add <pkg> --filter @nebula/<name>` from repo root. Other engineers work concurrently; if pnpm reports a lock/ENOENT error, wait 20s and retry. Never delete node_modules or the lockfile.
- Only edit files in the directories you own (listed in your task). If you need a change in someone else's area (esp. `packages/shared`, `prisma/schema.prisma`), make the minimal additive change only if essential, and mention it in your final report. Additive Prisma changes: edit schema then `npx prisma migrate dev --name <short_name>` (and `npx prisma generate`).
- Do not run `git commit`/`git push` — the lead integrates and commits.
- Reference repos (read-only) are in `tools/reference-repos/*`; condensed notes: `docs/research/REFERENCE_REPOS_NOTES.md`. Actually study the relevant ones and adapt their patterns.
- Before finishing: `npx tsc -p <your package>/tsconfig.json` for every package you touched, `npx eslint <your dirs>`, and your tests must pass. Report: files created, public APIs, env vars, anything left incomplete (be honest).

## Key contracts
- Shared types: `packages/shared/src/{enums,defs,protocol,api,util}.ts`.
- DB: `@nebula/database` → `getDb()`, `createDb()`, `withSerializableTx(db, fn)`, ledger `post(tx, {from,to,amount,type,reference,idempotencyKey,userId,metadata})`, `userWallet(userId, asset)`, `system(LedgerAccountType.X, asset)`, `getBalance`, `reverse`, `verifyLedgerIntegrity`. Posting moves amount FROM `from` TO `to`; user accounts cannot go negative; `GAME_ISSUANCE` and `EXTERNAL_CHAIN` may. Currencies: CREDITS, GEMS (integers), NEBX (crypto reward asset, lamports, 9 decimals; on devnet settled as SOL or SPL mint `REWARD_MINT` if set).
  - Credits earned in game: `GAME_ISSUANCE:CREDITS → USER_WALLET:<uid>:CREDITS`; credit sinks: `USER_WALLET → GAME_SINK`.
  - Gems purchased: after verified deposit or shop; premium spend: `USER_WALLET:GEMS → PREMIUM_REVENUE:GEMS`.
- Auth tokens: `@nebula/authentication` → `signAccessToken/verifyAccessToken` (JWT HS256, `JWT_SECRET`, aud "api", httpOnly cookie `nf_access`, refresh cookie `nf_refresh`), `signGameTicket/verifyGameTicket` (secret `GAME_TICKET_SECRET`, aud "game", 60s). Web obtains a ticket via `POST /api/game/ticket` → `{ ticket, mapId, gameServerUrl }` and passes it in `JoinOptions.ticket`.
- Colyseus room names: `RoomName` in `packages/shared/src/protocol.ts`; client→server message payloads `ClientMessages`; server→client `ServerEvents`; entity view `EntitySnapshot`.
- Economy services (`@nebula/economy`), used by api + game-server:
  - `grantCryptoReward(db, { userId, source: RewardSource, sourceRef: string, weight: number, reason: string, seasonId?: string, matchId?: string }) → Promise<{ status: "GRANTED"|"PENDING_REVIEW"|"CAPPED"|"INELIGIBLE"|"PAUSED"|"DUPLICATE"; amount: bigint; reasons: string[] }>` — applies eligibility, caps, risk, circuit breaker, treasury health & emission cap; creates `Reward` + `RewardLiability` (unique by userId+source+sourceRef).
  - `recordRiskSignal(db, { userId, type: CheatType | string, score: number, details, source })` — anti-cheat/bot scoring, updates `User.riskLevel`.
  - `loadEconomyConfig(db)` merged `economy.json` defaults with DB overrides (`EconomyConfig` rows).
- API base URL `http://localhost:8080` (env `API_PORT`), game server `ws://localhost:2567` (`GAME_PORT`), blockchain-service internal HTTP `http://localhost:8090` (`BLOCKCHAIN_SERVICE_PORT`), web dev `http://localhost:5173`, admin dev `http://localhost:5174`. Vite dev servers proxy `/api` → API.

## Game data ids (packages/config)
Exports: SHIPS, WEAPONS, MODULES, DRONES, PETS, NPC_FACTIONS, NPCS, LOOT_TABLES, ITEMS, ITEM_AFFIXES, BLUEPRINTS, MAPS, GALAXY, FACTIONS, QUESTS, ACHIEVEMENTS, EVENTS, SEASONS, BATTLE_PASSES, GATES, SHOP, ECONOMY, PROGRESSION; `*_BY_ID`, `SHOP_BY_SKU`, `itemIdForDef(defId)` (= `item_<defId>`), `itemIdForResource(RES)` (= `res_<lower>`), `GAME_DATA`, `validateGameData()`.
- Factions: `aurora` (home `map_aurora_prime`, starter `ship_aurora_lumen`), `vortex` (`map_vortex_haven`, `ship_vortex_gale`), `nova` (`map_nova_crown`, `ship_nova_ember`). Starter loadout: 2× `wpn_laser_mk1`, `wpn_missile_hornet`, `gen_shield_s1`, `gen_speed_s1`, one module, `drone_striker`.
- Maps: faction homes above, `map_helios_frontier`, `map_orion_belt` (mining), `map_vanta_rift` (pvp high risk), `map_astra_graveyard` (boss room, `boss_vanta_colossus`), `map_eclipse_arena` (pvp room), `map_gate_alpha`, `map_gate_omega` (gate), `map_raid_titan_vault` (raid). Portals `p_<from>_to_<to>`.
- Items: `item_<defId>`, resources `res_<id>`, ammo `item_ammo_*`, skins `skin_*` (geometry-changing: `skin_lumen_solar_crown`, `skin_gale_stormbreaker`, `skin_ember_phoenix`, `skin_riftbreaker_voidborn`, `skin_cradle_leviathan_bone`), cosmetics `cos_*`.
- Shop: product id `shop_<sku-without-sku_>`; gem packs `sku_gems_100|550|1200|2600` priced in SOL lamports; premium `sku_premium_vip_30`, `sku_premium_elite_30`; battle pass `sku_battlepass_s1_premium` (GEMS).
- Seasons `season_1` (active 2026-09-01..12-31), passes `pass_s1..3`; gates `gate_alpha_breach`, `gate_omega_singularity`.
