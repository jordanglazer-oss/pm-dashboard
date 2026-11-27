import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { buildSignalFundamentals, type FundamentalsDebug } from "@/app/lib/signal-fundamentals";
import { median, type NameFundamentals } from "@/app/lib/signal-fundamentals-shared";

/**
 * GET /api/admin/signal-fundamentals-check — runs the FactSet pull behind the
 * signal grid and reports whether every data point came back clean: how many
 * names returned each figure, figures outside a believable range, names with
 * nothing, a units check on EV/EBITDA, and the raw inputs for a few names to
 * compare with a FactSet terminal. Writes only the regenerable cache
 * pm:signal-fundamentals (same as a normal refresh); no other key.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const log = createLogger("Signal-fundamentals-check");

// Outside these, a figure is listed for a look. Starting ranges, not calibrated.
const RANGE: Record<string, [number, number]> = {
  pe: [3, 100],
  evEbitda: [2, 80],
  netDebtEbitda: [-6, 8],
  interestCoverage: [0, 250],
  fcfMargin: [-60, 70],
  roic: [-40, 90],
  revenueGrowth: [-50, 150],
  peg: [0.1, 10],
  peVsMarketPct: [-90, 400],
  peVsSectorPct: [-90, 400],
};
const POINTS = ["pe", "peVsMarketPct", "peVsSectorPct", "evEbitda", "netDebtEbitda", "interestCoverage", "fcfMargin", "roic", "revenueGrowth", "peg", "forwardPE5yAvg", "evEbitda5yAvg"] as const;

export async function GET() {
  try {
    const debug: FundamentalsDebug = { raws: {}, notOnFactset: [], requested: 0 };
    const out = await buildSignalFundamentals(debug);
    const rows = Object.entries(out.names);
    const total = rows.length;
    const val = (d: NameFundamentals, k: string) => (d as unknown as Record<string, number | null | undefined>)[k];

    const coverage = POINTS.map((k) => {
      const got = rows.filter(([, d]) => typeof val(d, k) === "number").length;
      return { dataPoint: k, names: got, of: total, pct: total ? Math.round((got / total) * 100) : 0 };
    });
    const outOfRange = rows.flatMap(([t, d]) =>
      Object.entries(RANGE)
        .filter(([k, [lo, hi]]) => typeof val(d, k) === "number" && ((val(d, k) as number) < lo || (val(d, k) as number) > hi))
        .map(([k, [lo, hi]]) => ({ ticker: t, dataPoint: k, value: val(d, k), believable: `${lo} to ${hi}` })),
    );
    const nothing = rows.filter(([, d]) => POINTS.every((k) => typeof val(d, k) !== "number")).map(([t]) => t);
    const evs = rows.map(([, d]) => d.evEbitda).filter((v): v is number => typeof v === "number");
    const evMedian = median(evs);
    const unitsOk = evMedian == null ? null : evMedian >= 5 && evMedian <= 40;
    const rawNull = (k: string) => Object.values(debug.raws).filter((r) => (r as Record<string, unknown>)[k] == null).length;
    const samples = rows
      .filter(([, d]) => d.pe != null && d.netDebtEbitda != null)
      .slice(0, 8)
      .map(([t, d]) => ({ ticker: t, rawFromFactset: debug.raws[t], derived: d }));

    const problems: string[] = [];
    if (!out.market.peMedian) problems.push("The market P/E median could not be formed.");
    if (unitsOk === false) problems.push(`Median EV/EBITDA across our names is ${evMedian?.toFixed(1)}: market value and debt may be in different units.`);
    for (const c of coverage) if (c.of > 0 && c.pct < 50 && !/5yAvg/.test(c.dataPoint)) problems.push(`${c.dataPoint} came back for only ${c.names} of ${c.of} names.`);
    if (nothing.length) problems.push(`${nothing.length} name(s) returned nothing.`);

    return NextResponse.json({
      verdict: problems.length ? "needs a look" : outOfRange.length ? "clean, with values to eyeball" : "clean",
      at: out.at,
      namesRequested: debug.requested,
      namesOnFactset: debug.requested - debug.notOnFactset.length,
      notOnFactset: debug.notOnFactset,
      problems,
      market: out.market,
      sectors: out.sectors,
      unitsCheck: { medianEvEbitda: evMedian != null ? parseFloat(evMedian.toFixed(1)) : null, ok: unitsOk },
      coverage,
      rawInputsMissing: ["pe", "mktVal", "debt", "cash", "ebitdaLtm", "ebitdaAnn", "operIncLtm", "intExp", "fcfLtm", "salesLtm", "salesLtm4", "roic", "ltg", "sector"].map((k) => ({ input: k, missingFor: rawNull(k), of: Object.keys(debug.raws).length })),
      outOfRange,
      returnedNothing: nothing,
      loaderNotes: out.notes,
      samplesToCompareWithTheTerminal: samples,
      note: "5-year-average multiples come from FactSet analyst round-up emails on file, so low coverage there is expected. Banks and insurers have no debt-based figures by design.",
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : "failed";
    log.error("failed:", error);
    return NextResponse.json({ verdict: "could not run", error }, { status: 500 });
  }
}
