/**
 * zod validators for every client → server message (`ClientMessages`).
 * Numeric movement fields are *sanitized* (clamped, NaN → 0) rather than
 * rejected so honest clients never diverge from the server; structurally
 * invalid messages are dropped.
 */
import { z } from "zod";
import type { ClientMessages } from "@nebula/shared";

const finite = z.number().refine((n) => Number.isFinite(n), "must be finite");
const clampNum = (lo: number, hi: number) =>
  z.unknown().transform((v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0));
const id = z.string().min(1).max(96).regex(/^[A-Za-z0-9_:.-]+$/);

export const InputSchema = z.object({
  seq: z.number().int().min(0).max(2 ** 31),
  thrust: clampNum(-1, 1),
  strafe: clampNum(-1, 1),
  heading: z.unknown().transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN)),
  boost: z.unknown().transform((v) => v === true),
  moveTo: z.object({ x: finite, y: finite }).nullable().optional(),
});

export const Schemas = {
  input: InputSchema,
  aim: z.object({ x: finite, y: finite }),
  fire: z.object({ firing: z.boolean(), group: z.enum(["PRIMARY", "SECONDARY"]) }),
  target: z.object({
    mode: z.enum(["ENTITY", "NEAREST_ENEMY", "NEAREST_PLAYER", "NEAREST_OBJECTIVE", "CLEAR"]),
    entityId: id.optional(),
    lock: z.enum(["SOFT", "HARD"]).optional(),
  }),
  skill: z.object({ slot: z.number().int().min(0).max(15) }),
  module: z.object({ slot: z.number().int().min(0).max(15) }),
  dash: z.object({ dirX: clampNum(-1, 1), dirY: clampNum(-1, 1) }),
  dock: z.object({ stationId: id }),
  undock: z.object({}).passthrough(),
  pickup: z.object({ lootId: id }),
  mine: z.object({ asteroidId: id.nullable() }),
  jump: z.object({ portalId: id }),
  chat: z.object({ channel: z.enum(["LOCAL", "GLOBAL", "FACTION", "CLAN", "SQUAD"]), text: z.string().min(1).max(280) }),
  formation: z.object({ formation: z.string().min(1).max(32) }),
  respawn: z.object({}).passthrough(),
  ping: z.object({ t: finite }),
  marker: z.object({ x: finite, y: finite, kind: z.enum(["ATTACK", "DEFEND", "MOVE"]) }),
} satisfies { [K in keyof ClientMessages]: z.ZodType };

export type ParsedMessages = { [K in keyof typeof Schemas]: z.output<(typeof Schemas)[K]> };

export const JoinOptionsSchema = z.object({
  ticket: z.string().min(20).max(4096),
  mapId: z.string().max(96).optional(),
  portalId: z.string().max(96).optional(),
  difficulty: z.string().max(32).optional(),
  instanceKey: z.string().max(96).optional(),
  /** Party/team hints for arena/clan war rooms. */
  team: z.number().int().min(0).max(7).optional(),
});
export type ParsedJoinOptions = z.output<typeof JoinOptionsSchema>;

/** Strip control characters / zero-width chars and collapse whitespace in chat. */
export function sanitizeChat(text: string): string {
  return text
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏ -‮⁠-⁯﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}
