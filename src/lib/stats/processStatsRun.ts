import { PlayerStatsFetchStatus, StatsRunStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchHllRecordStats } from "@/lib/stats/hllRecords";

const PLAYER_DELAY_MS = 1500;
const BATCH_SIZE = 8;
const BATCH_PAUSE_MS = 12000;

const activeRunIds = new Set<string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  try {
    const run = await prisma.statsRun.findUnique({
      where: { id: runId },
      include: {
        items: {
          orderBy: {
            position: "asc",
          },
        },
      },
    });

    if (!run) {
      return;
    }

    for (let index = 0; index < run.items.length; index += 1) {
      const item = run.items[index];

      await prisma.statsRunItem.update({
        where: { id: item.id },
        data: {
          status: PlayerStatsFetchStatus.RUNNING,
          error: null,
          startedAt: new Date(),
        },
      });

      try {
        const stats = await fetchHllRecordStats(item.steamId64);

        await prisma.$transaction([
          prisma.playerExternalStat.upsert({
            where: {
              playerId: item.playerId,
            },
            update: {
              kpm180: stats.kpm180,
              duelStrength180: stats.duelStrength180,
              sourceUrl: stats.sourceUrl,
              sourceFetchedAt: new Date(),
              fetchStatus: PlayerStatsFetchStatus.COMPLETED,
              fetchError: null,
            },
            create: {
              playerId: item.playerId,
              kpm180: stats.kpm180,
              duelStrength180: stats.duelStrength180,
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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown scrape error.";

        await prisma.$transaction([
          prisma.playerExternalStat.upsert({
            where: {
              playerId: item.playerId,
            },
            update: {
              kpm180: null,
              duelStrength180: null,
              sourceUrl: item.steamId64 ? `https://hllrecords.com/profiles/${item.steamId64}?period=180d&comp=` : null,
              sourceFetchedAt: new Date(),
              fetchStatus: PlayerStatsFetchStatus.FAILED,
              fetchError: message,
            },
            create: {
              playerId: item.playerId,
              sourceUrl: item.steamId64 ? `https://hllrecords.com/profiles/${item.steamId64}?period=180d&comp=` : null,
              sourceFetchedAt: new Date(),
              fetchStatus: PlayerStatsFetchStatus.FAILED,
              fetchError: message,
            },
          }),
          prisma.statsRunItem.update({
            where: { id: item.id },
            data: {
              status: PlayerStatsFetchStatus.FAILED,
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

      const isLastItem = index === run.items.length - 1;
      if (isLastItem) {
        continue;
      }

      const completedThisBatch = (index + 1) % BATCH_SIZE === 0;
      await delay(completedThisBatch ? BATCH_PAUSE_MS : PLAYER_DELAY_MS);
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
