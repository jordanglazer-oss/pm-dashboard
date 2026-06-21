import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { AnalystReports, AnalystSnapshots } from "@/app/lib/analyst-snapshots";

/**
 * Free Redis memory by dropping STALE analyst-report PDFs.
 *
 * Analyst-report PDFs are the single biggest persistent line (~70 MB across
 * ~60 slots). Each (ticker, source) has exactly ONE slot — a fresh report
 * overwrites the old one in place, so a slot only goes stale when you stop
 * covering that name. This endpoint deletes any slot whose manifest
 * `uploadedAt` is older than ?days (default 120), and removes its manifest +
 * snapshot entries in the same pass so nothing dangles.
 *
 * Keys touched (read-merge-write, preserves everything else):
 *   - pm:analyst-report-pdf:<id>   DEL the stale PDF blobs
 *   - pm:analyst-reports           remove the stale source from each ticker
 *                                  (and the ticker if it has no sources left)
 *   - pm:analyst-snapshots         remove the matching source entry whose
 *                                  reportId points at a dropped PDF
 *
 * SAFETY:
 *   - ?confirm=YES required. ?dryRun=YES previews without deleting.
 *   - Age is read from the manifest's uploadedAt; a slot refreshed within
 *     the window is kept. Slots with an unparseable uploadedAt are KEPT.
 *   - Returns dropped slots + bytes freed.
 */

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("confirm") !== "YES") {
    return NextResponse.json(
      {
        error: "Confirmation required",
        hint: "Append ?confirm=YES to drop analyst-report PDFs whose uploadedAt is older than ?days (default 120). Removes the PDF + manifest + snapshot entries together. ?dryRun=YES previews.",
      },
      { status: 400 },
    );
  }
  const dryRun = params.get("dryRun") === "YES";
  const daysRaw = parseInt(params.get("days") ?? "120", 10);
  const days = Number.isFinite(daysRaw) && daysRaw >= 0 ? daysRaw : 120;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  try {
    const redis = await getRedis();
    const reportsRaw = await redis.get("pm:analyst-reports");
    if (!reportsRaw) {
      return NextResponse.json({ ok: true, dropped: [], note: "No analyst-reports manifest — nothing to prune." });
    }
    const reports = JSON.parse(reportsRaw) as AnalystReports;
    const snapsRaw = await redis.get("pm:analyst-snapshots");
    const snaps = snapsRaw ? (JSON.parse(snapsRaw) as AnalystSnapshots) : {};

    type Drop = { ticker: string; source: "rbc" | "jpm"; id: string; uploadedAt: string };
    const drops: Drop[] = [];
    const kept: string[] = [];

    const nextReports: AnalystReports = {};
    for (const [ticker, sources] of Object.entries(reports)) {
      const nextSources: typeof sources = {};
      for (const source of ["rbc", "jpm"] as const) {
        const meta = sources[source];
        if (!meta) continue;
        const t = Date.parse(meta.uploadedAt);
        const stale = Number.isFinite(t) && t < cutoffMs;
        if (stale) {
          drops.push({ ticker, source, id: meta.id, uploadedAt: meta.uploadedAt });
        } else {
          nextSources[source] = meta; // keep (recent, or unparseable date)
          kept.push(`${ticker}-${source}`);
        }
      }
      if (nextSources.rbc || nextSources.jpm) nextReports[ticker] = nextSources;
    }

    if (drops.length === 0) {
      return NextResponse.json({
        ok: true,
        dryRun,
        olderThanDays: days,
        dropped: [],
        keptCount: kept.length,
        note: `No analyst slots older than ${days} days. Nothing to prune.`,
      });
    }

    // Tally freed bytes (PDF blobs).
    let freedBytes = 0;
    for (const d of drops) {
      freedBytes += await redis.strLen(`pm:analyst-report-pdf:${d.id}`).catch(() => 0);
    }

    if (!dryRun) {
      // 1) DEL the stale PDF blobs.
      for (const d of drops) {
        await redis.del(`pm:analyst-report-pdf:${d.id}`);
      }
      // 2) Write the pruned manifest.
      await redis.set("pm:analyst-reports", JSON.stringify(nextReports));
      // 3) Prune matching snapshot entries (only those pointing at a dropped id).
      const droppedIds = new Set(drops.map((d) => d.id));
      const nextSnaps: AnalystSnapshots = {};
      for (const [ticker, snap] of Object.entries(snaps)) {
        const ns = { ...snap };
        for (const source of ["rbc", "jpm"] as const) {
          if (ns[source]?.reportId && droppedIds.has(ns[source]!.reportId!)) {
            delete ns[source];
          }
        }
        if (ns.rbc || ns.jpm || ns.factset) nextSnaps[ticker] = ns;
      }
      await redis.set("pm:analyst-snapshots", JSON.stringify(nextSnaps));
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      olderThanDays: days,
      droppedCount: drops.length,
      dropped: drops.map((d) => `${d.ticker}-${d.source} (${d.uploadedAt.slice(0, 10)})`),
      keptCount: kept.length,
      freedBytes,
      freedMB: Math.round((freedBytes / 1048576) * 100) / 100,
      note: dryRun
        ? "Dry run — nothing deleted. Re-run without &dryRun=YES to apply."
        : `Dropped ${drops.length} stale analyst slot(s), freed ${Math.round((freedBytes / 1048576) * 100) / 100} MB.`,
    });
  } catch (e) {
    console.error("[prune-analyst-reports] failed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
