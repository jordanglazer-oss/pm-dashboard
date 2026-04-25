import { NextResponse } from "next/server";
import { getCikForTicker, getCompanyFacts, listConcepts } from "@/app/lib/edgar";
import { classifyIssuer } from "@/app/lib/edgar-industry";
import { buildScoringSnapshot } from "@/app/lib/edgar-concepts";

/**
 * GET /api/debug/edgar?ticker=AAPL
 *
 * Stage 2 sanity-check: returns the same metadata as Stage 1 PLUS the
 * industry classification AND the normalized scoring snapshot
 * (deduped, sorted, industry-aware concept-priority applied).
 *
 * Compare these fields between Stage 1 and Stage 2 for AAPL:
 *
 *   Stage 1 sampleConcepts.Revenues.latestEnd:
 *     "2018-09-29"  ← stale (Apple stopped using us-gaap:Revenues)
 *
 *   Stage 2 metrics.revenue:
 *     conceptUsed: "RevenueFromContractWithCustomerExcludingAssessedTax"
 *     latest.end: "2025-12-27" or similar  ← live, post-ASC-606 tag
 *
 *   Stage 1 sampleConcepts.EarningsPerShareDiluted:
 *     { available: false }  ← unit mismatch
 *
 *   Stage 2 metrics.epsDiluted:
 *     unit: "USD/shares"
 *     latest.val: ~6.16  ← actual EPS
 *
 * Use ?showAllConcepts=1 to dump the full available concept list (for
 * adding new tags to the registry when a new issuer surfaces a tag we
 * don't know about).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
    const showAllConcepts = url.searchParams.get("showAllConcepts") === "1";
    const conceptSearch = (url.searchParams.get("conceptSearch") || "").trim();

    if (!ticker) {
      return NextResponse.json(
        { error: "ticker query param required (e.g. ?ticker=AAPL)" },
        { status: 400 }
      );
    }

    const cikInfo = await getCikForTicker(ticker);
    if (!cikInfo) {
      return NextResponse.json({
        ticker,
        cik: null,
        note:
          ticker.endsWith("-T") || ticker.endsWith(".TO") || ticker.endsWith(".U")
            ? `${ticker} is a Canadian / international listing — not in SEC EDGAR by design. The scoring system will fall back to Yahoo for this ticker.`
            : `${ticker} not found in the SEC ticker map. Could be OTC, recently delisted, or a non-SEC-registered issuer. Scoring will fall back to Yahoo.`,
      });
    }

    const [facts, classification] = await Promise.all([
      getCompanyFacts(ticker),
      classifyIssuer(cikInfo.paddedCik),
    ]);

    if (!facts) {
      return NextResponse.json({
        ticker,
        cik: cikInfo.cik,
        entityName: cikInfo.entityName,
        classification,
        note: `Resolved to CIK ${cikInfo.paddedCik} but companyfacts returned no data. Likely a recently filed entity or one that filed only non-XBRL forms.`,
      });
    }

    const snapshot = buildScoringSnapshot(facts, classification.industry);

    // Compact display: latest value + 4 most-recent annual + concept used.
    const compactMetrics: Record<string, unknown> = {};
    for (const [metric, info] of Object.entries(snapshot)) {
      compactMetrics[metric] = {
        conceptUsed: info.conceptUsed,
        unit: info.unit,
        latest: info.latest && {
          end: info.latest.end,
          val: info.latest.val,
          form: info.latest.form,
          fp: info.latest.fp,
        },
        recentAnnual: info.annual.slice(0, 4).map((f) => ({
          end: f.end,
          val: f.val,
          form: f.form,
        })),
        recentQuarterly: info.quarterly.slice(0, 4).map((f) => ({
          end: f.end,
          val: f.val,
          form: f.form,
          fp: f.fp,
        })),
      };
    }

    const allConcepts = listConcepts(facts);

    // Concept search: filter by case-insensitive substring and return
    // concepts WITH their latest observation date and value, so the
    // operator can quickly identify which tag a company actually uses
    // for a given metric (e.g. ?conceptSearch=Debt to find JPM's
    // long-term debt concept). Only returns USD-denominated facts;
    // skips concepts with no data.
    let conceptSearchResults: Array<{ concept: string; latestEnd: string; latestVal: number; observations: number }> | undefined;
    if (conceptSearch) {
      const needle = conceptSearch.toLowerCase();
      const matches = allConcepts.filter((c) => c.toLowerCase().includes(needle));
      conceptSearchResults = [];
      for (const c of matches) {
        const usd = facts.facts["us-gaap"]?.[c]?.units?.USD;
        if (!usd || usd.length === 0) continue;
        const sorted = [...usd].sort((a, b) => b.end.localeCompare(a.end));
        conceptSearchResults.push({
          concept: c,
          latestEnd: sorted[0].end,
          latestVal: sorted[0].val,
          observations: usd.length,
        });
      }
      // Sort by freshest first so the relevant tag is at the top.
      conceptSearchResults.sort((a, b) => b.latestEnd.localeCompare(a.latestEnd));
    }

    return NextResponse.json({
      ticker,
      cik: cikInfo.cik,
      paddedCik: cikInfo.paddedCik,
      entityName: facts.entityName,
      classification: {
        industry: classification.industry,
        sic: classification.sic,
        sicDescription: classification.sicDescription,
      },
      conceptCount: allConcepts.length,
      metricsCount: Object.keys(compactMetrics).length,
      metrics: compactMetrics,
      ...(conceptSearchResults ? { conceptSearch: { query: conceptSearch, matchesWithData: conceptSearchResults.length, results: conceptSearchResults } } : {}),
      ...(showAllConcepts ? { allConcepts } : { allConceptsHint: "Add &showAllConcepts=1 to dump the full concept list, or &conceptSearch=Debt to search by keyword (returns matching concepts sorted by freshness)." }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
