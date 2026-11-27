import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { WHY_KEY, cleanPoints, mergeWhy, whyKey, type WhySource, type WhyStore } from "@/app/lib/why-we-own";

/**
 * "Why we own it" points.
 * GET  — the whole store ({ entries: {} } on a missing key or read error; never seeds).
 * POST { symbol, points, status: "draft" | "approved", source?, approvedBy? }
 *      — saves ONE holding by read-merge-write of pm:why-we-own; the prior
 *      version goes to that entry's history. Touches no other key.
 */

export const dynamic = "force-dynamic";
const log = createLogger("Why-we-own");
const SOURCES: WhySource[] = ["from thesis", "from one-pager", "written by hand"];

async function read(): Promise<WhyStore> {
  try {
    const raw = await (await getRedis()).get(WHY_KEY);
    const v = raw ? (JSON.parse(raw) as WhyStore) : null;
    return v && typeof v === "object" && v.entries && typeof v.entries === "object" ? v : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

export async function GET() {
  return NextResponse.json(await read());
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { symbol?: unknown; points?: unknown; status?: unknown; source?: unknown; approvedBy?: unknown } | null;
    const symbol = typeof body?.symbol === "string" ? whyKey(body.symbol) : "";
    if (!symbol || symbol.length > 24) return NextResponse.json({ error: "A holding symbol is needed." }, { status: 400 });
    const points = cleanPoints(body?.points);
    if (!points.length) return NextResponse.json({ error: "Write at least one point." }, { status: 400 });
    const status = body?.status === "approved" ? "approved" : "draft";
    const source = SOURCES.includes(body?.source as WhySource) ? (body!.source as WhySource) : "written by hand";
    const now = new Date().toISOString();
    const approvedBy = status === "approved" && typeof body?.approvedBy === "string" ? body.approvedBy.trim().slice(0, 60) : undefined;

    const redis = await getRedis();
    const raw = await redis.get(WHY_KEY);
    let store: WhyStore = { entries: {} };
    if (raw) {
      try {
        const v = JSON.parse(raw) as WhyStore;
        if (!v || typeof v !== "object" || !v.entries || typeof v.entries !== "object") throw new Error("unexpected shape");
        store = v;
      } catch {
        // An unreadable store is left alone rather than overwritten.
        return NextResponse.json({ error: "The saved points could not be read, so nothing was changed." }, { status: 409 });
      }
    }
    const next = mergeWhy(store, symbol, { points, status, source, ...(status === "approved" ? { approvedBy, approvedAt: now } : {}), updatedAt: now });
    await redis.set(WHY_KEY, JSON.stringify(next));
    log.info(`${symbol}: saved ${points.length} points (${status})`);
    return NextResponse.json({ ok: true, entry: next.entries[symbol] });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
