import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { loadAlertInputs } from "@/app/lib/alert-inputs";

/**
 * GET /api/thesis-watch — fleet-wide kill-condition sweep, read-only.
 *
 * Returns every underwritten holding with its conditions evaluated by the
 * same pure checker the stock-page tile uses (app/lib/kill-conditions),
 * from the same loadAlertInputs() data the alerts tile and morning digest
 * read — one loader, three surfaces, no drift.
 *
 * `coverage` (additive, for the /thesis desk) reports the underwriting GAP:
 * which Portfolio-bucket holdings have no thesis at all, and which have prose
 * but no pre-registered conditions (so they're invisible to the sweep above —
 * `holdings` only includes entries WITH conditions). Watchlist names are
 * deliberately excluded: kill conditions are EXIT criteria, so the coverage
 * denominator is what you actually own.
 *
 * ETFs and mutual funds are excluded too (same `isScoreable` rule the stock
 * page uses to decide whether to render the Thesis tile at all). A fund has no
 * company thesis to underwrite and no Thesis tile on its page, so counting one
 * would both understate coverage and produce an "Underwrite →" link that leads
 * nowhere.
 *
 * Deterministic; zero Anthropic spend. No Redis writes.
 */

export const dynamic = "force-dynamic";

type CoverageRow = { ticker: string; name?: string; sector?: string; hasProse: boolean };

export async function GET() {
  try {
    const { killWatch, context } = await loadAlertInputs();

    // Thesis keys include prose-only entries, which killWatch drops.
    let theses: Record<string, { why?: string; killConditions?: unknown[] }> = {};
    try {
      const raw = await (await getRedis()).get("pm:position-theses");
      if (raw) theses = JSON.parse(raw);
    } catch {
      // coverage degrades to "nothing underwritten" rather than failing the sweep
    }
    const thesisFor = (tk: string) => theses[tk] ?? theses[tk.toUpperCase()];

    const missing: CoverageRow[] = [];
    let portfolioCount = 0;
    for (const [tk, c] of Object.entries(context)) {
      if (c.bucket !== "Portfolio") continue;
      // Mirrors isScoreable(): undefined instrumentType means a stock.
      if (c.instrumentType && c.instrumentType !== "stock") continue;
      portfolioCount++;
      const t = thesisFor(tk);
      const conds = Array.isArray(t?.killConditions) ? t.killConditions : [];
      if (conds.length) continue; // covered by the sweep
      missing.push({ ticker: tk, name: c.name, sector: c.sector, hasProse: Boolean(t?.why?.trim()) });
    }
    missing.sort((a, b) => a.ticker.localeCompare(b.ticker));

    return NextResponse.json({
      holdings: killWatch,
      coverage: { portfolioCount, underwritten: portfolioCount - missing.length, missing },
    });
  } catch (e) {
    console.error("thesis-watch failed:", e);
    // Read-only surface: degrade to empty rather than erroring the page.
    return NextResponse.json({ holdings: [], coverage: { portfolioCount: 0, underwritten: 0, missing: [] } });
  }
}
