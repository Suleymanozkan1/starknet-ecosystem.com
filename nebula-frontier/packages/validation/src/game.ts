/**
 * zod schemas for Colyseus client -> server messages (`ClientMessages` in @nebula/shared protocol).
 * The game server parses every incoming message with `clientMessageSchemas[type]` and drops
 * (and risk-flags) anything that fails. Numbers are bounded and must be finite.
 */
import { z } from "zod";
import { DroneFormation, type ClientMessages } from "@nebula/shared";
import { hasControlChars } from "./common.js";

const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
const entityId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:-]+$/);
/** Map coordinates are bounded generously; the server clamps to the actual map size. */
const coord = finite(-100_000, 100_000);
const empty = z.object({}).strict();

export const inputMsgSchema = z.object({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  thrust: finite(-1, 1),
  strafe: finite(-1, 1),
  // NaN means "keep heading": accept NaN explicitly, otherwise bounded radians.
  heading: z.union([z.nan(), finite(-Math.PI * 4, Math.PI * 4)]),
  boost: z.boolean(),
  moveTo: z.object({ x: coord, y: coord }).nullable().optional(),
});
export const aimMsgSchema = z.object({ x: coord, y: coord });
export const fireMsgSchema = z.object({ firing: z.boolean(), group: z.enum(["PRIMARY", "SECONDARY"]) });
export const targetMsgSchema = z.object({
  mode: z.enum(["ENTITY", "NEAREST_ENEMY", "NEAREST_PLAYER", "NEAREST_OBJECTIVE", "CLEAR"]),
  entityId: entityId.optional(),
  lock: z.enum(["SOFT", "HARD"]).optional(),
}).refine((m) => m.mode !== "ENTITY" || Boolean(m.entityId), "entityId required for ENTITY mode");
export const skillMsgSchema = z.object({ slot: z.number().int().min(0).max(7) });
export const moduleMsgSchema = z.object({ slot: z.number().int().min(0).max(15) });
export const dashMsgSchema = z.object({ dirX: finite(-1, 1), dirY: finite(-1, 1) });
export const dockMsgSchema = z.object({ stationId: entityId });
export const pickupMsgSchema = z.object({ lootId: entityId });
export const mineMsgSchema = z.object({ asteroidId: entityId.nullable() });
export const jumpMsgSchema = z.object({ portalId: entityId });
export const chatMsgSchema = z.object({
  channel: z.enum(["LOCAL", "GLOBAL", "FACTION", "CLAN", "SQUAD"]),
  text: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine((s) => !hasControlChars(s), "control characters are not allowed"),
});
export const formationMsgSchema = z.object({ formation: z.enum(Object.values(DroneFormation) as [DroneFormation, ...DroneFormation[]]) });
export const pingMsgSchema = z.object({ t: finite(0, Number.MAX_SAFE_INTEGER) });
export const markerMsgSchema = z.object({ x: coord, y: coord, kind: z.enum(["ATTACK", "DEFEND", "MOVE"]) });

/** One schema per client message type; keys match `ClientMsg` values. */
export const clientMessageSchemas = {
  input: inputMsgSchema,
  aim: aimMsgSchema,
  fire: fireMsgSchema,
  target: targetMsgSchema,
  skill: skillMsgSchema,
  module: moduleMsgSchema,
  dash: dashMsgSchema,
  dock: dockMsgSchema,
  undock: empty,
  pickup: pickupMsgSchema,
  mine: mineMsgSchema,
  jump: jumpMsgSchema,
  chat: chatMsgSchema,
  formation: formationMsgSchema,
  respawn: empty,
  ping: pingMsgSchema,
  marker: markerMsgSchema,
} satisfies { [K in keyof ClientMessages]: z.ZodType };

export type ClientMessageType = keyof typeof clientMessageSchemas;

/**
 * Parse an untrusted client message. Returns `null` for unknown types or invalid payloads so the
 * caller can drop it (and count it towards PACKET_SPAM / anomaly scoring).
 */
export function parseClientMessage<K extends ClientMessageType>(type: K, payload: unknown): ClientMessages[K] | null {
  if (typeof type !== "string" || !Object.hasOwn(clientMessageSchemas, type)) return null;
  const schema: z.ZodType = clientMessageSchemas[type];
  const res = schema.safeParse(payload ?? {});
  return res.success ? (res.data as ClientMessages[K]) : null;
}
