import { HllPoachStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import {
  loadHllRecordsServers,
  loadHllRecordsTeams,
  serializeHllRecordsServer,
  updateHllPoachPlayerStatus,
} from "@/lib/stats/hllRecordsServers";

export const dynamic = "force-dynamic";

type SerializedHllRecordsServer = ReturnType<typeof serializeHllRecordsServer>;
type PoachAppearance = SerializedHllRecordsServer["results"][number] & {
  serverId: string;
  serverName: string;
  serverUrl: string;
  serverLastRunAt: string | null;
};

function averageValue(values: Array<number | null | undefined>) {
  const numericValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numericValues.length === 0) {
    return null;
  }

  return numericValues.reduce((total, value) => total + value, 0) / numericValues.length;
}

export async function GET() {
  try {
    const servers = await loadHllRecordsServers();
    const serializedServers = servers.map(serializeHllRecordsServer);
    const candidateMap = new Map<string, {
      steamId: string;
      playerName: string;
      profileUrl: string;
      kpm180: number | null;
      averageKills: number | null;
      averageKpm: number | null;
      bestKills: number;
      weapons: string[];
      mainRole: string | null;
      statError: string | null;
      poachStatus: string;
      poachTeamId: string | null;
      poachTeamName: string | null;
      appearances: PoachAppearance[];
      sourceNames: string[];
    }>();

    serializedServers
      .flatMap((server) =>
        server.results
          .filter((result) => result.isFreePlayer)
          .map((result) => ({
            ...result,
            serverId: server.id,
            serverName: server.name,
            serverUrl: server.sourceUrl,
            serverLastRunAt: server.lastRunAt,
          })),
      )
      .forEach((result) => {
        if (!result.steamId) {
          return;
        }

        const existing = candidateMap.get(result.steamId);
        const appearances = [...(existing?.appearances ?? []), result];
        const sourceNames = Array.from(new Set(appearances.map((appearance) => appearance.serverName)));
        const weapons = Array.from(
          new Set(appearances.map((appearance) => appearance.weapon).filter((weapon): weapon is string => Boolean(weapon))),
        );
        const bestAppearance = appearances.reduce((best, appearance) => {
          if (appearance.kills !== best.kills) {
            return appearance.kills > best.kills ? appearance : best;
          }

          return (appearance.kpm ?? -1) > (best.kpm ?? -1) ? appearance : best;
        }, appearances[0]);

        candidateMap.set(result.steamId, {
          steamId: result.steamId,
          playerName: bestAppearance.playerName,
          profileUrl: bestAppearance.profileUrl,
          kpm180: averageValue(appearances.map((appearance) => appearance.kpm180)),
          averageKills: averageValue(appearances.map((appearance) => appearance.kills)),
          averageKpm: averageValue(appearances.map((appearance) => appearance.kpm)),
          bestKills: bestAppearance.kills,
          weapons,
          mainRole: bestAppearance.mainRole,
          statError: bestAppearance.statError,
          poachStatus: bestAppearance.poachStatus,
          poachTeamId: bestAppearance.poachTeamId,
          poachTeamName: bestAppearance.poachTeamName,
          appearances,
          sourceNames,
        });
      });

    const candidates = Array.from(candidateMap.values())
      .sort((left, right) => {
        const leftKpm = left.kpm180 ?? -1;
        const rightKpm = right.kpm180 ?? -1;
        if (leftKpm !== rightKpm) {
          return rightKpm - leftKpm;
        }

        return right.bestKills - left.bestKills;
      });

    return NextResponse.json({ candidates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load players to poach.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      steamId?: string;
      status?: string;
      teamId?: string | null;
    };

    if (!body.steamId?.trim()) {
      return NextResponse.json({ error: "Steam ID is required." }, { status: 400 });
    }

    if (!body.status || !Object.values(HllPoachStatus).includes(body.status as HllPoachStatus)) {
      return NextResponse.json({ error: "Select a valid poach status." }, { status: 400 });
    }

    await updateHllPoachPlayerStatus({
      steamId: body.steamId,
      status: body.status as HllPoachStatus,
      teamId: body.teamId ?? null,
    });

    const [servers, teams] = await Promise.all([loadHllRecordsServers(), loadHllRecordsTeams()]);
    const serializedServers = servers.map(serializeHllRecordsServer);
    return NextResponse.json({ servers: serializedServers, teams });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update poach status.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
