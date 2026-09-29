-- Non-destructive: durable upgrade-attempt idempotency records + reward settlement outbox (additive tables only).
-- CreateTable
CREATE TABLE "UpgradeAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "fromLevel" INTEGER NOT NULL,
    "toLevel" INTEGER NOT NULL,
    "cost" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpgradeAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardSettlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "result" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UpgradeAttempt_targetId_idx" ON "UpgradeAttempt"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "UpgradeAttempt_userId_kind_idempotencyKey_key" ON "UpgradeAttempt"("userId", "kind", "idempotencyKey");

-- CreateIndex
CREATE INDEX "RewardSettlement_status_nextAttemptAt_idx" ON "RewardSettlement"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "RewardSettlement_userId_source_sourceRef_key" ON "RewardSettlement"("userId", "source", "sourceRef");

-- AddForeignKey
ALTER TABLE "UpgradeAttempt" ADD CONSTRAINT "UpgradeAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardSettlement" ADD CONSTRAINT "RewardSettlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

