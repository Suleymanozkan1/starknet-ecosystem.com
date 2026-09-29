/**
 * Synchronized room state (Colyseus Schema v5, builder API — no decorators).
 *
 * `entities` is a view-filtered map: each client only receives entities that
 * the server added to its `StateView` (area of interest). Field names mirror
 * `EntitySnapshot` in @nebula/shared/protocol so renderers can treat decoded
 * entities as snapshots.
 */
import { schema, t, type SchemaType } from "@colyseus/schema";

export const Entity = schema({
  id: t.string(),
  kind: t.string(),
  name: t.string(),
  defId: t.string(),
  x: t.float32(),
  y: t.float32(),
  vx: t.float32(),
  vy: t.float32(),
  heading: t.float32(),
  hull: t.number(),
  maxHull: t.number(),
  shield: t.number(),
  maxShield: t.number(),
  energy: t.number(),
  maxEnergy: t.number(),
  level: t.uint8(),
  faction: t.string(),
  clanTag: t.string(),
  team: t.int8(),
  aiState: t.string(),
  targetId: t.string(),
  cloaked: t.boolean(),
  dead: t.boolean(),
  lastSeq: t.uint32(),
  flags: t.uint16(),
  cosmetics: t.string(),
}, "Entity");
export type Entity = SchemaType<typeof Entity>;

export const MatchInfo = schema({
  matchId: t.string(),
  mode: t.string(),
  /** WAITING | COUNTDOWN | RUNNING | ENDED */
  phase: t.string(),
  startsAt: t.float64(),
  endsAt: t.float64(),
  teamScores: t.array("number"),
  wave: t.uint8(),
  totalWaves: t.uint8(),
  difficulty: t.string(),
}, "MatchInfo");
export type MatchInfo = SchemaType<typeof MatchInfo>;

export const WorldState = schema({
  mapId: t.string(),
  roomKind: t.string(),
  region: t.string(),
  serverTime: t.float64(),
  tick: t.uint32(),
  online: t.uint16(),
  entities: t.map(Entity).view(),
  match: MatchInfo,
  eventId: t.string(),
  eventName: t.string(),
  eventEndsAt: t.float64(),
  xpMultiplier: t.float32(),
  dropMultiplier: t.float32(),
  bossId: t.string(),
  bossName: t.string(),
  bossPhase: t.uint8(),
  bossHullPct: t.float32(),
}, "WorldState");
export type WorldState = SchemaType<typeof WorldState>;

/** Galaxy/lobby presence state (no AOI — tiny). */
export const MapPresence = schema({
  mapId: t.string(),
  players: t.uint16(),
  rooms: t.uint16(),
  eventId: t.string(),
}, "MapPresence");
export type MapPresence = SchemaType<typeof MapPresence>;

export const GalaxyState = schema({
  online: t.uint32(),
  maps: t.map(MapPresence),
  activeEvents: t.array("string"),
  serverTime: t.float64(),
}, "GalaxyState");
export type GalaxyState = SchemaType<typeof GalaxyState>;
