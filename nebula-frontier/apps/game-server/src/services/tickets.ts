/**
 * Game ticket verification + single-use enforcement (replay protection).
 * jti is stored with SET NX EX in Redis (shared across processes) or, when
 * Redis is not configured, in a process-local TTL map.
 */
import { verifyGameTicket, signGameTicket, type GameTicketClaims, type KeyRing } from "@nebula/authentication";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export class TicketError extends Error {
  code: "INVALID_TICKET" | "TICKET_REPLAYED" | "TICKET_MAP_MISMATCH";
  constructor(code: TicketError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** jti TTL must outlive the ticket (60s) so a replay inside the validity window is always caught. */
const JTI_TTL_SEC = 120;

export class TicketService {
  /** Verification accepts every key in the ring (rotation); new tickets are signed with the active key. */
  private readonly keys: KeyRing;
  private readonly redis: Redis | null;
  private readonly memory = new Map<string, number>();

  constructor(keys: KeyRing, redis: Redis | null) {
    this.keys = keys;
    this.redis = redis;
  }

  /** Verify signature/audience/expiry, then atomically consume the jti. */
  async verifyAndConsume(ticket: string): Promise<GameTicketClaims> {
    let claims: GameTicketClaims;
    try {
      claims = await verifyGameTicket(ticket, this.keys);
    } catch (e) {
      throw new TicketError("INVALID_TICKET", `Invalid game ticket: ${(e as Error).message}`);
    }
    const fresh = await this.consumeJti(claims.jti);
    if (!fresh) throw new TicketError("TICKET_REPLAYED", "Game ticket already used");
    return claims;
  }

  async consumeJti(jti: string): Promise<boolean> {
    // Shared with the API: `gt:<jti>` (SET NX EX). Any process that sees the key first wins.
    const key = `gt:${jti}`;
    if (this.redis) {
      const r = await this.redis.set(key, "1", "EX", JTI_TTL_SEC, "NX");
      return r === "OK";
    }
    const now = Date.now();
    if (this.memory.size > 50_000) for (const [k, exp] of this.memory) if (exp < now) this.memory.delete(k);
    const exp = this.memory.get(key);
    if (exp !== undefined && exp > now) return false;
    this.memory.set(key, now + JTI_TTL_SEC * 1000);
    return true;
  }

  /** Server-issued ticket for portal jumps (new jti, target map). */
  async issue(userId: string, username: string, mapId: string): Promise<string> {
    return signGameTicket({ sub: userId, username, mapId, jti: randomUUID() }, this.keys);
  }
}
