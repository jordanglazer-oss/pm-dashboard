/**
 * GET /api/admin/diagnose-research-mentions?ticker=GOOGL
 *
 * READ-ONLY diagnostic for the researchMentions score. Shows, for a given
 * ticker, exactly which pm:research lists it appears on, the matched entry's
 * stored ticker form (to catch GOOGL-vs-GOOG style mismatches), and the
 * resulting tally score. Built after a report that a name visibly on the
 * Fundstrat Top list still scored 0/3 — the tally used to read the AI-parse
 * scrape caches rather than pm:research; this endpoint verifies the fix.
 *
 * No writes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { tallyResearchMentions } from "@/app/lib/research-mentions";
import { canonicalTicker, tickersEqual } from "@/app/lib/ticker";

// Mirror of the SOURCES map in research-mentions.ts (field + direction).
const LISTS: Array<{ field: string; label: string; direction: "bullish" | "bearish" }> = [
  { field: "newtonUpticks", label: "Newton Upticks", direction: "bullish" },
  { field: "fundstratTop", label: "Fundstrat Top Ideas", direction: "bullish" },
  { field: "fundstratBottom", label: "Fundstrat Bottom Ideas", direction: "bearish" },
  { field: "fundstratSmidTop", label: "Fundstrat SMID Top", direction: "bullish" },
  { field: "fundstratSmidBottom", label: "Fundstrat SMID Bottom", direction: "bearish" },
  { field: "rbcCanadianFocus", label: "RBC Canadian Focus", direction: "bullish" },
  { field: "rbcUsFocus", label: "RBC US Focus", direction: "bullish" },
  { field: "alphaPicks", label: "Seeking Alpha Picks", direction: "bullish" },
];

export async function GET(req: NextRequest) {
  const ticker = new URL(req.url).searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "Add ?ticker=SYMBOL" }, { status: 400 });
  }
  const target = canonicalTicker(ticker);

  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:research");
    const research = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;

    const perList = LISTS.map((cfg) => {
      const list = research?.[cfg.field];
      if (!Array.isArray(list)) {
        return { list: cfg.label, field: cfg.field, present: false, entryCount: 0, matchedTickerForm: null, direction: cfg.direction };
      }
      const entries = list as Array<{ ticker?: unknown }>;
      const hit = entries.find((e) => {
        const t = typeof e?.ticker === "string" ? e.ticker : "";
        return t && tickersEqual(t, target);
      });
      return {
        list: cfg.label,
        field: cfg.field,
        present: !!hit,
        entryCount: entries.length,
        matchedTickerForm: hit && typeof hit.ticker === "string" ? hit.ticker : null,
        direction: cfg.direction,
      };
    });

    // Also surface a sample of all tickers on each list when the target
    // wasn't found anywhere — helps spot a form mismatch (GOOG vs GOOGL).
    const notFoundAnywhere = perList.every((l) => !l.present);
    const sampleTickers: Record<string, string[]> = {};
    if (notFoundAnywhere && research) {
      for (const cfg of LISTS) {
        const list = research[cfg.field];
        if (Array.isArray(list)) {
          sampleTickers[cfg.field] = (list as Array<{ ticker?: unknown }>)
            .map((e) => (typeof e?.ticker === "string" ? e.ticker : ""))
            .filter(Boolean);
        }
      }
    }

    const tally = await tallyResearchMentions(ticker);

    return NextResponse.json({
      ok: true,
      ticker,
      canonical: target,
      pmResearchPresent: !!research,
      tally,
      perList,
      ...(notFoundAnywhere ? { allListTickers: sampleTickers, hint: "Target not found on any list — check the allListTickers dump for a ticker-form mismatch (e.g. GOOG vs GOOGL)." } : {}),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Diagnostic failed" },
      { status: 500 },
    );
  }
}
