import { HllRecordsFetchStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { fetchHllRecentKills, normalizeHllRecordsServerUrl } from "@/lib/stats/hllRecentKills";

type HllRecordsServerWithResults = Awaited<ReturnType<typeof loadHllRecordsServers>>[number];

export function serializeHllRecordsServer(server: HllRecordsServerWithResults) {
  return {
    id: server.id,
    name: server.name,
    sourceUrl: server.sourceUrl,
    fetchStatus: server.fetchStatus,
    fetchError: server.fetchError,
    lastRunAt: server.lastRunAt?.toISOString() ?? null,
    createdAt: server.createdAt.toISOString(),
    results: server.results.map((result) => ({
      id: result.id,
      playerName: result.playerName,
      profileUrl: result.profileUrl,
      steamId: result.steamId,
      kills: result.kills,
      kpm: result.kpm,
      kd: result.kd,
      weapon: result.weapon,
      mapName: result.mapName,
      duration: result.duration,
      playedOn: result.playedOn,
      playedAt: result.playedAt?.toISOString() ?? null,
      sourceOrder: result.sourceOrder,
      rawLines: result.rawLines,
      fetchedAt: result.fetchedAt.toISOString(),
    })),
  };
}

export async function loadHllRecordsServers() {
  return prisma.hllRecordsServer.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: {
      results: {
        orderBy: [{ sourceOrder: "asc" }],
      },
    },
  });
}

export async function refreshHllRecordsServer(serverId: string) {
  const server = await prisma.hllRecordsServer.findUnique({
    where: { id: serverId },
  });

  if (!server) {
    throw new Error("HLLRecords server not found.");
  }

  await prisma.hllRecordsServer.update({
    where: { id: server.id },
    data: {
      fetchStatus: HllRecordsFetchStatus.RUNNING,
      fetchError: null,
    },
  });

  try {
    const scrape = await fetchHllRecentKills(server.sourceUrl);
    const fetchedAt = new Date();

    return await prisma.$transaction(async (tx) => {
      await tx.hllRecentKillMatch.deleteMany({
        where: { serverId: server.id },
      });

      if (scrape.results.length > 0) {
        await tx.hllRecentKillMatch.createMany({
          data: scrape.results.map((result) => ({
            serverId: server.id,
            playerName: result.playerName,
            profileUrl: result.profileUrl,
            steamId: result.steamId || null,
            kills: result.kills,
            kpm: result.kpm ?? null,
            kd: result.kd ?? null,
            weapon: result.weapon ?? null,
            mapName: result.mapName ?? null,
            duration: result.duration ?? null,
            playedOn: result.playedOn ?? null,
            playedAt: result.playedAt ? new Date(result.playedAt) : null,
            sourceOrder: result.sourceOrder,
            rawLines: result.rawLines,
            fetchedAt,
          })),
        });
      }

      return tx.hllRecordsServer.update({
        where: { id: server.id },
        data: {
          sourceUrl: normalizeHllRecordsServerUrl(scrape.sourceUrl || server.sourceUrl),
          fetchStatus: HllRecordsFetchStatus.COMPLETED,
          fetchError: null,
          lastRunAt: fetchedAt,
        },
        include: {
          results: {
            orderBy: [{ sourceOrder: "asc" }],
          },
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch recent 100+ kill matches.";
    await prisma.hllRecordsServer.update({
      where: { id: server.id },
      data: {
        fetchStatus: HllRecordsFetchStatus.FAILED,
        fetchError: message,
        lastRunAt: new Date(),
      },
    });
    throw new Error(message);
  }
}
