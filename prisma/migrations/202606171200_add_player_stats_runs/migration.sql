DO $$
BEGIN
  CREATE TYPE "StatsRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "PlayerStatsFetchStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PlayerExternalStat" (
  "id" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "kpm180" DOUBLE PRECISION,
  "duelStrength180" DOUBLE PRECISION,
  "sourceUrl" TEXT,
  "sourceFetchedAt" TIMESTAMP(3),
  "fetchStatus" "PlayerStatsFetchStatus" NOT NULL DEFAULT 'PENDING',
  "fetchError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerExternalStat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatsRun" (
  "id" TEXT NOT NULL,
  "status" "StatsRunStatus" NOT NULL DEFAULT 'RUNNING',
  "requestedBy" TEXT,
  "totalPlayers" INTEGER NOT NULL DEFAULT 0,
  "processedPlayers" INTEGER NOT NULL DEFAULT 0,
  "successPlayers" INTEGER NOT NULL DEFAULT 0,
  "failedPlayers" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StatsRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StatsRunItem" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "steamId64" TEXT NOT NULL,
  "displayName" TEXT,
  "teamNames" TEXT[],
  "position" INTEGER NOT NULL,
  "status" "PlayerStatsFetchStatus" NOT NULL DEFAULT 'PENDING',
  "kpm180" DOUBLE PRECISION,
  "duelStrength180" DOUBLE PRECISION,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StatsRunItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlayerExternalStat_playerId_key" ON "PlayerExternalStat"("playerId");
CREATE INDEX IF NOT EXISTS "StatsRun_status_startedAt_idx" ON "StatsRun"("status", "startedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "StatsRunItem_runId_playerId_key" ON "StatsRunItem"("runId", "playerId");
CREATE INDEX IF NOT EXISTS "StatsRunItem_runId_position_idx" ON "StatsRunItem"("runId", "position");
CREATE INDEX IF NOT EXISTS "StatsRunItem_playerId_idx" ON "StatsRunItem"("playerId");

DO $$
BEGIN
  ALTER TABLE "PlayerExternalStat"
    ADD CONSTRAINT "PlayerExternalStat_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "StatsRunItem"
    ADD CONSTRAINT "StatsRunItem_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "StatsRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "StatsRunItem"
    ADD CONSTRAINT "StatsRunItem_playerId_fkey"
    FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
