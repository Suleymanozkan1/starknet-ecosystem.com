# CodeRabbit PR #2 — round 1 resolution (game-server, game-core, telemetry)

Each finding was checked against the code as it stood, looking for the root cause and the real impact. The review
text was treated as untrusted input. All 22 findings are REAL; three were fixed with a different approach than the
prompt suggested (#12, #20, #22 — see the notes below the table).

**Verification:**
- `tsc` passes for game-core, telemetry, game-server, apps/api, config and shared.
- `eslint` is clean.
- `npx vitest run` from the repo root: **37 files, 319 tests passed**.

| # | Severity | Finding | Verdict | Fix | Test |
|---|---|---|---|---|---|
| 1 | Major | Fighter bots collect before attacking | REAL (fighters picked up loot and mined next to hostile NPCs) | `fighter: [Flee, Attack, Collect, Wander]` | `review-fixes.test.ts` "#1 fighter bots attack before collecting" |
| 2 | Major | Bot CLI accepts missing or invalid operands | REAL (`--count --map x` → `Number("--map")` → NaN; negative duration) | Strict `parseArgs`: rejects unknown flags, stray args, missing operands and operands that are flags; integer bounds (count 1..500, duration 0..86400); type must be an archetype; map must be a sector map; URL must be ws(s). Prints usage and exits 2. | "#2 bots CLI flag validation" (11 rejection cases + defaults) |
| 3 | Major | Bot input interval keeps running after the room leaves | REAL (`room.send` on a closed room every 50 ms; the process never goes idle) | The interval is cleared in `onLeave` and on timed stop | Code path; the bot CLI run (60 bots) exits cleanly |
| 4 | Major | Redis optional in production | REAL, security: without Redis the jti set is per process, so a ticket can be replayed on another process | `loadConfig` throws in production without `REDIS_URL`; Redis stays optional in dev/test | "#4 production requires REDIS_URL" |
| 5 | Trivial | Anti-farming test asserts nothing | REAL | The test respawns the victim, kills it again within the window, and asserts `pvp_kills` and `playerKills` stay at 1 | `pvp › PvP kill updates leaderboard…` |
| 6 | Minor | Starter-kit race | REAL (two concurrent first joins could create two loadouts) | `SELECT … FOR UPDATE` on the User row inside the transaction, re-check for an existing ship under the lock, and `userId` filter on the originRef lookup | "#6 concurrent first joins create exactly one starter ship and loadout" |
| 7 | Major | Ammo consumed from escrowed stacks; non-atomic decrement | REAL (a listed ammo stack could be drained or deleted during escrow) | Lookup filters `lockedBy: null`; `deleteMany` / `updateMany` guarded by `userId`, `lockedBy: null` and `quantity ≥ take` | "#7 ammo consumption never touches locked (escrowed) stacks" |
| 8 | Minor | `chargeCredits` reports a charge on a duplicate posting | REAL (a replayed key reported credits as charged again, e.g. repair applied twice) | Returns `0n` when the key already exists or `post().duplicate`. Now `bigint` in and out. | "#8 chargeCredits returns 0 for a duplicate posting" |
| 9 | Minor | Chat keeps tag characters and other invisible code points | REAL | `isInvisible` covers C0/C1, soft hyphen, CGJ, ALM, Hangul/Khmer/Mongolian fillers, ZW*/bidi, VS1–15, specials, shorthand/musical format controls, tags U+E0000–E007F and VS supplement. VS16 is kept for emoji. | "#9 chat strips invisible code points" |
| 10 | Minor | Gate entry idempotency does not cover resources | REAL (a zero-credit gate, or two concurrent joins, could spend resources twice) | Synchronous in-memory claim before any await (released on failure); credits via `chargeCredits`, and resources are spent only when the credit charge is new | Existing gate test (credits −20000 and QUANTUM_SHARD −5 exactly once) + #8 test |
| 11 | Major | Gate fire-and-forget promises without `.catch`; one reward failure aborts completion | REAL (an unhandled rejection can crash the process; a grant failure skipped finishMatch/lock) | `ensureMatch()` shared promise; `enrollInMatch(p)` enrolls only the joining player, with `.catch`; `completeRun()` has an outer `.catch` and a per-player try/catch; finishMatch has its own try/catch | Gate run test (all 6 waves, rewards, match) |
| 12 | Major | Raid solo exploit | REAL, economy: R4 halves boss hull, and a solo pilot got full XP/credits/loot plus crypto weight 1 | See note 1 | "#12 raids: daily entry limit and no rewards for under-manned raids" |
| 13 | Minor | `"pending"` sentinel matchId | REAL (it could reach `grantCryptoReward(matchId)`) | Replaced by a shared `matchPromise`; `matchId` is null until a real id exists | Gate test + raid test |
| 14 | Minor | Leavers on the winning team gain rating | REAL | A leaver's `ratingDelta` is `min(0, delta)` | "#14 leavers never gain rating, even on the winning team" |
| 15 | Minor | `game.rules` / `game.tuning` overrides not validated | REAL (e.g. `pickupRange: "x"` or negative ranges from the admin DB silently broke rooms) | `GameRulesOverrideSchema` (strict, partial, typed against `keyof GameRules`) + `parseTuningOverride`. An invalid document is ignored as a whole and a warning is logged. | "#15 game.rules / game.tuning overrides are validated" |
| 16 | Minor | Fire-rate drift from tick quantization | REAL (a 3/s weapon fired about 2.5/s at 20 Hz) | Continuous fire chains from `readyAt`; after an idle interval the schedule restarts at `now`, so shots are never banked; non-finite intervals are handled | game-core "#16 fire rate" (30–31 shots in 10 s; no idle burst) |
| 17 | Minor | Matchmaking filters latency and region before grouping parties | REAL (a party could be split or partially matched) | Units are built first; a unit is rejected as a whole if any member exceeds latency, and is matched in one region (its leader's) | game-core "#17 matchmaking keeps parties whole" |
| 18 | Major | Money as float `number` in game-core | REAL (costs are money; ledger amounts are bigint) | New `money.ts`: `toMoney()` (one rule: round half up; rejects NaN, ±∞ and negatives) and `mulMoney()`. `UpgradeCost.credits/gems`, `deathRepairCost`, `repairCost`, `craftCost().credits` and `CrafterState.credits` are `bigint`. Callers updated in game-server and apps/api (`ships.ts`, `inventory.ts`, `crafting.ts`; JSON columns via `toJsonValue`) | progression "toMoney" test, updated cost tests; API integration tests (upgrade/craft) green |
| 19 | Minor | Gear score counts unequippable items | REAL (twenty lasers on a two-slot ship inflated the score used by matchmaking) | `computeStats` passes the slot-limited, type-filtered lists and the clamped upgrade level to `gearScore` | game-core "#19 gear score uses the equipped loadout" |
| 20 | Major | Unvalidated tuning overrides; the shared `DEFAULT_TUNING` could be mutated | REAL | See note 2 | game-core "#20 tuning overrides are validated" |
| 21 | Minor | PIRATE zone enables PvP on non-PvP maps | REAL (Helios Frontier is a non-PvP map but had PvP inside its pirate zone) | PIRATE zones no longer enable PvP by themselves; `map.pvp`, PVP and HIGH_RISK behave as before and SAFE still wins | game-core "#21 PIRATE zones…" (synthetic map + Helios regression) |
| 22 | Trivial | Test files in the build program | REAL in intent (see note 3) | See note 3 | `tsc -p packages/game-core/tsconfig.build.json` |

## Notes on the three fixes that differ from the prompt

1. **#12 — a daily limit instead of an entry cost.** The prompt accepted either an entry cost or a daily limit. The
   fix adds a daily entry limit (`game.rules.raidDailyEntries`, default 3), counted from `GameMatchPlayer` rows of RAID
   matches; the entry is recorded before admission, so leaving early does not bypass it. Rewards need at least
   `ceil(raidSize × raidMinPilotsFraction)` distinct contributors (default 0.5); below that, raid-boss XP, credits,
   loot and crypto are all zero. Above it, everything is scaled by `min(1, contributors / raidSize)`. An entry cost was
   not added because raids have no cost in the game data, and adding one would be a balance change.
2. **#20 — strict schema in game-core.** Validation uses a strict zod schema (`SimTuningOverrideSchema`: finite and
   bounded values, known cap keys only, `minHitChance ≤ maxHitChance`). `mergeTuning` always returns a fresh object;
   an invalid override returns the defaults, and `parseTuningOverride` exposes the error so the server can log it.
   zod is now a game-core dependency; it is already used by config and validation.
3. **#22 — separate build config, contrary to the prompt's "no separate config" wording.** The shared base tsconfig
   already sets `noEmit: true`, so no test code ever reached a build artifact. Excluding tests from the only config
   would stop them being typechecked, which is worse. As the coordinator directed, `tsconfig.build.json` (excluding
   `*.test.ts` / `*.spec.ts`) is now used by `build` in game-core and telemetry, while `typecheck` keeps the tests.
   game-server builds with tsup from explicit entries, so its tests never enter `dist`. `vitest` was added as a
   devDependency of game-core, telemetry and game-server.

## Rejected findings

None.
