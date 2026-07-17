import { NextRequest, NextResponse } from "next/server";
import { crossSectional, factsetConfigured, type FactsetValue } from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";
import { readUniverse, deriveMetrics, RAW_FORMULAS } from "@/app/lib/factor-universe";
import { computeFactorScore } from "@/app/lib/factors";

/**
 * Read-only factor-layer inspector (Phase A verification). Cookie-gated like
 * every other /api/admin route — open it from the logged-in dashboard.
 *
 *   /api/admin/factor-debug                → universe summary (per-sector name
 *                                            counts + which metrics resolved)
 *   /api/admin/factor-debug?ticker=AVGO    → one name's live factor breakdown:
 *                                            raw → derived metrics → sector
 *                                            z-scores → composite percentile
 *
 * Touches NOTHING — no writes, no effect on any score. Pure inspection.
 */

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const universe = await readUniverse();
  if (!universe) {
    return NextResponse.json({
      ok: false,
      error: "pm:factor-universe not built yet — run the factor-universe cron (or wait for Sunday).",
    });
  }

  const ticker = new URL(req.url).searchParams.get("ticker");

  // ── Summary mode: prove the universe is populated ──
  if (!ticker) {
    const sectors = Object.fromEntries(
      Object.entries(universe.sectors)
        .map(([name, s]) => [name, { names: s.n, metricsResolved: Object.keys(s.metrics).length }])
        .sort((a, b) => (b[1] as { names: number }).names - (a[1] as { names: number }).names),
    );
    return NextResponse.json({
      ok: true,
      builtAt: universe.builtAt,
      listVersion: universe.listVersion,
      tickerCount: universe.tickerCount,
      sectorCount: Object.keys(universe.sectors).length,
      sectors,
      hint: "Add ?ticker=AVGO for a live single-name factor breakdown.",
    });
  }

  // ── Single-name mode: live breakdown ──
  if (!factsetConfigured()) return NextResponse.json({ ok: false, error: "FactSet relay not configured" });
  const resolved = resolveFactsetId(ticker.trim().toUpperCase());
  if (resolved.source !== "factset") {
    return NextResponse.json({ ok: false, ticker, error: `No FactSet id for ${ticker} (${resolved.source}).` });
  }

  const data = await crossSectional([resolved.id], Object.values(RAW_FORMULAS) as unknown as string[]);
  const row = data[resolved.id];
  if (!row) return NextResponse.json({ ok: false, ticker, error: "FactSet returned no data for this id." });

  // Rebuild the raw row shape deriveMetrics expects.
  const raw: Record<string, number | string> = {};
  for (const [key, formula] of Object.entries(RAW_FORMULAS)) {
    const v: FactsetValue | undefined = row[formula];
    if (key === "sector") {
      if (typeof v === "string" && v) raw.sector = v;
    } else if (typeof v === "number" && isFinite(v)) {
      raw[key] = v;
    }
  }
  const sector = typeof raw.sector === "string" ? raw.sector : "";
  const metrics = deriveMetrics(raw as never);
  const score = sector ? computeFactorScore(metrics, sector, universe) : null;

  return NextResponse.json({
    ok: true,
    ticker,
    factsetId: resolved.id,
    sector: sector || "(no sector)",
    sectorPeerCount: sector ? universe.sectors[sector]?.n ?? 0 : 0,
    derivedMetrics: metrics,
    factorScore: score ?? "(sector not in universe, or no metric scorable)",
  });
}
