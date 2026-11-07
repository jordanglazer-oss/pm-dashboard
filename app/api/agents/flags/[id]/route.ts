import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { updateFlag } from "@/app/lib/agents/flags";

/**
 * POST /api/agents/flags/<id> — the PM's response to ONE flag:
 *   { action: "act" | "dismiss" | "reopen", note? }   status change
 *   { action: "note", note }                          add to the thread
 * Read-modify-write of that flag's own key; nothing else is touched.
 */

const log = createLogger("Agents-flags");
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { action?: string; note?: string };
    const action = body.action;
    if (action !== "act" && action !== "dismiss" && action !== "reopen" && action !== "note") {
      return NextResponse.json({ error: "action must be act | dismiss | reopen | note" }, { status: 400 });
    }
    if (action === "note" && !body.note?.trim()) return NextResponse.json({ error: "note required" }, { status: 400 });
    const flag =
      action === "note" ? await updateFlag(id, { action, note: body.note ?? "", from: "pm" }) : await updateFlag(id, { action, note: body.note });
    if (!flag) return NextResponse.json({ error: "flag not found" }, { status: 404 });
    return NextResponse.json({ flag });
  } catch (e) {
    log.error("update failed:", id, e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "update failed" }, { status: 500 });
  }
}
