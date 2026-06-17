DO $$
BEGIN
  ALTER TYPE "StatsRunStatus" ADD VALUE 'PAUSED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
