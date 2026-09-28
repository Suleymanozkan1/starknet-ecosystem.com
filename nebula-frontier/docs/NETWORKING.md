# Networking (game server)

The authoritative real-time server is `apps/game-server` (Colyseus 0.18, `@colyseus/schema` v5, `ws` transport).
The game rules it runs live in `packages/game-core`, which the client also uses for prediction. The wire contract
is `packages/shared/src/protocol.ts` (`RoomName`, `ClientMessages`, `ServerEvents`, `EntitySnapshot`).

Clients send **intents only**. The server decides positions, HP, damage, cooldowns, XP, loot, credits and rewards.

## 1. Room types

| Room (`RoomName`) | Class | `filterBy` (one room per distinct value) | Map (`maps.json`) | Notes |
|---|---|---|---|---|
| `sector` | `SectorRoom` | `mapId` | `roomType: "sector"` | Open world: NPC spawns and respawns, mining, stations/docking, portals, faction PvP in PvP zones. **The ticket `mapId` must equal the room map.** |
| `boss` | `BossRoom` | `mapId` | `roomType: "boss"` | Open PvP map with a world boss (4 phases, weak points, adds, enrage). Boss damage is recorded as EventParticipation. |
| `pvp` | `PvPRoom` | `mapId, instanceKey, difficulty` | any (`map_eclipse_arena`) | `difficulty`: `RANKED`, `LARGE_SCALE` (50v50) or casual (default). |
| `arena` | `ArenaRoom` | `mapId, instanceKey` | any | Rated small-team matches. |
| `clan_war` | `ClanWarRoom` | `mapId, instanceKey` | any | Exactly two clans. `instanceKey` = `ClanWar.id`. The result updates the ClanWar row and clan score in the same transaction as GameMatch. |
| `gate` | `GateRoom` | `mapId, instanceKey, difficulty` | `roomType: "gate"` | Waves 1-3, Elite, Mini Boss, Final Boss. `difficulty` is `NORMAL`, `HARD`, `NIGHTMARE` or `MYTHIC`. The entry cost is charged once per instance. |
| `raid` | `RaidRoom` | `mapId, instanceKey, difficulty` | `roomType: "raid"` | `difficulty` sets the raid size: `4`, `8`, `16` or `25`. Boss hull scales with size. Each pilot may enter `raidDailyEntries` raids per UTC day. Rewards need at least `ceil(size × raidMinPilotsFraction)` contributors and are scaled by `min(1, contributors / size)`. |
| `event` | `EventRoom` | `mapId, instanceKey` | any map listed by an active event | Instanced event/rift. Joining is rejected (`NO_ACTIVE_EVENT`) unless an event is active on that map. |
| `galaxy` | `GalaxyRoom` | – | – | Online counts per map/room (across processes via the matchmaker driver) and active events. |
| `lobby` | Colyseus `LobbyRoom` | – | – | Realtime room listing: `sector`, `pvp`, `arena`, `boss` and `event` are listed. |

All in-world rooms share `BaseGameRoom` (tick, AOI, combat, NPC AI, loot, mining, docking, portals, chat,
persistence). Subclasses only override hooks.

Room metadata is `{ mapId, roomKind, region, maxPlayers, instanceKey?, difficulty? }`. `maxClients` is
`min(map.maxPlayers, MAX_PLAYERS_PER_ROOM)`.

## 2. Join / ticket flow

1. The web client calls `POST /api/game/ticket` and gets `{ ticket, mapId, gameServerUrl }`. The ticket is an HS256 JWT
   (`aud: "game"`) valid for **60 s**, with a unique `jti`.
2. The client joins with that ticket:
   `client.joinOrCreate("sector", { ticket, mapId })`. For instanced rooms also pass `instanceKey` / `difficulty`.
   `JoinOptions` is validated with zod.
3. `onAuth` does three things:
   - `verifyGameTicket(ticket, keyRingFromEnv("GAME_TICKET"))`. `GAME_TICKET_SECRETS=kid:secret,…` supports key
     rotation: the first key signs, and all keys verify. `GAME_TICKET_SECRET` is the single-key fallback.
   - Single use: `SET gt:<jti> 1 EX 120 NX`. This is the same key the API uses. Without Redis a process-local TTL map
     is used. A reused ticket is rejected with `TICKET_REPLAYED`.
   - Sector and boss rooms reject a ticket issued for another map (`TICKET_MAP_MISMATCH`).
4. `onJoin` loads the player: user, faction, clan, squad, active ship instance and loadout, and the equipped
   inventory items (only if unlocked and owned).
   - It rejects banned users (`BANNED`) and, in non-sector rooms, users below the map's minimum level (`LEVEL_TOO_LOW`).
   - A user with no ship gets the faction starter kit, including `STARTER_AMMO` from `factions.json`
     `starterLoadout.ammo`. This grant is idempotent (`originRef` `starter:*` / `starter-ammo:<uid>:<item>`).
   - Effective stats are computed with `game-core` `computeStats` (PvP-normalized in match rooms).
   - The player spawns at the arrival portal, their last position, the faction station, or the team spawn.
5. The joining client receives `player_join` with a `self` block (`SelfJoinInfo`) for prediction:
   `tickRate`, `aoiRadius`, motion stats (`speed`, `acceleration`, `turnRate`, `maxEnergy`), weapons, skills and
   modules.
   - Its own entity is `state.entities.get(room.sessionId)`.
   - It also receives `event_started` for active events on this map and for any active global rift.
6. The server sets `presence:<userId> = <mapId>` (TTL 60 s, refreshed every 20 s). On leave it deletes the key, but
   only if the key still names this map. The API reads it for online status.

Ticket failure codes (4401 `ServerError`): `INVALID_TICKET`, `TICKET_REPLAYED`, `TICKET_MAP_MISMATCH`.
Other join failures use 4403: `BANNED`, `LEVEL_TOO_LOW`, `MATCH_ENDED`, `CLAN_REQUIRED`, `CLAN_NOT_IN_WAR`,
`GATE_COMPLETED`, `NO_ACTIVE_EVENT`.

## 3. Message protocol

All client messages go through two checks in order:

1. A per-client token bucket: **90 msg/s, burst 120**. Every 40 drops inside 5 s adds a `PACKET_SPAM` strike; the
   third strike kicks the client with close code 4002.
2. A zod schema (`apps/game-server/src/protocol/messages.ts`). Invalid messages are dropped and counted in
   `nebula_packets_dropped_total{reason}`. Unknown message types are dropped too.

### Client → server

| Type | Payload | Validation / server rules |
|---|---|---|
| `input` | `{ seq, thrust, strafe, heading, boost, moveTo? }` | `seq` must be an integer ≥ 0 and strictly increasing; otherwise the input is dropped and flagged `PACKET_REPLAY`. Axes are clamped to −1..1 (NaN → 0) and a non-finite heading means "keep heading". The queue holds 64 inputs. Each accepted input is one fixed step, and a **movement budget** allows tickRate steps/s plus a burst of 10; excess inputs are dropped and flagged `SPEED_HACK`. |
| `aim` | `{ x, y }` | Must be finite. Sets the desired heading. |
| `fire` | `{ firing, group: PRIMARY\|SECONDARY }` | Toggles auto-fire at the current target. Fire rate, energy, heat, ammo and range are all enforced on the server clock. |
| `target` | `{ mode, entityId?, lock? }` | `ENTITY` only works for entities in the client's AOI view (so cloaked or far entities cannot be targeted). Other modes: `NEAREST_ENEMY`, `NEAREST_PLAYER`, `NEAREST_OBJECTIVE`, `CLEAR`. Also feeds the reaction-time bot heuristic. |
| `skill` / `module` | `{ slot: 0..15 }` | Server-side cooldowns, durations and energy. Early activations return `error ABILITY_COOLDOWN`; 8 early attempts in 10 s are flagged `COOLDOWN_BYPASS`. |
| `dash` | `{ dirX, dirY }` | Uses the first equipped DASH ability. The displacement is validated (flagged `TELEPORT` if too far). |
| `dock` / `undock` | `{ stationId }` / `{}` | Must be within 25 units and not in combat (6 s). Docking unloads cargo and runs a paid station repair (credit sink). |
| `pickup` | `{ lootId }` | Must be within 14 units and the owner, or after the 20 s ownership window. The grant is persisted before `item_pickup` is sent. |
| `mine` | `{ asteroidId \| null }` | Continuous extraction while in range, limited by cargo. |
| `jump` | `{ portalId }` | Must be within portal range, meet the level requirement and not be in combat. Also accepts rift gate ids. See §7. |
| `chat` | `{ channel: LOCAL\|GLOBAL\|FACTION\|CLAN\|SQUAD, text ≤ 280 }` | Rate limit 0.7 msg/s, burst 3. Blocked when muted (`User.mutedUntil`, the `CHAT_MUTED` restriction, or Redis `mute:<userId>`). Text is NFKC-normalized with control, zero-width and bidi characters stripped, then saved to `ChatMessage` in batches. |
| `formation` | `{ formation }` | One of `STANDARD`, `ARROW`, `TURTLE`, `DIAMOND`, `WHEEL`. |
| `respawn` | `{}` | Only after `progression.respawnMs`. |
| `ping` | `{ t }` | Answered with `pong { t, server }`. |
| `marker` | `{ x, y, kind }` | Relayed as the `marker` event to allies: same team in match rooms; otherwise squad members, clan members, or same-faction pilots within 2× AOI. |

### Server → client (`ServerEvents`)

| Type | Scope | Payload / when |
|---|---|---|
| `player_join` / `player_leave` | AOI (join: also self with `self`) | entity id + name |
| `player_attack` | AOI of the shooter | every shot: source/target/weapon/visual/`travelMs` |
| `player_damage` | AOI of the target | shield/armor/hull split, crit, element |
| `player_death` | AOI | entity, killer, position, scale |
| `player_respawn` | AOI + self | position, `repairCost` (credits charged at death) |
| `player_level_up` | AOI | level |
| `item_drop` / `item_pickup` | AOI / picker | loot id, rarity; granted items/credits/gems/resources |
| `reward` | self | xp/honor/credits/season points, reason, `cryptoEligible` |
| `quest_progress` / `quest_complete` | self | progress array / quest completed (claimed via API) |
| `boss_phase` | room | boss id, phase index, name, layer |
| `wave` | room | gate wave `n / total` |
| `match_start` / `match_end` | room | match id + mode / winner team + scores |
| `event_started` / `event_finished` | room (GLOBAL_RIFT: every room) | `{ eventId, name, type, mapIds, endsAt }` |
| `kill_feed` | room | killer, victim, pvp |
| `effect` | AOI | EMP / WARP / SHIELD_BURST / HEAL / CLOAK / BARRAGE / DASH / MINING / ENRAGE |
| `marker` | allies | `{ x, y, kind, fromId, fromName }` |
| `chat` | channel | `{ channel, from, fromId, text, at, faction }` |
| `docked` | self | station id + services |
| `jump` | self | `{ mapId, portalId, roomName, reservation }` |
| `notice` / `error` | self or room | UI text / `{ code, message }` for rejected intents |
| `pong` | self | latency measurement |

Synchronized state (`WorldState`):

- Room-wide fields: `mapId`, `roomKind`, `region`, `serverTime`, `tick`, `online`, `match` (`MatchInfo`), the current
  event, `xpMultiplier`/`dropMultiplier`, and boss `bossId`/`bossName`/`bossPhase`/`bossHullPct`.
- `entities`: a **view-filtered** `MapSchema<Entity>` whose fields mirror `EntitySnapshot`.
- Entity kinds: `PLAYER`, `NPC`, `BOSS`, `LOOT`, `ASTEROID`, `PORTAL`. `PORTAL` is used for rift gates, with
  `defId: "EVENT_GATE"` and `aiState` set to the event id. Static map portals and stations come from `maps.json`.

## 4. Tick and patch rate

- **Simulation:** `setFixedTimestep` at `GAME_TICK_RATE` (default **20 Hz**, dt = 50 ms). Each tick runs in this order:
  1. Consume inputs and run player movement (`stepShip`).
  2. NPC AI (think every 200 ms, bosses every 100 ms) and NPC movement.
  3. Rebuild the spatial grid.
  4. Player combat (auto-fire).
  5. Mining.
  6. Regeneration, buffs and heat.
  7. World upkeep (loot expiry, asteroid respawn, rift gate expiry).
  8. Room hooks (match, waves).
  9. Copy actors into Schema entities.
  10. Every 4 ticks (200 ms): AOI update.
- **Patches:** `GAME_PATCH_RATE_MS` (default **50 ms**). Schema sends only changed fields; assigning an equal value is
  a no-op. Positions are `float32`.
- **Input policy:**
  - Inputs in the queue are processed one fixed step each, within the movement budget. The ack is `entity.lastSeq`.
  - If no input arrived in the last 150 ms, the last intent is held for up to 2 s, then the ship brakes to idle.
    Held steps do not advance the ack.
  - Clients should send one `input` per fixed step (20/s).

## 5. Interest management (StateView AOI)

- `entities` is declared `t.map(Entity).view()`. Each client gets a `StateView`, and the server only
  `view.add()`s entities within `AOI_RADIUS` (default 140 units) of the client's ship. The query uses a uniform
  spatial grid with cell size = AOI/2.
- The visible set is diffed every `aoiUpdateEveryTicks` (4). Entities leaving range are `view.remove()`d.
- Always visible: self, the room's boss, and active rift gates.
- **Cloaked enemy players are never added to an opponent's view**, so a modified client cannot see through cloak.
  Targeting (`target ENTITY`) is also limited to the client's view.
- Combat and effect events are sent only to clients within AOI of the event position (`sendNear`).

### Bandwidth estimate for 50v50 (`LARGE_SCALE`)

Assume the worst case: the whole fight is inside one AOI, so each client sees about 100 ships.

- **State:** a moving ship changes `x, y, vx, vy, heading` (5 × float32 + field ids ≈ 25 B), usually some of
  `hull/shield/energy/flags` (varints, ≈ 10 B) plus ref/op overhead (≈ 3–5 B), so about **40 B per entity per patch**.
  100 entities × 40 B × 20 patches/s ≈ **80 KB/s (≈ 0.64 Mbit/s) downstream per client**, and ≈ 8 MB/s
  (64 Mbit/s) egress for the room.
- **Events:** every shot sends `player_attack` and `player_damage` to everyone in range (JSON/msgpack, ≈ 100–150 B each).
  100 ships × 2–3 weapons × ~2 shots/s ≈ 500 shots/s gives ≈ 1000 events/s × 120 B ≈ **120 KB/s per client**.
  **In a 50v50 battle combat events cost more bandwidth than state.**
- **Upstream:** 20 inputs/s × ~40 B ≈ 1 KB/s per client.
- **Mitigations:**
  - Implemented: AOI, delta patches, `float32`, and no projectile entities (hits are resolved at fire time; the
    client animates `travelMs`).
  - Available through configuration: a 100 ms patch rate for `LARGE_SCALE` rooms halves state traffic
    (`GAME_PATCH_RATE_MS`, or a per-room `patchRate`).
  - Not implemented: batching attack/damage events per tick into one binary message per client. This is the next
    optimization if large battles saturate links.

## 6. Prediction and reconciliation contract

- The client uses the **same pure function** as the server: `stepShip(state, input, motionStats, dt, bounds)` from
  `@nebula/game-core`, with `dt = 1 / self.tickRate`, `motionStats = self.motion` plus the active speed-buff
  multiplier, and `bounds = maps.json` width/height.
- The client runs one fixed step per input. It sends `{ seq, … }` with `seq` strictly increasing (never reuse `seq`
  after reconnecting; keep counting up) and keeps a buffer of unacknowledged inputs.
- **Reconciliation:** when the server entity arrives, the client drops inputs with `seq ≤ entity.lastSeq`, resets its
  predicted state to the server `x, y, vx, vy, heading, energy`, and replays the remaining inputs. Small errors are
  smoothed; errors larger than the teleport threshold snap. Respawn, dash and jump are legitimate teleports.
- Remote entities are interpolated (for example with the Colyseus `Predict` lerp mode at about a 100 ms delay).
- The server never accepts client positions. Hostile inputs are sanitized, and `sanitizeMoveInput` gives the same
  result on client and server, so honest clients never diverge.

## 7. Portals, jumps and seat reservations

- **`jump { portalId }`**:
  - The server checks range, level and the combat lock.
  - It issues a fresh server-side ticket for the target map (new `jti`) and calls
    `matchMaker.joinOrCreate(<roomName for target map roomType>, { ticket, mapId, portalId: targetPortal, instanceKey? })`.
    Gates and raids get `instanceKey: solo:<userId>`.
  - It replies `jump { mapId, portalId, roomName, reservation }` and persists the arrival position immediately.
  - The client calls `room.leave()` and then `client.consumeSeatReservation(evt.reservation)`.
- **VOID RIFT (`GLOBAL_RIFT`)**:
  - When the rift event starts (on schedule, or triggered by publishing `{ eventId, durationMinutes }` on presence
    topic `nf:events:trigger`), every sector/boss room on the event maps spawns a temporary **EVENT_GATE** portal
    entity.
  - The gate is visible map-wide and despawns at the end of the event window.
  - Every room in every process broadcasts `event_started` with `mapIds`.
  - Jumping into the gate reserves a seat in `event` room `{ mapId: <rift boss map>, instanceKey: <eventId>:<windowStart> }`,
    where the rift boss spawns.
  - When the event ends, a surviving boss despawns and participants are still paid by contribution tier.
- **Instanced rooms** (gate, raid, match, event) persist the player's position at the map's exit portal target, so the
  next login lands in a sector.

## 8. Reconnection

- Any close that is not consented (not 4000, 1000 or 4001) triggers `allowReconnection(client, 20 s)`
  (`game.rules.reconnectSeconds`).
- During that window the ship stays in the world but is ignored by NPC AI, firing stops and the input queue is
  cleared.
- On reconnect a new `StateView` is built from scratch. After the window expires the player is saved and removed.
- Match rooms count a player who leaves during `RUNNING` as a loss.

## 9. Horizontal scaling and regions

- With `REDIS_URL` set, the server uses `RedisPresence` (pub/sub, used for global/faction/clan chat and event
  triggers) and `RedisDriver` (matchmaking room cache). Without Redis it uses in-process `LocalPresence`/`LocalDriver`.
- Several processes and nodes can share one Redis. Set `GAME_PUBLIC_ADDRESS` per node so seat reservations point
  at the right host. `joinOrCreate` finds rooms across processes.
- Scheduled event windows are computed from the clock in every process (deterministic, no coordination).
- `REGION` (`EU`/`NA`/`ASIA`) goes into room metadata, the `GameRoom` heartbeat rows, metrics labels and the state.
  Deploy one Redis and node pool per region. The API chooses `gameServerUrl` by region.
- Redis never holds critical state. It holds only ticket jti markers, presence, mutes and the matchmaker cache.

## 10. Anti-cheat hooks

All validators live in `@nebula/game-core/anticheat` and `abilities`. Signals are grouped per player (at most one
write per type per 30 s) and sent to `recordRiskSignal` (`@nebula/economy`), which updates `User.riskScore` and
`riskLevel` and puts rewards and withdrawals under manual review.

| Signal | Trigger |
|---|---|
| `SPEED_HACK` / `TELEPORT` | Input rate above the movement budget; displacement beyond the legal maximum (defensive check); dash beyond its distance. |
| `PACKET_REPLAY` | Repeated or older `input.seq`; absurd sequence jumps. |
| `PACKET_SPAM` | Rate-limit drops (kicked on the third strike). |
| `COOLDOWN_BYPASS` | Repeated ability activation before cooldown. |
| `ATTACK_SPEED_HACK` | Shots per window above the weapon's fire rate (defensive check). |
| `DAMAGE_MANIPULATION` | Computed hit above `maxShotDamage` (defensive check; the hit is voided). |
| `DUPLICATE_LOOT` | The database refused a duplicate loot grant (unique `originRef` / ledger key). |
| `REPEATED_MOVEMENT` / `IMPOSSIBLE_REACTION` | Bot heuristics: repeated identical input chunks; lock reaction times below human levels. |
| `ABNORMAL_FARMING` | Repeated PvP kills of the same victim. These kills also earn nothing (same-victim window, level gap, same clan). |

## 11. Persistence batching and crash safety

- **Batched (per player, one transaction):** XP/level/rank, honor, season score, playtime, `PlayerStat` counters,
  maps visited, `PlayerResource`, kill credits (ledger `GAME_ISSUANCE → USER_WALLET`, key `kill:<npc life uid>:<user>`),
  ammo use, leaderboards (`npc_kills`, `pvp_kills`, `season_score`, `honor`), EventParticipation contributions, quest
  progress, achievements and last position.
  - Flushes happen every `GAME_FLUSH_INTERVAL_MS` (5 s), 250 ms after important events (level-up, PvP kill, boss
    kill, quest complete, dock, jump), on leave, and on graceful shutdown (`onBeforeShutdown` flushes all players
    before disconnecting).
  - If a flush fails, its delta is merged back and retried. Ledger postings are idempotent, so a retry never
    double-credits.
- **Immediate (transactional):**
  - Loot pickups: items with a unique `originRef`, credits/gems with ledger keys; a duplicate aborts the whole grant.
  - Death and station repair sinks.
  - Gate entry costs.
  - Match start/finish (GameMatch, GameMatchPlayer, rating, ClanWar).
  - Bounty claims: `Bounty` ACTIVE → CLAIMED plus an `ESCROW → killer` payout with key `bounty:<id>`, in one
    serializable transaction.
  - Event tier distribution: each `EventParticipation` row is claimed `rewarded=false → true` and paid in the same
    transaction (origin `event:<eventId>:<instance>:<userId>`).
  - Crypto rewards always go through `grantCryptoReward` with unique source refs.
- **Crash window:** a hard crash loses at most one flush interval of *batched* deltas (≤ 5 s of XP/counters). Loot,
  money sinks and match results are already committed. Nothing is kept only in Redis.

### Clan missions (game server → API)

Targeted objective events of clan members (KILL / KILL_PLAYER / COLLECT / MINE / TRAVEL / DAMAGE_BOSS / COMPLETE_GATE /
WIN_PVP / DELIVER) are sent to `POST {API_INTERNAL_URL}/api/internal/clan-missions/progress` with the header
`x-internal-token: $INTERNAL_SERVICE_TOKEN`.

- Quantity events (boss damage, mining, collecting) are aggregated per user and target.
- Events are sent with the persistence flush, in batches of at most 500, fire-and-forget, retried with backoff.
- Delivery never blocks the tick.
- After the retries are exhausted the batch is dropped and logged. Untargeted objectives still progress from
  PlayerStat in the API.

## 12. Load testing with bots

Bots are real WebSocket clients. They use DB users `bot_*` (created on first run, then reused) and tickets signed with
`GAME_TICKET_SECRET`. Archetypes: Scout, Miner, Fighter, Tank, Support. Behaviours: Wander, Collect, Attack, Flee,
Assist, ShieldUp.

```bash
cd apps/game-server && npx tsx --env-file=../../.env src/index.ts          # server
pnpm --filter @nebula/game-server bots -- --count 60 --map map_aurora_prime --duration 60
curl -s localhost:2567/metrics | grep -E 'nebula_tick_duration|resident_memory|eventloop_lag|packets_dropped'
```

To get the tick duration p95, read the `nebula_tick_duration_seconds` histogram and take the smallest bucket whose
cumulative count reaches 95% of `_count`. Also watch `nebula_nodejs_eventloop_lag_p99_seconds` and
`nebula_packets_dropped_total{reason}`.

### Measured (2026-09-28)

**Environment:** a 4 vCPU Linux container shared by the server (tsx dev mode, not the tsup build), the 60-bot process,
PostgreSQL and Redis. Both processes also shared the same 4 vCPUs.

**Setup:** one `sector` room on `map_aurora_prime` (150 max players; 23 NPCs and 60 asteroids spawned), 60 bots
(mixed archetypes, 20 inputs/s each) for about 60 s.

| Metric | Value |
|---|---|
| Ticks observed | 1228 in ~62 s (≈ 20 Hz held) |
| Tick duration mean | 1.95 ms |
| Tick duration p50 | 1–2.5 ms bucket |
| **Tick duration p95** | **≤ 5 ms** (1167/1228 ticks ≤ 5 ms) |
| Tick duration p99 | ≤ 10 ms; max one tick in the 50–100 ms bucket (JIT warm-up / GC) |
| Event loop lag p99 | 23 ms |
| Server CPU | 15.2 CPU-s over ~75 s process lifetime (≈ 20% of one core) |
| RSS | 286 MB idle → 382 MB with 60 players (tsx dev mode) |
| V8 heap used | 178 MB |
| Client messages received | 68,197 `input` + ~4.1k other; 0 dropped |

A 20 Hz tick has a 50 ms budget, so at p95 ≤ 5 ms one room uses about 10% of it with 60 active clients. These figures
come from a single short run in a shared container, so treat them as indicative. Production capacity should be
measured with the tsup build (`node dist/index.js`) and the bots on a separate machine.
