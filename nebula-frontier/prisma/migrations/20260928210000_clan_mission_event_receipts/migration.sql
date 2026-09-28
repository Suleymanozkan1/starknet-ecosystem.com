-- Non-destructive: idempotency receipts for game-server clan-mission progress events (one per mission + event id).
-- CreateTable
CREATE TABLE "ClanMissionEventReceipt" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClanMissionEventReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClanMissionEventReceipt_createdAt_idx" ON "ClanMissionEventReceipt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClanMissionEventReceipt_missionId_eventId_key" ON "ClanMissionEventReceipt"("missionId", "eventId");

-- AddForeignKey
ALTER TABLE "ClanMissionEventReceipt" ADD CONSTRAINT "ClanMissionEventReceipt_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "ClanMission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

