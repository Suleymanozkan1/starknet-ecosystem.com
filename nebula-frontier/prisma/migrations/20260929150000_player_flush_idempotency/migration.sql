-- Non-destructive: durable idempotency for game-server player flushes (new table only).
-- CreateTable
CREATE TABLE "PlayerFlush" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerFlush_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlayerFlush_userId_createdAt_idx" ON "PlayerFlush"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlayerFlush" ADD CONSTRAINT "PlayerFlush_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
