import { SignJWT, jwtVerify } from "jose";

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

export async function signAccessToken(claims: AccessClaims, secret: string, ttlSec = 900): Promise<string> {
  return new SignJWT({ username: claims.username, roles: claims.roles, sid: claims.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setAudience("api")
    .setIssuer("nebula-frontier")
    .setExpirationTime(`${ttlSec}s`)
    .sign(enc(secret));
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, enc(secret), { audience: "api", issuer: "nebula-frontier", algorithms: ["HS256"] });
  if (typeof payload.sub !== "string") throw new Error("Invalid token subject");
  return {
    sub: payload.sub,
    username: String(payload.username ?? ""),
    roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
    sid: String(payload.sid ?? ""),
  };
}

/** Short-lived (60s) ticket the web client passes to the game server's onAuth. */
export async function signGameTicket(claims: GameTicketClaims, secret: string, ttlSec = 60): Promise<string> {
  return new SignJWT({ username: claims.username, mapId: claims.mapId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuedAt()
    .setAudience("game")
    .setIssuer("nebula-frontier")
    .setExpirationTime(`${ttlSec}s`)
    .sign(enc(secret));
}

export async function verifyGameTicket(token: string, secret: string): Promise<GameTicketClaims> {
  const { payload } = await jwtVerify(token, enc(secret), { audience: "game", issuer: "nebula-frontier", algorithms: ["HS256"] });
  if (typeof payload.sub !== "string" || typeof payload.jti !== "string") throw new Error("Invalid game ticket");
  return { sub: payload.sub, username: String(payload.username ?? ""), mapId: String(payload.mapId ?? ""), jti: payload.jti };
}
