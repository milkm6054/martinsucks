import { HllRecordsFetchStatus, RosterEntryStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  fetchHllRecentKills,
  HllRecentKillScrapeResult,
  normalizeHllRecordsServerUrl,
} from "@/lib/stats/hllRecentKills";

type HllRecordsServerWithResults = Awaited<ReturnType<typeof queryHllRecordsServers>>[number];
type HllRecordsResultWithRosterFlags = HllRecordsServerWithResults["results"][number] & {
  isFreePlayer: boolean;
  rosterTeamNames: string[];
};
type HllRecordsServerWithRosterFlags = Omit<HllRecordsServerWithResults, "results"> & {
  results: HllRecordsResultWithRosterFlags[];
};

const NON_GUN_WEAPON_PATTERNS = [
  /\barty\b/i,
  /\bartillery\b/i,
  /\bcannon\b/i,
  /\bhowitzer\b/i,
  /\bmortar\b/i,
  /\brocket\b/i,
  /\btank\b/i,
  /\bpanzer\b/i,
  /\bsherman\b/i,
  /\bstuart\b/i,
  /\bluchs\b/i,
  /\bpuma\b/i,
  /\bgreyhound\b/i,
  /\bhalf-?track\b/i,
  /\bsdkfz\b/i,
  /\bsd\.?kfz\b/i,
  /\b75mm\b/i,
  /\b76mm\b/i,
  /\b88mm\b/i,
];

function isGunWeapon(weaponValue: string | null | undefined) {
  const weapon = weaponValue?.trim();
  if (!weapon) {
    return true;
  }

  return !NON_GUN_WEAPON_PATTERNS.some((pattern) => pattern.test(weapon));
}

function isGunResult(result: HllRecentKillScrapeResult["results"][number]) {
  return isGunWeapon(result.weapon);
}

async function queryHllRecordsServers(serverId?: string) {
  return prisma.hllRecordsServer.findMany({
    where: serverId ? { id: serverId } : undefined,
    orderBy: [{ createdAt: "desc" }],
    include: {
      results: {
        orderBy: [{ sourceOrder: "asc" }],
      },
    },
  });
}

async function addRosterFlags(
  servers: HllRecordsServerWithResults[],
): Promise<HllRecordsServerWithRosterFlags[]> {
  const steamIds = Array.from(
    new Set(
      servers
        .flatMap((server) => server.results.filter((result) => isGunWeapon(result.weapon)))
        .map((result) => result.steamId?.trim())
        .filter((steamId): steamId is string => Boolean(steamId)),
    ),
  );

  if (steamIds.length === 0) {
    return servers.map((server) => ({
      ...server,
      results: server.results
        .filter((result) => isGunWeapon(result.weapon))
        .map((result) => ({
          ...result,
          isFreePlayer: Boolean(result.steamId),
          rosterTeamNames: [],
        })),
    }));
  }

  const rosterEntries = await prisma.rosterEntry.findMany({
    where: {
      status: RosterEntryStatus.ACTIVE,
      player: {
        steamId64: {
          in: steamIds,
        },
      },
    },
    select: {
      player: {
        select: {
          steamId64: true,
        },
      },
      team: {
        select: {
          name: true,
        },
      },
    },
  });

  const rosterTeamsBySteamId = new Map<string, Set<string>>();
  for (const entry of rosterEntries) {
    const teamSet = rosterTeamsBySteamId.get(entry.player.steamId64) ?? new Set<string>();
    teamSet.add(entry.team.name);
    rosterTeamsBySteamId.set(entry.player.steamId64, teamSet);
  }

  return servers.map((server) => ({
    ...server,
    results: server.results.filter((result) => isGunWeapon(result.weapon)).map((result) => {
      const rosterTeams = result.steamId ? Array.from(rosterTeamsBySteamId.get(result.steamId) ?? []) : [];

      return {
        ...result,
        isFreePlayer: Boolean(result.steamId) && rosterTeams.length === 0,
        rosterTeamNames: rosterTeams,
      };
    }),
  }));
}

export function serializeHllRecordsServer(server: HllRecordsServerWithRosterFlags) {
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
      isFreePlayer: result.isFreePlayer,
      rosterTeamNames: result.rosterTeamNames,
    })),
  };
}

export async function loadHllRecordsServers() {
  return addRosterFlags(await queryHllRecordsServers());
}

async function loadHllRecordsServer(serverId: string) {
  const [server] = await addRosterFlags(await queryHllRecordsServers(serverId));
  if (!server) {
    throw new Error("HLLRecords server not found.");
  }

  return server;
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
    const gunResults = scrape.results.filter(isGunResult);

    await prisma.$transaction(async (tx) => {
      await tx.hllRecentKillMatch.deleteMany({
        where: { serverId: server.id },
      });

      if (gunResults.length > 0) {
        await tx.hllRecentKillMatch.createMany({
          data: gunResults.map((result) => ({
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

      await tx.hllRecordsServer.update({
        where: { id: server.id },
        data: {
          sourceUrl: normalizeHllRecordsServerUrl(scrape.sourceUrl || server.sourceUrl),
          fetchStatus: HllRecordsFetchStatus.COMPLETED,
          fetchError: null,
          lastRunAt: fetchedAt,
        },
      });
    });

    return loadHllRecordsServer(server.id);
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
