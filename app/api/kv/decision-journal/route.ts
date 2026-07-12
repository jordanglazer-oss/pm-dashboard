import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * pm:decision-journal — the Decision Journal (Phase 08).
 *
 * Captures the WHY behind each portfolio action (add / trim / hold / hedge /
 * watch / sell) with a confidence, so it can later be reviewed against outcomes
 * (the behavioural edge). Irreplaceable user data — captured by the nightly
 * backup (NOT in EXCLUDE_PATTERNS).
 *
 * Shape: { entries: DecisionEntry[] } (newest-first on read).
 *
 * SAFETY INVARIANTS:
 *   1. GET returns { entries: [] } on missing/error — never seeds defaults.
 *   2. POST/DELETE are READ-MODIFY-WRITE on the entries array — every other
 *      entry is preserved.
 *   3. No date validation (decisions can be backdated by the user); server
 *      stamps the timestamp + id.
 */

const KEY = "pm:decision-journal";

type DecisionEntry = {
  id: string;
  date: string; // YYYY-MM-DD (user-set or today)
  timestamp: string; // ISO, server-stamped
  ticker?: string;
  action: string; // add | trim | hold | hedge | watch | sell | other
  rationale: string;
  confidence?: "low" | "medium" | "high";
};

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ entries: [] as DecisionEntry[] });
    const parsed = JSON.parse(raw) as { entries?: DecisionEntry[] };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    // Newest first for display.
    entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    return NextResponse.json({ entries });
  } catch (e) {
    console.error("Redis read error (decision-journal):", e);
    return NextResponse.json({ entries: [] as DecisionEntry[] });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = typeof body?.action === "string" ? body.action.trim() : "";
    const rationale = typeof body?.rationale === "string" ? body.rationale.trim() : "";
    if (!action) return NextResponse.json({ error: "action required" }, { status: 400 });
    if (!rationale) return NextResponse.json({ error: "rationale required" }, { status: 400 });

    const entry: DecisionEntry = {
      id: `dj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      date: typeof body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayUTC(),
      timestamp: new Date().toISOString(),
      ticker: typeof body?.ticker === "string" && body.ticker.trim() ? body.ticker.trim().toUpperCase() : undefined,
      action,
      rationale,
      confidence: ["low", "medium", "high"].includes(body?.confidence) ? body.confidence : undefined,
    };

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    // Read-modify-write: preserve all existing entries.
    const current = raw ? (JSON.parse(raw) as { entries?: DecisionEntry[] }) : { entries: [] };
    const entries = Array.isArray(current.entries) ? current.entries : [];
    entries.push(entry);
    await redis.set(KEY, JSON.stringify({ entries }));
    return NextResponse.json({ ok: true, entry });
  } catch (e) {
    console.error("Redis write error (decision-journal POST):", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ ok: true, removed: 0 });
    const current = JSON.parse(raw) as { entries?: DecisionEntry[] };
    const entries = (Array.isArray(current.entries) ? current.entries : []).filter((e) => e.id !== id);
    await redis.set(KEY, JSON.stringify({ entries }));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (decision-journal DELETE):", e);
    return NextResponse.json({ error: "delete failed" }, { status: 500 });
  }
}
