import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { updateFlag } from "@/app/lib/agents/flags";
import { journalFlagDecision } from "@/app/lib/agents/journal";

/**
 * POST /api/agents/flags/<id> — the PM's response to ONE flag:
 *   { action: "act" | "dismiss" | "reopen", note? }   status change
 *   { action: "note", note }                          add to the thread
 * Read-modify-write of that flag's own key. An Act / Dismiss on a
 * theme-review flag (or on any flag with a note) is also APPENDED to the
 * decision journal (pm:decision-journal, read-merge-write, best effort).
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
    let journaled = false;
    if (action === "act" || action === "dismiss") {
      try {
        journaled = await journalFlagDecision(flag, action, body.note);
      } catch (e) {
        log.warn("journal write failed (flag already updated):", e);
      }
    }
    return NextResponse.json({ flag, journaled });
  } catch (e) {
    log.error("update failed:", id, e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "update failed" }, { status: 500 });
  }
}
