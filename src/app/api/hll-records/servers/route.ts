import { HllRecordsFetchStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeHllRecordsServerUrl } from "@/lib/stats/hllRecentKills";
import {
  loadHllRecordsServers,
  refreshHllRecordsServer,
  serializeHllRecordsServer,
} from "@/lib/stats/hllRecordsServers";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const servers = await loadHllRecordsServers();
    return NextResponse.json({ servers: servers.map(serializeHllRecordsServer) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load HLLRecords servers.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      name?: string;
      sourceUrl?: string;
    };
    const sourceUrl = normalizeHllRecordsServerUrl(body.sourceUrl || "");
    const name = body.name?.trim() || new URL(sourceUrl).pathname.split("/").filter(Boolean)[0] || sourceUrl;

    const server = await prisma.hllRecordsServer.upsert({
      where: { sourceUrl },
      create: {
        name,
        sourceUrl,
        fetchStatus: HllRecordsFetchStatus.PENDING,
      },
      update: {
        name,
      },
    });

    const refreshedServer = await refreshHllRecordsServer(server.id);
    return NextResponse.json({ server: serializeHllRecordsServer(refreshedServer) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add HLLRecords server.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
