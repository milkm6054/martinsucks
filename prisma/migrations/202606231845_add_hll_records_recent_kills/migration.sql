CREATE TYPE "HllRecordsFetchStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

CREATE TABLE "HllRecordsServer" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "fetchStatus" "HllRecordsFetchStatus" NOT NULL DEFAULT 'PENDING',
  "fetchError" TEXT,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HllRecordsServer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HllRecentKillMatch" (
  "id" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "playerName" TEXT NOT NULL,
  "profileUrl" TEXT NOT NULL,
  "steamId" TEXT,
  "kills" INTEGER NOT NULL,
  "kpm" DOUBLE PRECISION,
  "kd" DOUBLE PRECISION,
  "weapon" TEXT,
  "mapName" TEXT,
  "duration" TEXT,
  "playedOn" TEXT,
  "playedAt" TIMESTAMP(3),
  "sourceOrder" INTEGER NOT NULL,
  "rawLines" TEXT[],
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HllRecentKillMatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HllRecordsServer_sourceUrl_key" ON "HllRecordsServer"("sourceUrl");
CREATE INDEX "HllRecentKillMatch_serverId_sourceOrder_idx" ON "HllRecentKillMatch"("serverId", "sourceOrder");
CREATE INDEX "HllRecentKillMatch_steamId_idx" ON "HllRecentKillMatch"("steamId");

ALTER TABLE "HllRecentKillMatch"
ADD CONSTRAINT "HllRecentKillMatch_serverId_fkey"
FOREIGN KEY ("serverId") REFERENCES "HllRecordsServer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
