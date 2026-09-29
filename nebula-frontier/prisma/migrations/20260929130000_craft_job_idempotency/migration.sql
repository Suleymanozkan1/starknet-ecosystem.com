-- Non-destructive: durable craft-start idempotency (nullable column + unique index; existing rows keep NULL).
-- AlterTable
ALTER TABLE "CraftJob" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CraftJob_userId_idempotencyKey_key" ON "CraftJob"("userId", "idempotencyKey");
