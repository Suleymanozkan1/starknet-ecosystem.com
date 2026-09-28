import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { parseKeyRing, signGameTicket } from "@nebula/authentication";
import { createRedis } from "./redis.js";
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

describe("TicketService concurrent redemption", () => {
  const ring = parseKeyRing(`k1:${OLD}`);
  const ticket = () => signGameTicket({ sub: "u", username: "a", mapId: "m", jti: randomUUID() }, ring);
  const expectExactlyOne = (r: PromiseSettledResult<unknown>[]) => {
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(rejected).toHaveLength(r.length - 1);
    for (const x of rejected) expect(x.reason).toMatchObject({ code: "TICKET_REPLAYED" });
  };

  it("admits exactly one of two concurrent redemptions (in-memory)", async () => {
    const svc = new TicketService(ring, null);
    const t = await ticket();
    expectExactlyOne(await Promise.allSettled([svc.verifyAndConsume(t), svc.verifyAndConsume(t)]));
  });

  // Production path: SET NX EX in Redis shared by every game-server process (two services = two processes).
  const redisA = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379")!;
  const redisB = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379")!;
  afterAll(async () => {
    await Promise.all([redisA.quit(), redisB.quit()]);
  });
  it("admits exactly one of concurrent redemptions across processes (Redis SET NX)", async () => {
    const a = new TicketService(ring, redisA);
    const b = new TicketService(ring, redisB);
    const t = await ticket();
    expectExactlyOne(await Promise.allSettled([a.verifyAndConsume(t), b.verifyAndConsume(t), a.verifyAndConsume(t), b.verifyAndConsume(t)]));
  });
});
