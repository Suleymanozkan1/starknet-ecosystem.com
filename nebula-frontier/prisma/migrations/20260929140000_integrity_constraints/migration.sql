-- Integrity hardening (CodeRabbit PR #8). Additive constraints only; nothing is dropped or deleted.
-- 1) Money-bearing tables no longer cascade (or SET NULL) on user delete: ledger history, deposits,
--    withdrawals (signature replay guards), rewards and purchases must survive; account closure is a
--    soft delete / anonymization, never a row delete.
-- 2) Gear instances follow their InventoryItem; faction season standings must reference a real
--    faction and season. If orphan rows exist, adding these FKs fails and the migration stops so an
--    operator can inspect them (it never deletes data on its own).
-- 3) Database-level ledger invariants as defence in depth behind @nebula/database `post`.

-- DropForeignKey
ALTER TABLE "BalanceAccount" DROP CONSTRAINT "BalanceAccount_userId_fkey";

-- DropForeignKey
ALTER TABLE "BalanceLedger" DROP CONSTRAINT "BalanceLedger_userId_fkey";

-- DropForeignKey
ALTER TABLE "Deposit" DROP CONSTRAINT "Deposit_userId_fkey";

-- DropForeignKey
ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_userId_fkey";

-- DropForeignKey
ALTER TABLE "Reward" DROP CONSTRAINT "Reward_userId_fkey";

-- DropForeignKey
ALTER TABLE "RewardClaim" DROP CONSTRAINT "RewardClaim_userId_fkey";

-- DropForeignKey
ALTER TABLE "RewardLiability" DROP CONSTRAINT "RewardLiability_userId_fkey";

-- DropForeignKey
ALTER TABLE "RewardSettlement" DROP CONSTRAINT "RewardSettlement_userId_fkey";

-- DropForeignKey
ALTER TABLE "Withdrawal" DROP CONSTRAINT "Withdrawal_userId_fkey";

-- AddForeignKey
ALTER TABLE "FactionSeasonScore" ADD CONSTRAINT "FactionSeasonScore_factionId_fkey" FOREIGN KEY ("factionId") REFERENCES "Faction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactionSeasonScore" ADD CONSTRAINT "FactionSeasonScore_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeaponInstance" ADD CONSTRAINT "WeaponInstance_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleInstance" ADD CONSTRAINT "ModuleInstance_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DroneInstance" ADD CONSTRAINT "DroneInstance_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceAccount" ADD CONSTRAINT "BalanceAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceLedger" ADD CONSTRAINT "BalanceLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardSettlement" ADD CONSTRAINT "RewardSettlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardClaim" ADD CONSTRAINT "RewardClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLiability" ADD CONSTRAINT "RewardLiability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Ledger invariants: positive amounts between two distinct accounts, no overdraft on accounts that
-- may not go negative, withdrawal amounts consistent with the fee formula (final = requested -
-- serviceFee - networkFee, see packages/economy/src/fees.ts), and immutable journal rows
-- (corrections are compensating entries).
ALTER TABLE "BalanceLedger"
  ADD CONSTRAINT "BalanceLedger_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "BalanceLedger_distinct_accounts" CHECK ("debitAccountId" <> "creditAccountId");

ALTER TABLE "BalanceAccount"
  ADD CONSTRAINT "BalanceAccount_non_negative" CHECK ("allowNegative" OR "balance" >= 0);

ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_amounts_valid"
  CHECK ("requested" > 0 AND "serviceFee" >= 0 AND "networkFee" >= 0 AND "final" > 0
         AND "final" = "requested" - "serviceFee" - "networkFee");

-- Kept on one line: tooling that splits migration files on ";<newline>" must not cut the body.
CREATE OR REPLACE FUNCTION balance_ledger_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'BalanceLedger rows are immutable (use a compensating entry)'; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER "BalanceLedger_no_update_delete"
  BEFORE UPDATE OR DELETE ON "BalanceLedger"
  FOR EACH ROW EXECUTE FUNCTION balance_ledger_immutable();
