import { isPlanComplete, type TacticalPlan } from "@/app/lib/tactical-plan";
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

type CoverageRow = {
  ticker: string;
  name?: string;
  sector?: string;
  hasProse: boolean;
  /** Entry price to stamp if this name is underwritten from the desk. */
  price?: number | null;
};

export async function GET() {
  try {
    const { killWatch, context, thesisVerdicts } = await loadAlertInputs();

    // Thesis keys include prose-only entries, which killWatch drops.
    let theses: Record<string, { why?: string; killConditions?: unknown[]; tacticalPlan?: unknown }> = {};
    try {
      const raw = await (await getRedis()).get("pm:position-theses");
      if (raw) theses = JSON.parse(raw);
    } catch {
      // coverage degrades to "nothing underwritten" rather than failing the sweep
    }
    const thesisFor = (tk: string) => theses[tk] ?? theses[tk.toUpperCase()];

    const missing: CoverageRow[] = [];
    // Tactical-sleeve holdings (stocks AND funds) with no tactical plan on file.
    const planMissing: Array<{ ticker: string; name?: string; incomplete?: boolean }> = [];
    let portfolioCount = 0;
    for (const [tk, c] of Object.entries(context)) {
      if (c.bucket !== "Portfolio") continue;
      if (c.sleeves?.tactical) {
        const plan = thesisFor(tk)?.tacticalPlan as TacticalPlan | undefined;
        if (!isPlanComplete(plan)) planMissing.push({ ticker: tk, name: c.name, incomplete: Boolean(plan) });
      }
      // A Tactical-ONLY name is governed by its plan, not a long-run thesis —
      // it is not part of the underwriting denominator.
      if (c.sleeves?.tactical && !c.sleeves.thesis) continue;
      // Mirrors isScoreable(): undefined instrumentType means a stock. A FUND
      // is in the denominator only when it is a Thesis-sleeve holding.
      if (c.instrumentType && c.instrumentType !== "stock" && !c.sleeves?.thesis) continue;
      portfolioCount++;
      const t = thesisFor(tk);
      const conds = Array.isArray(t?.killConditions) ? t.killConditions : [];
      if (conds.length) continue; // covered by the sweep
      missing.push({
        ticker: tk,
        name: c.name,
        sector: c.sector,
        hasProse: Boolean(t?.why?.trim()),
        price: typeof c.price === "number" ? c.price : null,
      });
    }
    missing.sort((a, b) => a.ticker.localeCompare(b.ticker));
    planMissing.sort((a, b) => a.ticker.localeCompare(b.ticker));

    return NextResponse.json({
      holdings: killWatch,
      coverage: { portfolioCount, underwritten: portfolioCount - missing.length, missing, planMissing },
      // Thesis-sleeve holdings only: the roll-up of the latest pillar review.
      verdicts: Object.fromEntries(thesisVerdicts.map((v) => [v.ticker, { verdict: v.verdict, generatedAt: v.generatedAt }])),
      sleeves: Object.fromEntries(killWatch.map((k) => [k.ticker, context[k.ticker]?.sleeves ?? null])),
    });
  } catch (e) {
    console.error("thesis-watch failed:", e);
    // Read-only surface: degrade to empty rather than erroring the page.
    return NextResponse.json({ holdings: [], coverage: { portfolioCount: 0, underwritten: 0, missing: [] } });
  }
}
