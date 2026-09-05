import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { canonicalTicker } from "@/app/lib/ticker";
import { DECISIONS_KEY, type DecisionStore, type SuggestedDecision } from "@/app/lib/suggested-watchlist";

/**
 * pm:synthesis-decisions — the PM's verdict on a Suggested name after reading
 * its synthesis (advance / watch / pass), remembered for 30 days.
 *
 * GET  returns the store ({} on miss — never seeds).
 * POST { ticker, verdict } upserts ONE ticker (read-merge-write; other
 *      tickers untouched). verdict "clear" removes the entry.
 *
 * Writes ONLY this key. Advancing a name to the Watchlist is a separate
 * client-side addStock — this store only remembers the choice.
 */

const VERDICTS = new Set<string>(["advance", "watch", "pass"]);

async function read(): Promise<DecisionStore> {
  try {
    const raw = await (await getRedis()).get(DECISIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DecisionStore) : {};
  } catch {
    return {};
  }
}

export async function GET() {
  return NextResponse.json(await read());
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { ticker?: unknown; verdict?: unknown };
    const ticker = typeof body.ticker === "string" ? canonicalTicker(body.ticker).toUpperCase() : "";
    const verdict = typeof body.verdict === "string" ? body.verdict : "";
    if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    if (verdict !== "clear" && !VERDICTS.has(verdict)) {
      return NextResponse.json({ error: "verdict must be advance | watch | pass | clear" }, { status: 400 });
    }
    const redis = await getRedis();
    const prev = await read();
    const next: DecisionStore = { ...prev };
    if (verdict === "clear") delete next[ticker];
    else next[ticker] = { verdict: verdict as SuggestedDecision, decidedAt: new Date().toISOString() };
    await redis.set(DECISIONS_KEY, JSON.stringify(next));
    return NextResponse.json({ ok: true, ticker, entry: next[ticker] ?? null });
  } catch (e) {
    console.error("Redis write error (synthesis-decisions):", e);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
