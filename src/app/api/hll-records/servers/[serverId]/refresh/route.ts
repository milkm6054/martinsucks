import { NextResponse } from "next/server";
import { refreshHllRecordsServer, serializeHllRecordsServer } from "@/lib/stats/hllRecordsServers";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  try {
    const { serverId } = await params;
    const server = await refreshHllRecordsServer(serverId);
    return NextResponse.json({ server: serializeHllRecordsServer(server) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to rerun HLLRecords server.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
