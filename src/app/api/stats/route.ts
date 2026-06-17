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

function buildRunTimings(run: LatestRunWithItems) {
  const completedDurationsMs = run.items
    .map((item) => {
      if (!item.startedAt || !item.finishedAt) {
        return null;
      }

      const durationMs = item.finishedAt.getTime() - item.startedAt.getTime();
      return durationMs > 0 ? durationMs : null;
    })
    .filter((value): value is number => typeof value === "number");

  const averageRetrievalMs =
    completedDurationsMs.length > 0
      ? Math.round(completedDurationsMs.reduce((total, value) => total + value, 0) / completedDurationsMs.length)
      : null;

  const playersRemaining = Math.max(run.totalPlayers - run.processedPlayers, 0);
  const estimatedRemainingMs = averageRetrievalMs !== null ? averageRetrievalMs * playersRemaining : null;
  const estimatedCompletionAt =
    estimatedRemainingMs !== null && playersRemaining > 0 ? new Date(Date.now() + estimatedRemainingMs) : null;

  return {
    playersRemaining,
    averageRetrievalMs,
    estimatedRemainingMs,
    estimatedCompletionAt,
  };
}

function serializeRun(run: LatestRunWithItems | null) {
  if (!run) {
    return null;
  }

  const timings = buildRunTimings(run);

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
    playersRemaining: timings.playersRemaining,
    averageRetrievalMs: timings.averageRetrievalMs,
    estimatedRemainingMs: timings.estimatedRemainingMs,
    estimatedCompletionAt: timings.estimatedCompletionAt?.toISOString() ?? null,
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
      mainRole: item.mainRole,
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
        mainRole: string | null;
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
        mainRole: string | null;
        fetchedAt: string | null;
        status: PlayerStatsFetchStatus;
        error: string | null;
      } | null;
      runItem:
        | {
            status: PlayerStatsFetchStatus;
            kpm180: number | null;
            duelStrength180: number | null;
            mainRole: string | null;
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
            mainRole: entry.player.externalStat.mainRole,
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
            mainRole: runItem.mainRole,
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

async function loadActiveTournamentPlayers() {
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

  return Array.from(playersById.values());
}

async function createStatsRunFromActivePlayers() {
  const players = await loadActiveTournamentPlayers();
  if (players.length === 0) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No active roster players were found." }, { status: 400 }),
    };
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

  return {
    ok: true as const,
    run,
  };
}

export async function GET() {
  try {
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
                  mainRole: true,
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
      diagnostics: {
        rosterEntries: rosterEntries.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load stats data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  try {
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

    const createResult = await createStatsRunFromActivePlayers();
    if (!createResult.ok) {
      return createResult.response;
    }

    const { run } = createResult;

    startStatsRunProcessing(run.id);

    return NextResponse.json({ latestRun: serializeRun(run) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start stats run.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "pause" | "resume" | "restart";
      runId?: string;
    };

    if (!body.runId?.trim()) {
      return NextResponse.json({ error: "runId is required." }, { status: 400 });
    }

    if (body.action !== "pause" && body.action !== "resume" && body.action !== "restart") {
      return NextResponse.json({ error: "action must be pause, resume or restart." }, { status: 400 });
    }

    const run = await prisma.statsRun.findUnique({
      where: {
        id: body.runId,
      },
      include: {
        items: {
          orderBy: {
            position: "asc",
          },
        },
      },
    });

    if (!run) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }

    if (body.action === "pause") {
      if (run.status !== StatsRunStatus.RUNNING) {
        return NextResponse.json({ error: "Only running stats jobs can be paused." }, { status: 409 });
      }

      const pausedRun = await prisma.statsRun.update({
        where: { id: run.id },
        data: {
          status: StatsRunStatus.PAUSED,
        },
        include: {
          items: {
            orderBy: {
              position: "asc",
            },
          },
        },
      });

      return NextResponse.json({ latestRun: serializeRun(pausedRun) });
    }

    if (body.action === "restart") {
      if (run.status === StatsRunStatus.RUNNING) {
        await prisma.statsRun.update({
          where: { id: run.id },
          data: {
            status: StatsRunStatus.FAILED,
            finishedAt: new Date(),
          },
        });
      } else if (run.status === StatsRunStatus.PAUSED) {
        await prisma.statsRun.update({
          where: { id: run.id },
          data: {
            status: StatsRunStatus.FAILED,
            finishedAt: new Date(),
          },
        });
      }

      const createResult = await createStatsRunFromActivePlayers();
      if (!createResult.ok) {
        return createResult.response;
      }

      startStatsRunProcessing(createResult.run.id);

      return NextResponse.json({
        latestRun: serializeRun(createResult.run),
      });
    }

    if (run.status !== StatsRunStatus.PAUSED) {
      return NextResponse.json({ error: "Only paused stats jobs can be resumed." }, { status: 409 });
    }

    const resumedRun = await prisma.statsRun.update({
      where: { id: run.id },
      data: {
        status: StatsRunStatus.RUNNING,
      },
      include: {
        items: {
          orderBy: {
            position: "asc",
          },
        },
      },
    });

    startStatsRunProcessing(resumedRun.id);

    return NextResponse.json({ latestRun: serializeRun(resumedRun) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update stats run.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
