CREATE TYPE "HllPoachStatus" AS ENUM ('NEW', 'MESSAGED', 'SECURED', 'ROSTERED');

CREATE TABLE "HllPoachPlayerStatus" (
    "id" TEXT NOT NULL,
    "steamId" TEXT NOT NULL,
    "status" "HllPoachStatus" NOT NULL DEFAULT 'NEW',
    "teamId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HllPoachPlayerStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HllPoachPlayerStatus_steamId_key" ON "HllPoachPlayerStatus"("steamId");
CREATE INDEX "HllPoachPlayerStatus_status_idx" ON "HllPoachPlayerStatus"("status");
CREATE INDEX "HllPoachPlayerStatus_teamId_idx" ON "HllPoachPlayerStatus"("teamId");

ALTER TABLE "HllPoachPlayerStatus"
ADD CONSTRAINT "HllPoachPlayerStatus_teamId_fkey"
FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
