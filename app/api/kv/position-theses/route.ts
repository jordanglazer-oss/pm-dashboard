import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * pm:position-theses — the HUMAN "why I own it" seed per holding (Phase 03).
 *
 * The optional human half of the Living Thesis Tracker. Deliberately a
 * SEPARATE key from pm:thesis-health (the automated verdict cache) — the
 * two-writer rule — so the human seed and the machine verdict can never
 * clobber each other. Joined at read time by the UI.
 *
 * Shape: { [ticker: string]: { why: string, updatedAt: string } }
 *
 * SAFETY INVARIANTS:
 *   1. GET returns { theses: {} } on missing/error — never seeds defaults.
 *   2. POST is per-ticker READ-MODIFY-WRITE — every other ticker preserved.
 *   3. An empty `why` DELETES that ticker's entry (clearing a note), never
 *      wipes the blob.
 *   4. This is irreplaceable user data — captured by the nightly backup
 *      (NOT in EXCLUDE_PATTERNS).
 */

const KEY = "pm:position-theses";

/** Extended (2026-07, preview thesis-discipline build) with optional
 *  structured fields. All additive; entries written by the old UI parse
 *  unchanged, and read-merge-write below preserves fields it doesn't know. */
type PositionThesis = {
  why: string;
  updatedAt: string;
  /** Pre-registered machine-checkable exit criteria (app/lib/kill-conditions). */
  killConditions?: unknown[];
  underwrittenAt?: string; // YYYY-MM-DD the thesis was (re)underwritten
  underwritePrice?: number | null;
  reUnderwriteBy?: string; // YYYY-MM-DD the quarterly re-check is due
};
type PositionTheses = Record<string, PositionThesis>;

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ theses: {} as PositionTheses });
    return NextResponse.json({ theses: JSON.parse(raw) as PositionTheses });
  } catch (e) {
    console.error("Redis read error (position-theses):", e);
    return NextResponse.json({ theses: {} as PositionTheses });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ticker = typeof body?.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    const why = typeof body?.why === "string" ? body.why.trim() : "";
    if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    // Read-modify-write: preserve every other ticker's note.
    const current: PositionTheses = raw ? (JSON.parse(raw) as PositionTheses) : {};
    const prev = current[ticker];

    // Structured fields arrive on the same POST; each is applied only when
    // present so a why-only save (old UI) can never clobber conditions and a
    // conditions-only save can never clobber the note.
    const hasConditions = Array.isArray(body?.killConditions);
    const next: PositionThesis = {
      ...prev,
      why: body?.why !== undefined ? why : (prev?.why ?? ""),
      updatedAt: new Date().toISOString(),
    };
    if (hasConditions) next.killConditions = body.killConditions as unknown[];
    if (typeof body?.underwrittenAt === "string") next.underwrittenAt = body.underwrittenAt;
    if (typeof body?.underwritePrice === "number") next.underwritePrice = body.underwritePrice;
    if (typeof body?.reUnderwriteBy === "string") next.reUnderwriteBy = body.reUnderwriteBy;

    const empty = !next.why && !(next.killConditions && next.killConditions.length);
    if (empty) {
      delete current[ticker]; // clearing both halves removes the entry
    } else {
      current[ticker] = next;
    }
    await redis.set(KEY, JSON.stringify(current));
    return NextResponse.json({ ok: true, ticker, cleared: empty });
  } catch (e) {
    console.error("Redis write error (position-theses):", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
