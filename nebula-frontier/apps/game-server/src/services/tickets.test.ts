import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseKeyRing, signGameTicket } from "@nebula/authentication";
import { TicketService, TicketError } from "./tickets.js";

const OLD = "o".repeat(40);
const NEW = "n".repeat(40);

describe("TicketService key rotation", () => {
  it("accepts tickets signed with any key in GAME_TICKET_SECRETS and signs with the active key", async () => {
    const ring = parseKeyRing(`k2:${NEW},k1:${OLD}`);
    const svc = new TicketService(ring, null);
    const oldTicket = await signGameTicket({ sub: "u1", username: "a", mapId: "m", jti: randomUUID() }, parseKeyRing(`k1:${OLD}`));
    expect((await svc.verifyAndConsume(oldTicket)).sub).toBe("u1");
    await expect(svc.verifyAndConsume(oldTicket)).rejects.toMatchObject({ code: "TICKET_REPLAYED" });
    const issued = await svc.issue("u2", "b", "m");
    // Rotated-out key can no longer verify tickets signed with the new active key.
    await expect(new TicketService(parseKeyRing(`k1:${OLD}`), null).verifyAndConsume(issued)).rejects.toBeInstanceOf(TicketError);
    expect((await svc.verifyAndConsume(issued)).sub).toBe("u2");
  });

  it("falls back to a single legacy secret", async () => {
    const svc = new TicketService(parseKeyRing(undefined, OLD), null);
    const t = await signGameTicket({ sub: "u", username: "a", mapId: "m", jti: randomUUID() }, OLD);
    expect((await svc.verifyAndConsume(t)).sub).toBe("u");
  });
});
