import { NextResponse } from "next/server";
import { listFlags } from "@/app/lib/agents/flags";

/**
 * GET /api/agents/flags — every watcher flag, newest first ([] on miss).
 * Read-only. Flags are created only by watchers server-side; there is
 * deliberately no client route that creates one.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ flags: await listFlags() });
}
