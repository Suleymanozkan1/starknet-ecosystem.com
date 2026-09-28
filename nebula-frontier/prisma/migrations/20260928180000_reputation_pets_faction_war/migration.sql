-- CreateTable
CREATE TABLE "FactionSeasonScore" (
    "factionId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "score" BIGINT NOT NULL DEFAULT 0,
    "kills" BIGINT NOT NULL DEFAULT 0,
    "pvpScore" BIGINT NOT NULL DEFAULT 0,
    "resources" BIGINT NOT NULL DEFAULT 0,
    "bossKills" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FactionSeasonScore_pkey" PRIMARY KEY ("factionId","seasonId")
);

-- CreateIndex
CREATE INDEX "FactionSeasonScore_seasonId_score_idx" ON "FactionSeasonScore"("seasonId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "Pet_userId_petId_key" ON "Pet"("userId", "petId");

