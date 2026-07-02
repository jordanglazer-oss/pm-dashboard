import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import {
  RESEARCH_REMOVALS_KEY,
  appendRemovals,
  type ResearchRemovalStore,
  type RemovalSource,
} from "@/app/lib/research-removals";

/**
 * Append-only log of tickers dropped from a research list. GET returns the
 * whole store ({} on miss). POST { removals: [{ ticker, source, sourceLabel? }] }
 * buckets them under TODAY (server-stamped) — matching the pm:portfolio-snapshots
 * invariant that only today can be written, so past-dating is impossible.
 * Used by the Newton-Upticks + manual research-scrape client merges; the emailed
 * path writes directly via logResearchRemovals() in inbox-dispatch.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(RESEARCH_REMOVALS_KEY);
    return NextResponse.json(raw ? (JSON.parse(raw) as ResearchRemovalStore) : {});
  } catch {
    // Never seed defaults — empty on read error so a later PUT can't clobber.
    return NextResponse.json({});
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const incomingRaw = Array.isArray(body?.removals) ? body.removals : [];
    const incoming = incomingRaw
      .map((r: { ticker?: unknown; source?: unknown; sourceLabel?: unknown }) => ({
        ticker: String(r?.ticker || "").toUpperCase().trim(),
        source: String(r?.source || "").trim() as RemovalSource,
        sourceLabel: r?.sourceLabel != null ? String(r.sourceLabel) : undefined,
      }))
      .filter((r: { ticker: string; source: string }) => r.ticker && r.source);
    if (incoming.length === 0) return NextResponse.json({ ok: true, added: 0 });

    const redis = await getRedis();
    const raw = await redis.get(RESEARCH_REMOVALS_KEY);
    const store: ResearchRemovalStore = raw ? JSON.parse(raw) : {};
    const now = new Date();
    const { store: nextStore, added } = appendRemovals(
      store,
      incoming,
      now.toISOString().slice(0, 10),
      now.toISOString(),
    );
    await redis.set(RESEARCH_REMOVALS_KEY, JSON.stringify(nextStore));
    return NextResponse.json({ ok: true, added });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
