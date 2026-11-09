import { NextRequest, NextResponse } from "next/server";
import { replyToConversation } from "@/app/lib/agents/theme-review";

/**
 * POST /api/agents/flags/<id>/reply { note } — one turn of a flag's
 * conversation (theme reviews): the PM's note is added to the thread, then
 * the watcher answers in the thread (agents key, budget-checked). Writes only
 * that flag's key. If the watcher can't answer (budget, paused) the note is
 * still saved and the error is returned.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 4000) : "";
  if (!note) return NextResponse.json({ error: "note required" }, { status: 400 });
  const out = await replyToConversation(id, note);
  return NextResponse.json(out, { status: out.ok ? 200 : 404 });
}
