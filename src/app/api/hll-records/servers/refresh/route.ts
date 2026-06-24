import { NextResponse } from "next/server";
import {
  loadHllRecordsTeams,
  refreshAllHllRecordsServers,
  serializeHllRecordsServer,
} from "@/lib/stats/hllRecordsServers";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const [servers, teams] = await Promise.all([refreshAllHllRecordsServers(), loadHllRecordsTeams()]);
    return NextResponse.json({ servers: servers.map(serializeHllRecordsServer), teams });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to rerun all HLLRecords servers.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
