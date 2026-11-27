import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import type { StanceOverrides } from "@/app/lib/strategist-sources";

/**
 * pm:strategist-stance-overrides — a stance set BY HAND for one strategist
 * read (Nov 26 2026): `{ [reportId]: { stance, by?, at } }`. The stance on a
 * Strategists card is normally read from the report's own wording; this lets
 * a person correct it. Small, new, user-entered.
 *
 * GET  → the map (`{}` when the key is missing or unreadable; never seeds).
 * POST { id, stance: "Positive" | "Neutral" | "Negative", by? } → set ONE id.
 * POST { id, clear: true }                                       → remove ONE id.
 * Both are read-merge-write of that one id; every other entry is kept. A
 * stored value that is not an object is left alone (409), never overwritten.
 * Touches no other key and never changes a report.
 */

export const dynamic = "force-dynamic";

const KEY = "pm:strategist-stance-overrides";
const STANCES = ["Positive", "Neutral", "Negative"] as const;
const log = createLogger("Strategist-stance");

export async function GET() {
  try {
    const raw = await (await getRedis()).get(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return NextResponse.json(v && typeof v === "object" && !Array.isArray(v) ? v : {});
  } catch (e) {
    log.error("read failed:", e);
    return NextResponse.json({});
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { id?: unknown; stance?: unknown; clear?: unknown; by?: unknown } | null;
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id || id.length > 200) return NextResponse.json({ error: "A report id is required." }, { status: 400 });
    const clear = body?.clear === true;
    const stance = STANCES.find((s) => s === body?.stance);
    if (!clear && !stance) return NextResponse.json({ error: "Stance must be Positive, Neutral or Negative." }, { status: 400 });

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    let map: StanceOverrides = {};
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return NextResponse.json({ error: "The stored overrides could not be read; nothing was changed." }, { status: 409 });
      map = parsed as StanceOverrides;
    }
    const next: StanceOverrides = { ...map };
    if (clear) delete next[id];
    else next[id] = { stance: stance!, ...(typeof body?.by === "string" && body.by.trim() ? { by: body.by.trim().slice(0, 60) } : {}), at: new Date().toISOString() };
    await redis.set(KEY, JSON.stringify(next));
    return NextResponse.json({ ok: true, overrides: next });
  } catch (e) {
    log.error("write failed:", e);
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }
}
