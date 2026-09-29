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

/** Code points that render as nothing (or reorder text) and are abused for spoofing / hidden payloads. */
const INVISIBLE_RANGES: [number, number][] = [
  [0x0000, 0x001f], [0x007f, 0x009f], // C0/C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // arabic letter mark
  [0x115f, 0x1160], // hangul fillers
  [0x17b4, 0x17b5], // khmer inherent vowels
  [0x180b, 0x180f], // mongolian variation selectors / vowel separator
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM
  [0x2028, 0x202e], // line/paragraph separators, bidi embeddings/overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
  [0x3164, 0x3164], // hangul filler
  [0xfe00, 0xfe0e], // variation selectors 1-15 (VS16 U+FE0F kept for emoji presentation)
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xffa0, 0xffa0], // halfwidth hangul filler
  [0xfff0, 0xfffb], // specials incl. interlinear annotation
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical symbol format controls
  [0xe0000, 0xe007f], // tag characters
  [0xe0100, 0xe01ef], // variation selectors supplement
];

export function isInvisible(cp: number): boolean {
  for (const [lo, hi] of INVISIBLE_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** Strip control characters / zero-width / bidi-override chars and collapse whitespace in chat. */
export function sanitizeChat(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKC")) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp === 0x09 || cp === 0x0a ? " " : isInvisible(cp) ? "" : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 280);
}
