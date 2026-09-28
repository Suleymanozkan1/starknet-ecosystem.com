/**
 * JWTs (HS256) for API access tokens and game tickets, with key rotation.
 *
 * Every `secret` parameter accepts either a plain string (legacy, single key, no `kid`) or a
 * `KeyRing`. With a key ring, tokens are signed with the ACTIVE key and carry its `kid` in the
 * protected header; verification accepts any key in the ring (selected by `kid`, or tried in order
 * for legacy tokens without `kid`). Rotate by prepending a new `kid:secret`, deploying, and removing
 * the old key after the maximum token lifetime has passed.
 */
import { SignJWT, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";

const enc = (s: string) => new TextEncoder().encode(s);

export interface AccessClaims {
  sub: string;
  username: string;
  roles: string[];
  sid: string;
}

export interface GameTicketClaims {
  sub: string;
  username: string;
  /** Map the API authorised the player to enter (last known position / faction home). */
  mapId: string;
  jti: string;
}

export interface SigningKey {
  kid: string;
  secret: string;
}

export interface KeyRing {
  /** Key used to sign new tokens (first entry of the list). */
  active: SigningKey;
  /** All keys accepted for verification (active first). */
  keys: SigningKey[];
}

export type SecretOrKeyRing = string | KeyRing;

const KID_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const MIN_SECRET_LENGTH = 32;

/**
 * Parse a rotation list `kid1:secret1,kid2:secret2` (first = active). Falls back to a single
 * legacy `fallbackSecret` (kid "default") when the list is empty. Throws on malformed entries,
 * duplicate kids or secrets shorter than 32 characters.
 */
export function parseKeyRing(list: string | undefined | null, fallbackSecret?: string | null): KeyRing {
  const keys: SigningKey[] = [];
  for (const raw of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = raw.indexOf(":");
    if (idx <= 0) throw new Error("Key list entries must be `kid:secret`");
    const kid = raw.slice(0, idx);
    const secret = raw.slice(idx + 1);
    if (!KID_RE.test(kid)) throw new Error(`Invalid key id "${kid}"`);
    if (secret.length < MIN_SECRET_LENGTH) throw new Error(`Secret for kid "${kid}" must be at least ${MIN_SECRET_LENGTH} characters`);
    if (keys.some((k) => k.kid === kid)) throw new Error(`Duplicate key id "${kid}"`);
    keys.push({ kid, secret });
  }
  if (!keys.length) {
    if (!fallbackSecret || fallbackSecret.length < MIN_SECRET_LENGTH) throw new Error(`A secret of at least ${MIN_SECRET_LENGTH} characters is required`);
    keys.push({ kid: "default", secret: fallbackSecret });
  }
  return { active: keys[0] as SigningKey, keys };
}

/** `JWT_SECRETS` / `JWT_SECRET` (prefix "JWT") or `GAME_TICKET_SECRETS` / `GAME_TICKET_SECRET` (prefix "GAME_TICKET"). */
export function keyRingFromEnv(prefix: "JWT" | "GAME_TICKET", env: Record<string, string | undefined> = process.env): KeyRing {
  return parseKeyRing(env[`${prefix}_SECRETS`], env[`${prefix}_SECRET`]);
}

function signingKey(s: SecretOrKeyRing): { key: Uint8Array; kid?: string } {
  if (typeof s === "string") return { key: enc(s) };
  return { key: enc(s.active.secret), kid: s.active.kid };
}

function candidates(token: string, s: SecretOrKeyRing): SigningKey[] {
  if (typeof s === "string") return [{ kid: "", secret: s }];
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    return [];
  }
  if (kid) {
    const k = s.keys.find((x) => x.kid === kid);
    return k ? [k] : [];
  }
  return s.keys;
}

async function verifyWith(token: string, s: SecretOrKeyRing, audience: string): Promise<JWTPayload> {
  const keys = candidates(token, s);
  if (!keys.length) throw new Error("Unknown signing key");
  let lastErr: unknown;
  for (const k of keys) {
    try {
      const { payload } = await jwtVerify(token, enc(k.secret), { audience, issuer: "nebula-frontier", algorithms: ["HS256"] });
      return payload;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Invalid token");
}

export async function signAccessToken(claims: AccessClaims, secret: SecretOrKeyRing, ttlSec = 900): Promise<string> {
  const { key, kid } = signingKey(secret);
  return new SignJWT({ username: claims.username, roles: claims.roles, sid: claims.sid })
    .setProtectedHeader(kid ? { alg: "HS256", kid } : { alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setAudience("api")
    .setIssuer("nebula-frontier")
    .setExpirationTime(`${ttlSec}s`)
    .sign(key);
}

export async function verifyAccessToken(token: string, secret: SecretOrKeyRing): Promise<AccessClaims> {
  const payload = await verifyWith(token, secret, "api");
  if (typeof payload.sub !== "string") throw new Error("Invalid token subject");
  return {
    sub: payload.sub,
    username: String(payload.username ?? ""),
    roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
    sid: String(payload.sid ?? ""),
  };
}

/** Short-lived (60s) ticket the web client passes to the game server's onAuth. */
export async function signGameTicket(claims: GameTicketClaims, secret: SecretOrKeyRing, ttlSec = 60): Promise<string> {
  const { key, kid } = signingKey(secret);
  return new SignJWT({ username: claims.username, mapId: claims.mapId })
    .setProtectedHeader(kid ? { alg: "HS256", kid } : { alg: "HS256" })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuedAt()
    .setAudience("game")
    .setIssuer("nebula-frontier")
    .setExpirationTime(`${ttlSec}s`)
    .sign(key);
}

export async function verifyGameTicket(token: string, secret: SecretOrKeyRing): Promise<GameTicketClaims> {
  const payload = await verifyWith(token, secret, "game");
  if (typeof payload.sub !== "string" || typeof payload.jti !== "string") throw new Error("Invalid game ticket");
  return { sub: payload.sub, username: String(payload.username ?? ""), mapId: String(payload.mapId ?? ""), jti: payload.jti };
}
