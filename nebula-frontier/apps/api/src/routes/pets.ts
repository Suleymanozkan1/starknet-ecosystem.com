/**
 * Companions (pets). A pet is owned as a `Pet` row (unique per user + petId); a PET category
 * inventory item (shop / loot / grants of `item_pet_*`) unlocks the matching companion through the
 * explicit POST /api/pets/unlock (which binds the item to the account).
 * Exactly one pet is active; the game server loads it on join (buffs, loot collect, repair…).
 */
import type { FastifyInstance } from "fastify";
import { ITEMS_BY_ID, PETS_BY_ID } from "@nebula/config";
import { withSerializableTx, type Db } from "@nebula/database";
import { petLevelForXp, petXpToNext } from "@nebula/game-core";
import type { PetDto, PetsResponse } from "@nebula/shared";
import { idSchema } from "@nebula/validation";
import { conflict, notFound } from "../errors.js";

/**
 * Explicit unlock (POST /api/pets/unlock): in one SERIALIZABLE transaction, every owned, unlocked
 * PET item whose companion the user does not have yet is bound to the account (boundAt, version
 * bump — escrow/market refuse bound items, so it can never unlock a companion on another account)
 * and the matching Pet row is created. Returns the unlocked petIds. Idempotent.
 */
export async function unlockOwnedPets(db: Db, userId: string): Promise<string[]> {
  return withSerializableTx(db, async (tx) => {
    const items = await tx.inventoryItem.findMany({
      where: { userId, lockedBy: null, item: { category: "PET" } },
      select: { id: true, itemId: true, version: true, boundAt: true },
      orderBy: { acquiredAt: "asc" },
    });
    const owned = new Set((await tx.pet.findMany({ where: { userId }, select: { petId: true } })).map((p) => p.petId));
    let hasActive = (await tx.pet.count({ where: { userId, active: true } })) > 0;
    const now = new Date();
    const unlocked: string[] = [];
    for (const it of items) {
      const petId = ITEMS_BY_ID.get(it.itemId)?.ref;
      if (!petId || !PETS_BY_ID.has(petId) || owned.has(petId)) continue;
      const bound = await tx.inventoryItem.updateMany({
        where: { id: it.id, userId, version: it.version, lockedBy: null },
        data: { boundAt: it.boundAt ?? now, version: { increment: 1 } },
      });
      if (bound.count !== 1) throw conflict("CONCURRENT_UPDATE", "Inventory changed concurrently, retry");
      await tx.pet.create({ data: { userId, petId, name: PETS_BY_ID.get(petId)?.name ?? petId, active: !hasActive } });
      hasActive = true;
      owned.add(petId);
      unlocked.push(petId);
    }
    return unlocked;
  });
}

function toDto(p: { id: string; petId: string; name: string; xp: number; active: boolean }): PetDto {
  const def = PETS_BY_ID.get(p.petId);
  return {
    id: p.id, petId: p.petId, name: p.name, xp: p.xp, active: p.active,
    level: def ? petLevelForXp(p.xp, def) : 1,
    xpToNext: def ? petXpToNext(p.xp, def) : 0,
    abilities: def ? [...def.abilities] : [],
  };
}

export default async function petRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  // Read-only: unlocking companions from owned PET items is the explicit POST /api/pets/unlock.
  app.get("/api/pets", auth, async (req): Promise<PetsResponse> => {
    const rows = await db.pet.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "asc" } });
    return { pets: rows.map(toDto) };
  });

  app.post("/api/pets/unlock", auth, async (req): Promise<PetsResponse & { unlocked: string[] }> => {
    const userId = req.user.id;
    const unlocked = await unlockOwnedPets(db, userId);
    const rows = await db.pet.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    return { pets: rows.map(toDto), unlocked };
  });

  app.post<{ Params: { id: string } }>("/api/pets/:id/activate", auth, async (req): Promise<PetsResponse> => {
    const id = app.parse(idSchema, req.params.id);
    const userId = req.user.id;
    await withSerializableTx(db, async (tx) => {
      const pet = await tx.pet.findFirst({ where: { id, userId } });
      if (!pet) throw notFound("Pet");
      await tx.pet.updateMany({ where: { userId, NOT: { id } }, data: { active: false } });
      await tx.pet.update({ where: { id }, data: { active: true } });
    });
    const rows = await db.pet.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    return { pets: rows.map(toDto) };
  });
}
