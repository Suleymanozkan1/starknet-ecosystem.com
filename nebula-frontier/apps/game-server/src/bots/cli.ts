/**
 * Dev bot runner: `pnpm --filter @nebula/game-server bots -- --count 10 [--map map_aurora_prime] [--url ws://localhost:2567] [--type fighter]`
 *
 * Bots are real WebSocket clients (@colyseus/sdk). They authenticate with game
 * tickets signed by GAME_TICKET_SECRET for DB users named `bot_*` (created on
 * first run, reused afterwards).
 */
import { randomUUID } from "node:crypto";
import { Client, type Room } from "@colyseus/sdk";
import { FACTIONS, FACTIONS_BY_ID, MAPS_BY_ID } from "@nebula/config";
import { signGameTicket } from "@nebula/authentication";
import { createDb, type Db } from "@nebula/database";
import { mulberry32, RoomName } from "@nebula/shared";
import { ARCHETYPES, decide, type BotMemory, type BotWorld, type EntityView } from "./behaviors.js";

interface Args { count: number; map: string | null; url: string; type: string | null; durationSec: number }

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    count: Math.max(1, Math.min(500, Number(get("count") ?? 10))),
    map: get("map") ?? null,
    url: get("url") ?? process.env.PUBLIC_GAME_SERVER_URL ?? `ws://localhost:${process.env.GAME_PORT ?? 2567}`,
    type: get("type") ?? null,
    durationSec: Number(get("duration") ?? 0),
  };
}

async function ensureBots(db: Db, n: number): Promise<{ id: string; username: string; faction: string; lastMapId: string | null }[]> {
  const existing = await db.user.findMany({ where: { username: { startsWith: "bot_" } }, include: { playerFaction: true }, take: n, orderBy: { createdAt: "asc" } });
  const out = existing.map((u) => ({ id: u.id, username: u.username, faction: u.playerFaction?.factionId ?? "", lastMapId: u.lastMapId }));
  for (let i = out.length; i < n; i++) {
    const faction = FACTIONS[i % FACTIONS.length]!.id;
    const username = `bot_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const u = await db.user.create({ data: { username, playerFaction: { create: { factionId: faction } } } });
    out.push({ id: u.id, username, faction, lastMapId: null });
  }
  for (const b of out) {
    if (!b.faction) {
      b.faction = FACTIONS[0]!.id;
      await db.playerFaction.upsert({ where: { userId: b.id }, create: { userId: b.id, factionId: b.faction }, update: {} });
    }
  }
  return out;
}

interface SchemaEntity extends EntityView { kind: string }

function snapshot(room: Room): { self: EntityView | null; entities: EntityView[] } {
  const state = room.state as { entities?: { forEach: (cb: (e: SchemaEntity, k: string) => void) => void } };
  const entities: EntityView[] = [];
  let self: EntityView | null = null;
  state.entities?.forEach((e, key) => {
    const v: EntityView = { id: key, kind: e.kind, x: e.x, y: e.y, hull: e.hull, maxHull: e.maxHull, shield: e.shield, maxShield: e.maxShield, dead: e.dead, faction: e.faction, team: e.team, targetId: e.targetId, defId: e.defId };
    entities.push(v);
    if (key === room.sessionId) self = v;
  });
  return { self, entities };
}

async function runBot(url: string, secret: string, bot: { id: string; username: string; faction: string; lastMapId: string | null }, mapOverride: string | null, type: string, seed: number, stopAt: number): Promise<void> {
  const home = FACTIONS_BY_ID.get(bot.faction)?.homeMap ?? "map_aurora_prime";
  const mapId = mapOverride ?? (bot.lastMapId && MAPS_BY_ID.get(bot.lastMapId)?.roomType === "sector" ? bot.lastMapId : home);
  const map = MAPS_BY_ID.get(mapId);
  if (!map) throw new Error(`unknown map ${mapId}`);
  const ticket = await signGameTicket({ sub: bot.id, username: bot.username, mapId, jti: randomUUID() }, secret);
  const client = new Client(url);
  const room = await client.joinOrCreate(RoomName.SECTOR, { ticket, mapId });
  const quiet = () => undefined;
  for (const t of ["player_join", "player_leave", "player_attack", "player_damage", "player_death", "player_respawn", "player_level_up", "item_drop", "item_pickup", "quest_progress", "quest_complete", "reward", "chat", "notice", "pong", "docked", "effect", "wave", "kill_feed", "error", "event_started", "event_finished", "boss_phase", "match_start", "match_end", "jump"]) room.onMessage(t, quiet);
  const arch = ARCHETYPES[type] ?? ARCHETYPES.fighter!;
  const mem: BotMemory = { wanderTo: null, lastModuleAt: 0, rng: mulberry32(seed) };
  const station = map.stations.find((s) => s.faction === bot.faction) ?? map.stations[0];
  const homePos = station ? { x: station.x, y: station.y } : { x: map.width / 2, y: map.height / 2 };
  let seq = 0;
  let action = decide(arch, { self: { id: "", kind: "PLAYER", x: 0, y: 0, hull: 1, maxHull: 1, shield: 1, maxShield: 1, dead: false, faction: bot.faction, team: 0, targetId: "", defId: "" }, entities: [], mapWidth: map.width, mapHeight: map.height, home: homePos, now: Date.now() }, mem);
  let lastDecision = 0;
  let firing = false;
  let target = "";
  let lastRespawn = 0;
  await new Promise<void>((resolve) => {
    room.onLeave(() => resolve());
    const iv = setInterval(() => {
      const now = Date.now();
      if (stopAt > 0 && now > stopAt) {
        clearInterval(iv);
        void room.leave().then(() => resolve());
        return;
      }
      const snap = snapshot(room);
      const self = snap.self;
      if (!self) return;
      if (self.dead) {
        if (now - lastRespawn > 2000) {
          lastRespawn = now;
          room.send("respawn", {});
        }
        return;
      }
      if (now - lastDecision > 250) {
        lastDecision = now;
        const world: BotWorld = { self, entities: snap.entities, mapWidth: map.width, mapHeight: map.height, home: homePos, now };
        action = decide(arch, world, mem);
        if (action.targetId !== undefined && (action.targetId ?? "") !== target) {
          target = action.targetId ?? "";
          room.send("target", target ? { mode: "ENTITY", entityId: target } : { mode: "CLEAR" });
        }
        if (action.firing !== undefined && action.firing !== firing) {
          firing = action.firing;
          room.send("fire", { firing, group: "PRIMARY" });
        }
        if (action.mine !== undefined) room.send("mine", { asteroidId: action.mine });
        if (action.pickup) room.send("pickup", { lootId: action.pickup });
        if (typeof action.module === "number") room.send("module", { slot: action.module });
        if (typeof action.skill === "number") room.send("skill", { slot: action.skill });
      }
      room.send("input", {
        seq: ++seq,
        thrust: action.thrust ?? 0,
        strafe: 0,
        heading: action.heading ?? Number.NaN,
        boost: action.boost ?? false,
        moveTo: action.moveTo ?? null,
      });
    }, 50);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const secret = process.env.GAME_TICKET_SECRET;
  if (!secret) throw new Error("GAME_TICKET_SECRET is required");
  const db = createDb();
  const bots = await ensureBots(db, args.count);
  await db.$disconnect();
  const types = Object.keys(ARCHETYPES);
  const stopAt = args.durationSec > 0 ? Date.now() + args.durationSec * 1000 : 0;
  console.info(`starting ${bots.length} bots against ${args.url}`);
  const runs = bots.map((b, i) => {
    const type = args.type ?? types[i % types.length]!;
    return (async () => {
      await new Promise((r) => setTimeout(r, i * 100));
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await runBot(args.url, secret, b, args.map, type, i + 1, stopAt);
          console.info(`bot ${b.username} (${type}) left`);
          return;
        } catch (e) {
          console.error(`bot ${b.username} (${type}) error: ${(e as Error).message}`);
          if (stopAt > 0 && Date.now() > stopAt) return;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
  });
  await Promise.all(runs);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
