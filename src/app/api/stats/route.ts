import { PlayerStatsFetchStatus, Prisma, StatsRunStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { startStatsRunProcessing } from "@/lib/stats/processStatsRun";

export const dynamic = "force-dynamic";

type LatestRunWithItems = Prisma.StatsRunGetPayload<{
  include: {
    items: {
      orderBy: {
        position: "asc";
      };
    };
  };
}>;

function serializeRun(run: LatestRunWithItems | null) {
  if (!run) {
    return null;
  }

  return {
    id: run.id,
    status: run.status,
    requestedBy: run.requestedBy,
    totalPlayers: run.totalPlayers,
    processedPlayers: run.processedPlayers,
    successPlayers: run.successPlayers,
    failedPlayers: run.failedPlayers,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    playersRemaining: Math.max(run.totalPlayers - run.processedPlayers, 0),
    items: run.items.map((item) => ({
      id: item.id,
      playerId: item.playerId,
      steamId64: item.steamId64,
      displayName: item.displayName,
      teamNames: item.teamNames,
      position: item.position,
      status: item.status,
      kpm180: item.kpm180,
      duelStrength180: item.duelStrength180,
      error: item.error,
      startedAt: item.startedAt?.toISOString() ?? null,
      finishedAt: item.finishedAt?.toISOString() ?? null,
    })),
  };
}

function buildTournamentPlayerRows(
  rosterEntries: Array<{
    playerId: string;
    player: {
      steamId64: string;
      displayName: string | null;
      externalStat: {
        kpm180: number | null;
        duelStrength180: number | null;
        sourceFetchedAt: Date | null;
        fetchStatus: PlayerStatsFetchStatus;
        fetchError: string | null;
      } | null;
    };
    team: {
      name: string;
    };
  }>,
  latestRun: LatestRunWithItems | null,
) {
  const runItemsByPlayerId = new Map(latestRun?.items.map((item) => [item.playerId, item]) ?? []);
  const playersById = new Map<
    string,
    {
      playerId: string;
      steamId64: string;
      displayName: string | null;
      teamNames: string[];
      cachedStat: {
        kpm180: number | null;
        duelStrength180: number | null;
        fetchedAt: string | null;
        status: PlayerStatsFetchStatus;
        error: string | null;
      } | null;
      runItem:
        | {
            status: PlayerStatsFetchStatus;
            kpm180: number | null;
            duelStrength180: number | null;
            error: string | null;
            startedAt: string | null;
            finishedAt: string | null;
          }
        | null;
    }
  >();

  for (const entry of rosterEntries) {
    const existing = playersById.get(entry.playerId);
    if (existing) {
      if (!existing.teamNames.includes(entry.team.name)) {
        existing.teamNames.push(entry.team.name);
      }
      continue;
    }

    const runItem = runItemsByPlayerId.get(entry.playerId);
    playersById.set(entry.playerId, {
      playerId: entry.playerId,
      steamId64: entry.player.steamId64,
      displayName: entry.player.displayName,
      teamNames: [entry.team.name],
      cachedStat: entry.player.externalStat
        ? {
            kpm180: entry.player.externalStat.kpm180,
            duelStrength180: entry.player.externalStat.duelStrength180,
            fetchedAt: entry.player.externalStat.sourceFetchedAt?.toISOString() ?? null,
            status: entry.player.externalStat.fetchStatus,
            error: entry.player.externalStat.fetchError,
          }
        : null,
      runItem: runItem
        ? {
            status: runItem.status,
            kpm180: runItem.kpm180,
            duelStrength180: runItem.duelStrength180,
            error: runItem.error,
            startedAt: runItem.startedAt?.toISOString() ?? null,
            finishedAt: runItem.finishedAt?.toISOString() ?? null,
          }
        : null,
    });
  }

  return Array.from(playersById.values()).sort((left, right) => {
    const leftTeam = left.teamNames[0] || "";
    const rightTeam = right.teamNames[0] || "";
    if (leftTeam !== rightTeam) {
      return leftTeam.localeCompare(rightTeam);
    }

    return (left.displayName || left.steamId64).localeCompare(right.displayName || right.steamId64);
  });
}

export async function GET() {
  const [latestRun, rosterEntries] = await Promise.all([
    prisma.statsRun.findFirst({
      orderBy: {
        startedAt: "desc",
      },
      include: {
        items: {
          orderBy: {
            position: "asc",
          },
        },
      },
    }),
    prisma.rosterEntry.findMany({
      where: {
        status: "ACTIVE",
      },
      include: {
        team: {
          select: {
            name: true,
          },
        },
        player: {
          include: {
            externalStat: {
              select: {
                kpm180: true,
                duelStrength180: true,
                sourceFetchedAt: true,
                fetchStatus: true,
                fetchError: true,
              },
            },
          },
        },
      },
      orderBy: [
        {
          team: {
            name: "asc",
          },
        },
        {
          submittedAt: "asc",
        },
      ],
    }),
  ]);

  return NextResponse.json({
    latestRun: serializeRun(latestRun),
    players: buildTournamentPlayerRows(rosterEntries, latestRun),
  });
}

export async function POST() {
  await prisma.statsRun.updateMany({
    where: {
      status: StatsRunStatus.RUNNING,
      startedAt: {
        lt: new Date(Date.now() - 1000 * 60 * 60 * 2),
      },
    },
    data: {
      status: StatsRunStatus.FAILED,
      finishedAt: new Date(),
    },
  });

  const runningRun = await prisma.statsRun.findFirst({
    where: {
      status: StatsRunStatus.RUNNING,
    },
    orderBy: {
      startedAt: "desc",
    },
    include: {
      items: {
        orderBy: {
          position: "asc",
        },
      },
    },
  });

  if (runningRun) {
    return NextResponse.json(
      {
        error: "A stats refresh is already running.",
        latestRun: serializeRun(runningRun),
      },
      { status: 409 },
    );
  }

  const rosterEntries = await prisma.rosterEntry.findMany({
    where: {
      status: "ACTIVE",
    },
    include: {
      team: {
        select: {
          name: true,
        },
      },
      player: {
        select: {
          id: true,
          steamId64: true,
          displayName: true,
        },
      },
    },
    orderBy: [
      {
        team: {
          name: "asc",
        },
      },
      {
        submittedAt: "asc",
      },
    ],
  });

  const playersById = new Map<
    string,
    {
      playerId: string;
      steamId64: string;
      displayName: string | null;
      teamNames: string[];
    }
  >();

  for (const entry of rosterEntries) {
    const existing = playersById.get(entry.player.id);
    if (existing) {
      if (!existing.teamNames.includes(entry.team.name)) {
        existing.teamNames.push(entry.team.name);
      }
      continue;
    }

    playersById.set(entry.player.id, {
      playerId: entry.player.id,
      steamId64: entry.player.steamId64,
      displayName: entry.player.displayName,
      teamNames: [entry.team.name],
    });
  }

  const players = Array.from(playersById.values());
  if (players.length === 0) {
    return NextResponse.json({ error: "No active roster players were found." }, { status: 400 });
  }

  const run = await prisma.$transaction(async (tx) => {
    const createdRun = await tx.statsRun.create({
      data: {
        requestedBy: process.env.STATS_REQUESTED_BY?.trim() || process.env.BASIC_AUTH_USERNAME?.trim() || "MILK",
        totalPlayers: players.length,
      },
    });

    await tx.statsRunItem.createMany({
      data: players.map((player, index) => ({
        runId: createdRun.id,
        playerId: player.playerId,
        steamId64: player.steamId64,
        displayName: player.displayName,
        teamNames: player.teamNames,
        position: index + 1,
      })),
    });

    return tx.statsRun.findUniqueOrThrow({
      where: {
        id: createdRun.id,
      },
      include: {
        items: {
          orderBy: {
            position: "asc",
          },
        },
      },
    });
  });

  startStatsRunProcessing(run.id);

  return NextResponse.json({ latestRun: serializeRun(run) }, { status: 201 });
}
