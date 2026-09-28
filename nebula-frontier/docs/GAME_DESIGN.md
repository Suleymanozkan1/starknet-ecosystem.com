# Game Design — NEBULA FRONTIER

An original persistent space MMO. All names, lore, ships, maps and art are original to this project. Every number referenced here lives in `packages/config/data/*.json` (or DB overrides) — this document describes intent, the data is the source of truth.

## Premise & story
The Frontier is a ring of contested star systems between the old Core and the unknown Void. Three powers compete for its lanes. Meanwhile, a rogue machine intelligence (the **Null Choir**) is waking the ancient **Vanta Colossus** in the Astra Graveyard.

| Chapter | Arc | Highlights |
|---|---|---|
| 1 — First Light | Leave the home system | Drone drills, Corsair raiders, first jump through the gate to Helios Frontier |
| 2 — Chitin in the Dark | Xyrr Hive probes | Helios defense, plasma ore mining in Orion Belt, Leviathan spawnlings |
| 3 — Song of the Choir | The signal | Null Sentinels, Vanta Rift blockade, the Alpha Breach gate |
| 4 — Graveyard Shift | Astra Graveyard | Null Destroyers, adult Leviathan hunt |
| 5 — Wake the Colossus | Endgame | World boss assault, Titan Vault raid, "Legend of the Frontier" |

Quest chains, new chapters and seasons are pure data (`quests.json`, `seasons.json`, `events.json`).

## Factions (`factions.json`)
| Faction | Motto | Identity | Home |
|---|---|---|---|
| **Aurora Industries** | "Light the way." | Solar-sail shipwrights and surveyors; fast, precise ships. Gold/white. | Aurora Prime |
| **Vortex Consortium** | "Everything has a price. We set it." | Salvage guilds, convoy escorts and brokers bound by one ledger; rugged assault craft. Teal/steel. | Vortex Haven |
| **Nova Dynasty** | "Burn bright. Burn forever." | Houses that survived the Crown star's collapse; duel culture, heavy strikers. Crimson/ember. | Nova Crown |

Each faction has an emblem, lore, colors, home sector, starter ship and loadout, a small stat bonus, reputation, faction missions, ranking and faction-war scoring.

Independent NPC factions: **Crimson Wake Corsairs** (pirates), **Xyrr Hive** (alien swarm), **Null Choir** (rogue AI), **Leviathan Brood** (space fauna). Each has its own weakness, resistance, behaviors and drop tables.

## Galaxy
Galaxy → Sector → Star System → Map → Zone (`galaxy.json`, `maps.json`). There are 11 maps:
- Three faction homes.
- Helios Frontier (hub).
- Orion Belt (mining).
- Vanta Rift (high-risk PvP / pirate zone).
- Astra Graveyard (world boss).
- Eclipse Arena (PvP).
- Two gate instances.
- Titan Vault (raid).

Zones: safe, neutral, PvP, high-risk, pirate, event, boss, gate and mining. Travel uses portals, jump gates, warp gates, and event/boss/raid/PvP gates. Maps contain stations (dock, hangar, shop, repair, crafting, market, quest board, faction HQ, clan services), asteroid fields, wrecks, derelicts, planets and beacons.

## Ships (`ships.json`)
There are 16 ships in 13 classes (scout, interceptor, assault, striker, destroyer, battlecruiser, carrier, support, tank, stealth, exploration, mining, EW), across tiers 1–5.

Every ship has:
- A distinct modular silhouette: hull archetype, engines, wings, cockpit, reactor, armor, antennae, cargo, drone dock and hardpoints.
- Stats: hull, shield, armor, energy, speed, acceleration, turn rate and cargo.
- Slots: laser, missile, generator, module, drone and ability.
- Three abilities: passive, active and ultimate.

The architecture supports 30–50+ ships by adding data rows; the procedural factory renders any valid visual combination, and `glb` slots accept production models.

## Combat
- **Damage pipeline:** accuracy → crit → element vs resistance/weakness → shield → armor (penetration) → hull.
- **Resources and effects:** energy and heat budgets, EMP / shield disruption, boss weak points.
- **Weapons:** laser, plasma, railgun, particle, ion, beam, missile, rocket, torpedo, EMP, mine, drone weapon, special and mining laser.
- **Rarity:** COMMON → PROTOTYPE, with random affixes (capped and PvP-normalized).
- **Modules:** 15 active modules and passive generators.
- **Drones:** six types, levels and formations.
- **Pets:** companions that collect loot, repair, extend radar and scan.
- **Targeting:** soft/hard lock, nearest enemy/player/objective, manual aim, lead indicator.

## PvE
- **Open world:** NPC packs with AI states (idle, patrol, search, aggro, attack, flee, assist, retreat, respawn), elites, invasions, convoy/escort, mining zones.
- **Gates:** waves 1–3 → Elite → Mini Boss → Final Boss, on Normal, Hard, Nightmare or Mythic.
- **World boss:** the Vanta Colossus has four phases (Shield → Armor → Reactor → Enrage) with weak points, adds and special attacks; rewards scale with each player's contribution.
- **Raids:** Titan Vault for 4, 8, 16 or 25 players.

## PvP
- **Modes:** open-world PvP in PvP zones, duels, arena, team deathmatch, king of the hill, capture zone, faction war, clan war and large-scale battles (50v50 via AOI).
- **Ranked:** Elo/MMR seasons.
- **Social pressure:** bounties, and reputation/karma (Neutral, Friendly, Hostile, Outlaw, Bounty Target).

## Progression & economy loops
- **Levels:** 1–50 with a data-defined XP curve, ranks from honor, prestige, gear score, achievements, season score, faction reputation, item upgrades +1…+20.
- **Resources:** Titanium, Plasma Ore, Dark Matter, Quantum Shard, Cryonite, Aether Crystal, Void Essence. They come from asteroids, wrecks, NPCs, quests, events and raids, and feed blueprint crafting (Standard → Legendary).
- **Currencies:**
  - Credits (earned; spent on repair, ammo, crafting, travel and upgrades).
  - Gems (premium; spent on cosmetics, pass and convenience).
  - Resources.
  - Crypto rewards: capped, budgeted and eligibility-checked. See ECONOMY.md.
- **Social:** clans (roles, treasury, missions, war, battle station), squads (4–8), friends, chat channels, mailbox, notifications.
- **Seasons:** season, battle pass (free and premium tracks, 50 tiers), and events (invasion, world boss, treasure hunt, double XP, faction war, mining festival, PvP weekend, raid, Void Rift global event).
