import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { canonicalTicker } from "@/app/lib/ticker";
import { ENTRY_CASES_KEY, type EntryCase } from "@/app/lib/entry-scan";

/**
 * pm:entry-cases — the one-line "why I'm watching" per name, captured when a
 * Suggested name is advanced (pre-filled from the synthesis next step) or
 * typed by the PM. Carries into the thesis draft at Buy so the thesis starts
 * from what the PM already believed.
 *
 * GET  → the whole map ({} on miss, never seeds).
 * POST { ticker, why, source? } → per-ticker read-merge-write; empty why deletes.
 */

async function read(): Promise<Record<string, EntryCase>> {
  try {
    const raw = await (await getRedis()).get(ENTRY_CASES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, EntryCase>) : {};
  } catch {
    return {};
  }
}

export async function GET() {
  return NextResponse.json(await read());
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { ticker?: unknown; why?: unknown; source?: unknown };
    const ticker = typeof body.ticker === "string" ? canonicalTicker(body.ticker).toUpperCase() : "";
    if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    const why = typeof body.why === "string" ? body.why.trim().slice(0, 400) : "";
    const redis = await getRedis();
    const cur = await read();
    const next = { ...cur };
    if (!why) delete next[ticker];
    else next[ticker] = { why, addedAt: new Date().toISOString(), source: typeof body.source === "string" ? body.source.slice(0, 40) : undefined };
    await redis.set(ENTRY_CASES_KEY, JSON.stringify(next));
    return NextResponse.json({ ok: true, ticker, entry: next[ticker] ?? null });
  } catch (e) {
    console.error("entry-cases write failed:", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
