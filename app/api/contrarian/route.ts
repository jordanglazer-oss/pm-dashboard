import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { CONTRARIAN_CAUTION, CONTRARIAN_RULES } from "@/app/lib/contrarian";
import { loadContrarian } from "@/app/lib/contrarian-load";

/**
 * GET /api/contrarian[?ticker=AAPL] — the contrarian setup read-out for the
 * individual stocks in the book (Portfolio + Watchlist): cheap versus its
 * own history, estimates no longer falling, insiders buying, and out of
 * favour while the thesis is not broken (app/lib/contrarian.ts).
 *
 * READ-ONLY and separate from scoring: it stores nothing and never feeds the
 * composite, the setup grade or any stored score. Without `ticker` it reads
 * only what is already cached; with `ticker` it also fetches prices and the
 * insider filings for that one name when they are not cached. Returns an
 * empty list on a read error — never seeds.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = createLogger("Contrarian");

export async function GET(req: NextRequest) {
  const ticker = new URL(req.url).searchParams.get("ticker")?.trim() || undefined;
  try {
    const out = await loadContrarian({ ticker });
    return NextResponse.json({ rules: CONTRARIAN_RULES, caution: CONTRARIAN_CAUTION, ...out });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ rules: CONTRARIAN_RULES, caution: CONTRARIAN_CAUTION, at: new Date().toISOString(), rows: [], error: e instanceof Error ? e.message : "failed" });
  }
}
