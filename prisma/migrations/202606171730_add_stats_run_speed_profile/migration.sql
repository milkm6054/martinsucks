CREATE TYPE "StatsRunSpeed" AS ENUM ('SLOW', 'NORMAL', 'FAST');

ALTER TABLE "StatsRun"
ADD COLUMN "speedProfile" "StatsRunSpeed" NOT NULL DEFAULT 'FAST';
