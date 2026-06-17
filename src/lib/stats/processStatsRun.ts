import { PlayerStatsFetchStatus, StatsRunSpeed, StatsRunStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchHllRecordStatsBatch, type HllRecordStatResult } from "@/lib/stats/hllRecords";

const MAX_CONSECUTIVE_RETRYABLE_FAILURES = 4;

const activeRunIds = new Set<string>();

type SpeedConfig = {
  scrapeBatchSize: number;
  playerDelayMs: number;
  batchPauseEvery: number;
  batchPauseMs: number;
  retryableFailureCooldownMs: number;
};

const SPEED_ORDER: StatsRunSpeed[] = [StatsRunSpeed.SLOW, StatsRunSpeed.NORMAL, StatsRunSpeed.FAST];

const SPEED_CONFIG: Record<StatsRunSpeed, SpeedConfig> = {
  SLOW: {
    scrapeBatchSize: 2,
    playerDelayMs: 1500,
    batchPauseEvery: 6,
    batchPauseMs: 12000,
    retryableFailureCooldownMs: 90000,
  },
  NORMAL: {
    scrapeBatchSize: 4,
    playerDelayMs: 900,
    batchPauseEvery: 8,
    batchPauseMs: 9000,
    retryableFailureCooldownMs: 60000,
  },
  FAST: {
    scrapeBatchSize: 6,
    playerDelayMs: 350,
    batchPauseEvery: 10,
    batchPauseMs: 4500,
    retryableFailureCooldownMs: 30000,
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSourceUrl(steamId64: string): string | null {
  return steamId64 ? `https://hllrecords.com/profiles/${steamId64}?period=180d&comp=` : null;
}

function getSpeedConfig(speedProfile: StatsRunSpeed): SpeedConfig {
  return SPEED_CONFIG[speedProfile] ?? SPEED_CONFIG.NORMAL;
}

function getNextSlowerSpeedInternal(speedProfile: StatsRunSpeed): StatsRunSpeed | null {
  const currentIndex = SPEED_ORDER.indexOf(speedProfile);
  return currentIndex > 0 ? SPEED_ORDER[currentIndex - 1] : null;
}

export function getNextFasterSpeed(speedProfile: StatsRunSpeed): StatsRunSpeed | null {
  const currentIndex = SPEED_ORDER.indexOf(speedProfile);
  return currentIndex >= 0 && currentIndex < SPEED_ORDER.length - 1 ? SPEED_ORDER[currentIndex + 1] : null;
}

export function getNextSlowerSpeed(speedProfile: StatsRunSpeed): StatsRunSpeed | null {
  return getNextSlowerSpeedInternal(speedProfile);
}

function isRetryableInfrastructureError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cannot fork") ||
    normalized.includes("target page, context or browser has been closed") ||
    normalized.includes("browsertype.launch") ||
    normalized.includes("failed to launch browser") ||
    normalized.includes("unable to launch browser") ||
    normalized.includes("spawn") ||
    normalized.includes("sigtrap") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout")
  );
}

function isUnknownProfileError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unable to extract stats. page title was: hllrecords") ||
    normalized.includes("page title was: hllrecords") ||
    normalized.includes("hell let loose com")
  );
}

async function requeueItemsForRetry(items: Array<{ id: string }>, message: string) {
  await prisma.$transaction(
    items.map((item) =>
      prisma.statsRunItem.update({
        where: { id: item.id },
        data: {
          status: PlayerStatsFetchStatus.PENDING,
          error: message,
          startedAt: null,
          finishedAt: null,
        },
      }),
    ),
  );
}

async function markItemCompleted(runId: string, item: { id: string; playerId: string }, stats: HllRecordStatResult) {
  await prisma.$transaction([
    prisma.playerExternalStat.upsert({
      where: {
        playerId: item.playerId,
      },
      update: {
        kpm180: stats.kpm180,
        duelStrength180: stats.duelStrength180,
        mainRole: stats.mainRole,
        sourceUrl: stats.sourceUrl,
        sourceFetchedAt: new Date(),
        fetchStatus: PlayerStatsFetchStatus.COMPLETED,
        fetchError: null,
      },
      create: {
        playerId: item.playerId,
        kpm180: stats.kpm180,
        duelStrength180: stats.duelStrength180,
        mainRole: stats.mainRole,
        sourceUrl: stats.sourceUrl,
        sourceFetchedAt: new Date(),
        fetchStatus: PlayerStatsFetchStatus.COMPLETED,
      },
    }),
    prisma.statsRunItem.update({
      where: { id: item.id },
      data: {
        status: PlayerStatsFetchStatus.COMPLETED,
        kpm180: stats.kpm180,
        duelStrength180: stats.duelStrength180,
        mainRole: stats.mainRole,
        error: null,
        finishedAt: new Date(),
      },
    }),
    prisma.statsRun.update({
      where: { id: runId },
      data: {
        processedPlayers: {
          increment: 1,
        },
        successPlayers: {
          increment: 1,
        },
      },
    }),
  ]);
}

async function markItemFailed(
  runId: string,
  item: { id: string; playerId: string; steamId64: string },
  message: string,
) {
  await prisma.$transaction([
    prisma.playerExternalStat.upsert({
      where: {
        playerId: item.playerId,
      },
      update: {
        kpm180: null,
        duelStrength180: null,
        mainRole: null,
        sourceUrl: buildSourceUrl(item.steamId64),
        sourceFetchedAt: new Date(),
        fetchStatus: PlayerStatsFetchStatus.FAILED,
        fetchError: message,
      },
      create: {
        playerId: item.playerId,
        mainRole: null,
        sourceUrl: buildSourceUrl(item.steamId64),
        sourceFetchedAt: new Date(),
        fetchStatus: PlayerStatsFetchStatus.FAILED,
        fetchError: message,
      },
    }),
    prisma.statsRunItem.update({
      where: { id: item.id },
      data: {
        status: PlayerStatsFetchStatus.FAILED,
        mainRole: null,
        error: message,
        finishedAt: new Date(),
      },
    }),
    prisma.statsRun.update({
      where: { id: runId },
      data: {
        processedPlayers: {
          increment: 1,
        },
        failedPlayers: {
          increment: 1,
        },
      },
    }),
  ]);
}

async function markItemUnknown(
  runId: string,
  item: { id: string; playerId: string; steamId64: string },
  message: string,
) {
  await prisma.$transaction([
    prisma.playerExternalStat.upsert({
      where: {
        playerId: item.playerId,
      },
      update: {
        kpm180: null,
        duelStrength180: null,
        mainRole: null,
        sourceUrl: buildSourceUrl(item.steamId64),
        sourceFetchedAt: new Date(),
        fetchStatus: PlayerStatsFetchStatus.UNKNOWN,
        fetchError: message,
      },
      create: {
        playerId: item.playerId,
        mainRole: null,
        sourceUrl: buildSourceUrl(item.steamId64),
        sourceFetchedAt: new Date(),
        fetchStatus: PlayerStatsFetchStatus.UNKNOWN,
        fetchError: message,
      },
    }),
    prisma.statsRunItem.update({
      where: { id: item.id },
      data: {
        status: PlayerStatsFetchStatus.UNKNOWN,
        mainRole: null,
        error: message,
        finishedAt: new Date(),
      },
    }),
    prisma.statsRun.update({
      where: { id: runId },
      data: {
        processedPlayers: {
          increment: 1,
        },
      },
    }),
  ]);
}

export function startStatsRunProcessing(runId: string): void {
  if (activeRunIds.has(runId)) {
    return;
  }

  activeRunIds.add(runId);
  void processStatsRun(runId).finally(() => {
    activeRunIds.delete(runId);
  });
}

async function processStatsRun(runId: string): Promise<void> {
  let consecutiveRetryableFailures = 0;

  try {
    while (true) {
      const run = await prisma.statsRun.findUnique({
        where: { id: runId },
        include: {
          items: {
            where: {
              status: PlayerStatsFetchStatus.PENDING,
            },
            orderBy: {
              position: "asc",
            },
            take: 20,
          },
        },
      });

      if (!run) {
        return;
      }

      if (run.status === StatsRunStatus.PAUSED) {
        return;
      }

      if (run.status !== StatsRunStatus.RUNNING) {
        return;
      }

      const speedConfig = getSpeedConfig(run.speedProfile);
      const items = run.items.slice(0, speedConfig.scrapeBatchSize);
      if (items.length === 0) {
        break;
      }

      const startedAt = new Date();

      await prisma.$transaction(
        items.map((item) =>
          prisma.statsRunItem.update({
            where: { id: item.id },
            data: {
              status: PlayerStatsFetchStatus.RUNNING,
              error: null,
              startedAt,
            },
          }),
        ),
      );

      try {
        const statsBySteamId = await fetchHllRecordStatsBatch(items.map((item) => item.steamId64));
        consecutiveRetryableFailures = 0;

        for (const item of items) {
          const result = statsBySteamId.get(item.steamId64);

          if (result instanceof Error || !result) {
            const message = result?.message || "No scraper result was returned.";
            if (isUnknownProfileError(message)) {
              await markItemUnknown(runId, item, message);
              continue;
            }

            await markItemFailed(runId, item, message);
            continue;
          }

          await markItemCompleted(runId, item, result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown scrape error.";

        if (isRetryableInfrastructureError(message)) {
          consecutiveRetryableFailures += 1;
          const slowerSpeed = getNextSlowerSpeedInternal(run.speedProfile);

          if (slowerSpeed) {
            await prisma.statsRun.update({
              where: { id: runId },
              data: {
                speedProfile: slowerSpeed,
              },
            });
          }

          await requeueItemsForRetry(
            items,
            `Temporary runner issue. Cooling down before retry. Last error: ${message}${slowerSpeed ? ` Auto-slowed to ${slowerSpeed}.` : ""}`,
          );

          if (consecutiveRetryableFailures >= MAX_CONSECUTIVE_RETRYABLE_FAILURES) {
            await prisma.statsRun.update({
              where: { id: runId },
              data: {
                status: StatsRunStatus.PAUSED,
              },
            });
            return;
          }

          await delay(speedConfig.retryableFailureCooldownMs);
          continue;
        }

        consecutiveRetryableFailures = 0;

        for (const item of items) {
          if (isUnknownProfileError(message)) {
            await markItemUnknown(runId, item, message);
            continue;
          }

          await markItemFailed(runId, item, message);
        }
      }

      const refreshedRun = await prisma.statsRun.findUnique({
        where: { id: runId },
        select: {
          status: true,
          processedPlayers: true,
          speedProfile: true,
        },
      });

      if (!refreshedRun || refreshedRun.status === StatsRunStatus.PAUSED) {
        return;
      }

      if (refreshedRun.status !== StatsRunStatus.RUNNING) {
        return;
      }

      const refreshedSpeedConfig = getSpeedConfig(refreshedRun.speedProfile);
      const completedThisBatch = refreshedRun.processedPlayers % refreshedSpeedConfig.batchPauseEvery === 0;
      await delay(completedThisBatch ? refreshedSpeedConfig.batchPauseMs : refreshedSpeedConfig.playerDelayMs);
    }

    await prisma.statsRun.update({
      where: { id: runId },
      data: {
        status: StatsRunStatus.COMPLETED,
        finishedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.statsRun.update({
      where: { id: runId },
      data: {
        status: StatsRunStatus.FAILED,
        finishedAt: new Date(),
      },
    });

    throw error;
  }
}
