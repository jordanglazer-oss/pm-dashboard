import { NextRequest, NextResponse } from "next/server";
import { buildEntryScan } from "@/app/lib/entry-scan";

/**
 * GET /api/admin/entry-unification-diff            (plain text)
 * GET /api/admin/entry-unification-diff?json=1
 *
 * Before/after for the entry-scorecard unification (rubric v3): which
 * Watchlist / Suggested names change readiness when the five separate
 * technical signals collapse into the single mandatory setup-grade signal.
 * Rebuilds the entry scan (writes only the regenerable pm:entry-scan cache,
 * exactly as the funnel's own refresh does) and lists every row whose
 * ready / strength differs between the legacy and the new evaluator.
 * TEMPORARY — delete together with evaluateEntryLegacy after sign-off.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const wantJson = new URL(req.url).searchParams.get("json") === "1";
  try {
    const scan = await buildEntryScan();
    const rows = scan.rows;
    const changed = rows.filter((r) => r.legacyReady !== r.ready || r.legacyStrength !== r.strength);
    const summary = {
      names: rows.length,
      readyLegacy: rows.filter((r) => r.legacyReady).length,
      readyNow: rows.filter((r) => r.ready).length,
      lostReady: changed.filter((r) => r.legacyReady && !r.ready).map((r) => r.ticker),
      gainedReady: changed.filter((r) => !r.legacyReady && r.ready).map((r) => r.ticker),
    };
    if (wantJson) return NextResponse.json({ ok: true, summary, changed, rows });

    const out: string[] = [];
    out.push(`ENTRY SCORECARD UNIFICATION — before/after   names=${summary.names}   ready before=${summary.readyLegacy}   ready after=${summary.readyNow}`);
    out.push(`lost ready: ${summary.lostReady.join(", ") || "—"}`);
    out.push(`gained ready: ${summary.gainedReady.join(", ") || "—"}`);
    out.push("");
    out.push(`${"ticker".padEnd(10)}${"bkt".padEnd(5)}${"before".padEnd(10)}${"after".padEnd(10)}setup                          case signals met`);
    for (const r of rows.slice().sort((a, b) => Number(b.legacyReady) - Number(a.legacyReady) || a.ticker.localeCompare(b.ticker))) {
      const setup = r.signals.find((x) => x.key === "setup");
      const caseMet = r.signals.filter((x) => x.key !== "setup" && x.status === "met").map((x) => x.key).join(",");
      const mark = r.legacyReady !== r.ready ? " *" : "";
      out.push(`${r.ticker.padEnd(10)}${(r.bucket === "Watchlist" ? "W" : "S").padEnd(5)}${(r.legacyStrength ?? "?").padEnd(10)}${r.strength.padEnd(10)}${(setup ? `${setup.status}: ${setup.reading}` : "—").padEnd(31)}${caseMet || "—"}${mark}`);
    }
    out.push("");
    out.push("* = readiness changed. Rule after: setup ≥ Constructive (mandatory) AND no critical alert AND ≥3 of the six case signals met (risk counts as one).");
    return new NextResponse(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
