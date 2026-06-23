import { NextResponse } from "next/server";
import { loadHllRecordsServers, serializeHllRecordsServer } from "@/lib/stats/hllRecordsServers";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const servers = await loadHllRecordsServers();
    const serializedServers = servers.map(serializeHllRecordsServer);
    const candidates = serializedServers
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
      .sort((left, right) => {
        const leftKpm = left.kpm180 ?? -1;
        const rightKpm = right.kpm180 ?? -1;
        if (leftKpm !== rightKpm) {
          return rightKpm - leftKpm;
        }

        return right.kills - left.kills;
      });

    return NextResponse.json({ candidates });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load players to poach.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
