/**
 * Companions (pets). A pet is owned as a `Pet` row (unique per user + petId); owning a PET
 * category inventory item (shop / loot / grants of `item_pet_*`) unlocks the matching companion.
 * Exactly one pet is active; the game server loads it on join (buffs, loot collect, repair…).
 */
import type { FastifyInstance } from "fastify";
import { ITEMS_BY_ID, PETS_BY_ID } from "@nebula/config";
import { withSerializableTx, type Db } from "@nebula/database";
import { petLevelForXp, petXpToNext } from "@nebula/game-core";
import type { PetDto, PetsResponse } from "@nebula/shared";
import { idSchema } from "@nebula/validation";
import { notFound } from "../errors.js";

/** Create Pet rows for owned PET items that have no companion yet (idempotent). */
export async function syncOwnedPets(db: Db, userId: string): Promise<void> {
  const items = await db.inventoryItem.findMany({ where: { userId, lockedBy: null, item: { category: "PET" } }, select: { itemId: true } });
  const petIds = [...new Set(items.map((i) => ITEMS_BY_ID.get(i.itemId)?.ref).filter((r): r is string => !!r && PETS_BY_ID.has(r)))];
  if (!petIds.length) return;
  const hasActive = (await db.pet.count({ where: { userId, active: true } })) > 0;
  await db.pet.createMany({
    data: petIds.map((petId, i) => ({ userId, petId, name: PETS_BY_ID.get(petId)?.name ?? petId, active: !hasActive && i === 0 })),
    skipDuplicates: true,
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

  app.get("/api/pets", auth, async (req): Promise<PetsResponse> => {
    await syncOwnedPets(db, req.user.id);
    const rows = await db.pet.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "asc" } });
    return { pets: rows.map(toDto) };
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
