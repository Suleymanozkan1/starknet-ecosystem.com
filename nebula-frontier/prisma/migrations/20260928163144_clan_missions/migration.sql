-- CreateTable
CREATE TABLE "ClanMission" (
    "id" TEXT NOT NULL,
    "clanId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL DEFAULT 'once',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "progress" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "baseline" JSONB NOT NULL DEFAULT '{}',
    "contributions" JSONB NOT NULL DEFAULT '{}',
    "startedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "ClanMission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClanMission_status_idx" ON "ClanMission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ClanMission_clanId_questId_periodKey_key" ON "ClanMission"("clanId", "questId", "periodKey");

-- AddForeignKey
ALTER TABLE "ClanMission" ADD CONSTRAINT "ClanMission_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
