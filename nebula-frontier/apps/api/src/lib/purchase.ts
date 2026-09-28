/**
 * Shop purchase (also used by ship unlock). Price, currency, stock and limits come from the
 * ShopProduct row — never from the client. Idempotent per (user, idempotencyKey): the Purchase row
 * is unique on that pair and the ledger posting key is derived from the purchase id.
 */
import { BATTLE_PASSES } from "@nebula/config";
import { post, system, userWallet, withSerializableTx, type Db, type Tx } from "@nebula/database";
import { Currency, LedgerAccountType, LedgerTxType, type PurchaseResponse, type ShopProductDef } from "@nebula/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { balancesDto } from "./balances.js";
import { getCatalog } from "./catalog.js";
import { addResources, grantBundle } from "./grants.js";
import { emptyLoadout } from "./inventory.js";
import { asRecord } from "./json.js";
import { loadRules } from "./rules.js";

type Grants = ShopProductDef["grants"];

export interface PurchaseInput {
  productId: string;
  quantity: number;
  idempotencyKey: string;
}

const PREMIUM_RANK: Record<string, number> = { FREE: 0, VIP: 1, ELITE: 2 };
const SINGLE_QTY = (g: Grants) => Boolean(g.ships?.length || g.premium || g.battlePassPremium);

async function existingPurchase(db: Db | Tx, userId: string, key: string) {
  return db.purchase.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
}

export async function grantShip(tx: Tx, userId: string, shipId: string): Promise<string> {
  const catalog = await getCatalog(tx);
  const def = catalog.ships.get(shipId);
  if (!def) throw badRequest("UNKNOWN_SHIP", `Unknown ship ${shipId}`);
  const inst = await tx.shipInstance.create({ data: { userId, shipId } });
  const lo = await tx.shipLoadout.create({
    data: { shipInstanceId: inst.id, name: "PVE", preset: "PVE", config: emptyLoadout(def.slots) as object },
  });
  await tx.shipInstance.update({ where: { id: inst.id }, data: { activeLoadoutId: lo.id } });
  return inst.id;
}

export async function purchaseProduct(db: Db, userId: string, input: PurchaseInput): Promise<PurchaseResponse & { duplicate: boolean }> {
  const prior = await existingPurchase(db, userId, input.idempotencyKey);
  if (prior) {
    if (prior.productId !== input.productId || prior.quantity !== input.quantity) {
      throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different purchase");
    }
    return { purchaseId: prior.id, balances: await balancesDto(db, userId), duplicate: true };
  }

  const product = await db.shopProduct.findUnique({ where: { id: input.productId } });
  if (!product || !product.active) throw notFound("Product", "PRODUCT_NOT_FOUND");
  if (product.currency === Currency.SOL || product.currency === Currency.NEBX) {
    throw badRequest("USE_DEPOSIT_FLOW", "This product is purchased with an on-chain deposit (POST /api/wallet/deposit/prepare)");
  }
  if (product.currency !== Currency.CREDITS && product.currency !== Currency.GEMS) throw badRequest("UNSUPPORTED_CURRENCY", "Unsupported currency");
  const grants = asRecord(product.grants) as Grants;
  if (SINGLE_QTY(grants) && input.quantity !== 1) throw badRequest("INVALID_QUANTITY", "This product can only be bought one at a time");
  const total = product.price * BigInt(input.quantity);
  const rules = await loadRules(db);

  try {
    const purchaseId = await withSerializableTx(db, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { level: true, premiumTier: true, premiumUntil: true } });
      if (user.level < product.requiredLevel) throw badRequest("LEVEL_TOO_LOW", `Requires level ${product.requiredLevel}`);
      if (product.limitPerUser !== null) {
        const bought = await tx.purchase.aggregate({ where: { userId, productId: product.id, status: "COMPLETED" }, _sum: { quantity: true } });
        if ((bought._sum.quantity ?? 0) + input.quantity > product.limitPerUser) throw badRequest("PURCHASE_LIMIT", "Purchase limit reached for this product");
      }
      if (product.stock !== null) {
        const dec = await tx.shopProduct.updateMany({ where: { id: product.id, stock: { gte: input.quantity } }, data: { stock: { decrement: input.quantity } } });
        if (dec.count !== 1) throw badRequest("OUT_OF_STOCK", "Product is out of stock");
      }
      for (const shipId of grants.ships ?? []) {
        const owned = await tx.shipInstance.findUnique({ where: { userId_shipId: { userId, shipId } }, select: { id: true } });
        if (owned) throw conflict("ALREADY_OWNED", "You already own this ship");
      }
      let passSeason: string | null = null;
      if (grants.battlePassPremium) {
        const pass = BATTLE_PASSES.find((p) => p.premiumProductSku === product.sku);
        if (!pass) throw badRequest("PASS_NOT_FOUND", "Battle pass for this product not found");
        const bp = await tx.battlePass.findUnique({ where: { userId_seasonId: { userId, seasonId: pass.seasonId } } });
        if (bp?.premium) throw conflict("ALREADY_OWNED", "Premium battle pass already active");
        passSeason = pass.seasonId;
      }
      if (grants.items?.length) {
        const count = await tx.inventoryItem.count({ where: { userId } });
        if (count >= rules.inventoryHardCap) throw badRequest("INVENTORY_FULL", "Inventory is full");
      }

      const purchase = await tx.purchase.create({
        data: {
          userId,
          productId: product.id,
          quantity: input.quantity,
          currency: product.currency,
          totalPrice: total,
          idempotencyKey: input.idempotencyKey,
        },
      });
      const currency = product.currency as "CREDITS" | "GEMS";
      await post(tx, {
        from: userWallet(userId, currency),
        to: system(currency === Currency.GEMS ? LedgerAccountType.PREMIUM_REVENUE : LedgerAccountType.GAME_SINK, currency),
        amount: total,
        type: LedgerTxType.PURCHASE,
        reference: purchase.id,
        idempotencyKey: `purchase:${purchase.id}`,
        userId,
        metadata: { productId: product.id, sku: product.sku, quantity: input.quantity, unitPrice: product.price.toString() },
      });

      const ref = `purchase:${purchase.id}`;
      for (const shipId of grants.ships ?? []) await grantShip(tx, userId, shipId);
      const items = (grants.items ?? []).map((i) => ({ itemId: i.itemId, quantity: i.quantity * input.quantity }));
      const resources: Record<string, number> = {};
      for (const [k, v] of Object.entries(grants.resources ?? {})) if (typeof v === "number") resources[k] = v * input.quantity;
      await grantBundle(tx, userId, {
        items,
        xp: (grants.xp ?? 0) * input.quantity,
        honor: 0,
        credits: (grants.credits ?? 0) * input.quantity,
        // Gems are never granted by a credit/gem purchase (gem packs require an on-chain deposit).
        passXp: (grants.passXp ?? 0) * input.quantity,
      }, ref, `shop:${product.sku}`);
      if (Object.keys(resources).length) await addResources(tx, userId, resources);
      if (grants.premium) {
        const now = Date.now();
        const activeUntil = user.premiumUntil && user.premiumUntil.getTime() > now ? user.premiumUntil.getTime() : now;
        const keepTier = user.premiumUntil && user.premiumUntil.getTime() > now && (PREMIUM_RANK[user.premiumTier] ?? 0) > (PREMIUM_RANK[grants.premium.tier] ?? 0);
        await tx.user.update({
          where: { id: userId },
          data: { premiumTier: keepTier ? user.premiumTier : grants.premium.tier, premiumUntil: new Date(activeUntil + grants.premium.days * 86_400_000) },
        });
      }
      if (passSeason) {
        const pass = BATTLE_PASSES.find((p) => p.seasonId === passSeason);
        await tx.battlePass.upsert({
          where: { userId_seasonId: { userId, seasonId: passSeason } },
          create: { userId, seasonId: passSeason, passId: pass?.id ?? passSeason, premium: true },
          update: { premium: true },
        });
      }
      return purchase.id;
    });
    return { purchaseId, balances: await balancesDto(db, userId), duplicate: false };
  } catch (err) {
    // Concurrent duplicate with the same idempotency key: the other transaction won.
    if ((err as { code?: string }).code === "P2002") {
      const again = await existingPurchase(db, userId, input.idempotencyKey);
      if (again && again.productId === input.productId) return { purchaseId: again.id, balances: await balancesDto(db, userId), duplicate: true };
    }
    throw err;
  }
}
