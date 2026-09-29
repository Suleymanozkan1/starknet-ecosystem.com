/**
 * Server-side reward bundle application (quests, achievements, mail, battle pass, crafting...).
 * Must run inside the caller's transaction, after the caller has atomically claimed the source
 * (e.g. `claimedAt IS NULL` conditional update) — every ledger leg and item grant is additionally
 * keyed by `ref`, so a replay can never double-grant.
 */
import { BATTLE_PASSES } from "@nebula/config";
import { post, system, userWallet, type Db, type Tx } from "@nebula/database";
import { Currency, LedgerAccountType, LedgerTxType, type RewardBundle, type RewardSource } from "@nebula/shared";
import { badRequest } from "../errors.js";
import { getCatalog } from "./catalog.js";
import { grantItems } from "./inventory.js";
import { levelFor, rankOf } from "./progression.js";

export interface GrantResult {
  items: string[];
  levelBefore: number;
  levelAfter: number;
  crypto: { source: RewardSource; weight: number } | null;
}

export async function activeSeasonId(tx: Tx | Db): Promise<string | null> {
  const now = new Date();
  const s = await tx.season.findFirst({
    where: { active: true, startAt: { lte: now }, endAt: { gte: now } },
    orderBy: { startAt: "desc" },
    select: { id: true },
  });
  return s?.id ?? null;
}

export function passTierForXp(passId: string, xp: number): number {
  const pass = BATTLE_PASSES.find((p) => p.id === passId);
  if (!pass) return 0;
  let tier = 0;
  for (const t of pass.tiers) if (xp >= t.xpRequired) tier = t.tier;
  return tier;
}

export async function addPassXp(tx: Tx, userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const seasonId = await activeSeasonId(tx);
  if (!seasonId) return;
  const pass = BATTLE_PASSES.find((p) => p.seasonId === seasonId);
  if (!pass) return;
  const bp = await tx.battlePass.upsert({
    where: { userId_seasonId: { userId, seasonId } },
    create: { userId, seasonId, passId: pass.id, xp: amount },
    update: { xp: { increment: amount } },
  });
  const tier = passTierForXp(pass.id, bp.xp);
  if (tier !== bp.tier) await tx.battlePass.update({ where: { id: bp.id }, data: { tier } });
}

export async function addXpHonor(tx: Tx, userId: string, xp: number, honor: number): Promise<{ before: number; after: number }> {
  const u = await tx.user.update({
    where: { id: userId },
    data: {
      ...(xp > 0 ? { xp: { increment: BigInt(Math.floor(xp)) } } : {}),
      ...(honor > 0 ? { honor: { increment: BigInt(Math.floor(honor)) } } : {}),
    },
    select: { xp: true, honor: true, level: true, rank: true },
  });
  const level = Math.max(u.level, levelFor(u.xp));
  const rank = rankOf(u.honor, level).id;
  if (level !== u.level || rank !== u.rank) await tx.user.update({ where: { id: userId }, data: { level, rank } });
  return { before: u.level, after: level };
}

export async function addResources(tx: Tx, userId: string, resources: Partial<Record<string, number>>): Promise<void> {
  for (const [resourceId, amt] of Object.entries(resources)) {
    if (!amt || amt <= 0) continue;
    await tx.playerResource.upsert({
      where: { userId_resourceId: { userId, resourceId } },
      create: { userId, resourceId, amount: BigInt(amt) },
      update: { amount: { increment: BigInt(amt) } },
    });
  }
}

/** Atomically consume resources; throws INSUFFICIENT_RESOURCES if any is short. */
export async function consumeResources(tx: Tx, userId: string, resources: Partial<Record<string, number>>): Promise<void> {
  for (const [resourceId, amt] of Object.entries(resources)) {
    if (!amt || amt <= 0) continue;
    const r = await tx.playerResource.updateMany({
      where: { userId, resourceId, amount: { gte: BigInt(amt) } },
      data: { amount: { decrement: BigInt(amt) } },
    });
    if (r.count !== 1) throw badRequest("INSUFFICIENT_RESOURCES", `Not enough ${resourceId}`);
  }
}

export async function grantBundle(tx: Tx, userId: string, bundle: RewardBundle, ref: string, reason: string): Promise<GrantResult> {
  const out: GrantResult = { items: [], levelBefore: 0, levelAfter: 0, crypto: null };
  if (bundle.credits && bundle.credits > 0) {
    await post(tx, {
      from: system(LedgerAccountType.GAME_ISSUANCE, Currency.CREDITS),
      to: userWallet(userId, Currency.CREDITS),
      amount: BigInt(Math.floor(bundle.credits)),
      type: LedgerTxType.GAME_REWARD,
      reference: ref,
      idempotencyKey: `${ref}:credits`,
      userId,
      metadata: { reason },
    });
  }
  if (bundle.gems && bundle.gems > 0) {
    await post(tx, {
      from: system(LedgerAccountType.GAME_ISSUANCE, Currency.GEMS),
      to: userWallet(userId, Currency.GEMS),
      amount: BigInt(Math.floor(bundle.gems)),
      type: LedgerTxType.GAME_REWARD,
      reference: ref,
      idempotencyKey: `${ref}:gems`,
      userId,
      metadata: { reason },
    });
  }
  const lv = await addXpHonor(tx, userId, bundle.xp ?? 0, bundle.honor ?? 0);
  out.levelBefore = lv.before;
  out.levelAfter = lv.after;
  if (bundle.seasonPoints && bundle.seasonPoints > 0) {
    await tx.user.update({ where: { id: userId }, data: { seasonScore: { increment: BigInt(Math.floor(bundle.seasonPoints)) } } });
  }
  await addPassXp(tx, userId, bundle.passXp ?? 0);
  if (bundle.resources) await addResources(tx, userId, bundle.resources);
  if (bundle.items?.length) {
    const { items } = await getCatalog(tx);
    out.items = await grantItems(tx, userId, bundle.items, ref, items);
  }
  if (bundle.cryptoEligible) out.crypto = bundle.cryptoEligible;
  return out;
}
