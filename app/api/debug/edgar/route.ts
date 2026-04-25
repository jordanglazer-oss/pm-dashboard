import { NextResponse } from "next/server";
import { getCikForTicker, getCompanyFacts, getConceptSeries, listConcepts } from "@/app/lib/edgar";

/**
 * GET /api/debug/edgar?ticker=AAPL
 *
 * Stage 1 sanity-check endpoint for the SEC EDGAR integration.
 *
 * Verifies:
 *   1. The ticker→CIK lookup resolves (or returns null cleanly for
 *      non-US tickers like Canadian -T listings).
 *   2. The companyfacts JSON fetches without auth issues (i.e. the
 *      SEC_USER_AGENT env var is set correctly).
 *   3. A handful of marquee concepts (Revenues, NetIncomeLoss, etc.)
 *      come back with sensible values.
 *
 * Response shape is intentionally compact — full XBRL payloads can be
 * 5MB+. Use ?showAllConcepts=1 to dump the full list of available
 * concepts (useful for figuring out what tags to put in the Stage 2
 * industry-aware concept registry).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
    const showAllConcepts = url.searchParams.get("showAllConcepts") === "1";

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
        note: ticker.endsWith("-T") || ticker.endsWith(".TO") || ticker.endsWith(".U")
          ? `${ticker} is a Canadian / international listing — not in SEC EDGAR by design. The scoring system will fall back to Yahoo for this ticker.`
          : `${ticker} not found in the SEC ticker map. Could be OTC, recently delisted, or a non-SEC-registered issuer. Scoring will fall back to Yahoo.`,
      });
    }

    const facts = await getCompanyFacts(ticker);
    if (!facts) {
      return NextResponse.json({
        ticker,
        cik: cikInfo.cik,
        entityName: cikInfo.entityName,
        note: `Resolved to CIK ${cikInfo.paddedCik} but companyfacts returned no data. Likely a recently filed entity or one that filed only non-XBRL forms.`,
      });
    }

    // Pull a handful of marquee concepts so you can eyeball the data
    // quality. These are the ones that exist for ~80% of US issuers.
    const sampleConcepts = [
      "Revenues",
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "NetIncomeLoss",
      "EarningsPerShareDiluted",
      "OperatingIncomeLoss",
      "CashAndCashEquivalentsAtCarryingValue",
      "LongTermDebt",
      "StockholdersEquity",
      "NetCashProvidedByUsedInOperatingActivities",
    ];
    const samples: Record<string, { latestVal: number; latestEnd: string; latestForm: string; observations: number; lastFour: { end: string; val: number; form: string }[] } | { available: false }> = {};
    for (const concept of sampleConcepts) {
      const series = getConceptSeries(facts, concept, { limit: 4 });
      if (series.length === 0) {
        samples[concept] = { available: false };
      } else {
        const latest = series[0];
        samples[concept] = {
          latestVal: latest.val,
          latestEnd: latest.end,
          latestForm: latest.form,
          observations: facts.facts["us-gaap"]?.[concept]?.units.USD?.length ?? 0,
          lastFour: series.map((f) => ({ end: f.end, val: f.val, form: f.form })),
        };
      }
    }

    const allConcepts = listConcepts(facts);
    const earliestEnd = (() => {
      // Find the earliest period end across all concepts to show data depth.
      let earliest: string | null = null;
      for (const concept of allConcepts) {
        const usd = facts.facts["us-gaap"]?.[concept]?.units.USD;
        if (!usd || usd.length === 0) continue;
        for (const obs of usd) {
          if (earliest === null || obs.end < earliest) earliest = obs.end;
        }
      }
      return earliest;
    })();

    return NextResponse.json({
      ticker,
      cik: cikInfo.cik,
      paddedCik: cikInfo.paddedCik,
      entityName: facts.entityName,
      conceptCount: allConcepts.length,
      earliestObservation: earliestEnd,
      sampleConcepts: samples,
      ...(showAllConcepts ? { allConcepts } : { allConceptsHint: "Add &showAllConcepts=1 to dump the full concept list." }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
