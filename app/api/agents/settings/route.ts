import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { readAgentSettings, updateAgentSettings } from "@/app/lib/agents/settings";

/**
 * pm:agent-settings.
 * GET  → the stored settings ({} on miss — never seeds).
 * POST { watcher, model: "haiku" | "sonnet" | "default" } → one watcher's model
 * POST { paused: boolean }                                → the kill switch
 * Read-merge-write; nothing else in the blob is touched.
 */

const log = createLogger("Agents-settings");
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await readAgentSettings());
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { watcher?: string; model?: "haiku" | "sonnet" | "default"; paused?: boolean };
    if (!body.watcher && typeof body.paused !== "boolean") {
      return NextResponse.json({ error: "send { watcher, model } or { paused }" }, { status: 400 });
    }
    return NextResponse.json(await updateAgentSettings(body));
  } catch (e) {
    log.error("update failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "update failed" }, { status: 400 });
  }
}
