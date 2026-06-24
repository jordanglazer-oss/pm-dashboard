/**
 * GET /api/admin/check-backup-range
 *
 * Checks the last 30 days for pm:backup:YYYY-MM-DD entries. Avoids
 * redis.keys() entirely — just does 30 sequential GETs by date.
 * Returns a list of dates that have a backup, with byte size and
 * the critical-blob summary (portfolios / holdings / stocks counts).
 *
 * Read-only.
 */

import { NextResponse } from "next/server";
import { listBackupBlobs, readBackupBlob } from "@/app/lib/backup-store";

function summarize(data: Record<string, string> | undefined, k: string): unknown {
  const v = data?.[k];
  if (typeof v !== "string") return { present: false };
  try {
    const inner = JSON.parse(v);
    if (k === "pm:pim-positions") {
      const portfolios = Array.isArray(inner?.portfolios) ? inner.portfolios : [];
      const totalPositions = portfolios.reduce(
        (n: number, p: { positions?: unknown[] }) => n + (Array.isArray(p.positions) ? p.positions.length : 0),
        0,
      );
      return { present: true, bytes: v.length, portfolios: portfolios.length, totalPositions };
    }
    if (k === "pm:pim-models") {
      const groups = Array.isArray(inner?.groups) ? inner.groups : [];
      const totalHoldings = groups.reduce(
        (n: number, g: { holdings?: unknown[] }) => n + (Array.isArray(g.holdings) ? g.holdings.length : 0),
        0,
      );
      return { present: true, bytes: v.length, groups: groups.length, totalHoldings };
    }
    if (k === "pm:stocks") {
      const stocks = Array.isArray(inner?.stocks) ? inner.stocks : [];
      const portfolio = stocks.filter((s: { bucket?: string }) => s.bucket === "Portfolio").length;
      const watchlist = stocks.filter((s: { bucket?: string }) => s.bucket === "Watchlist").length;
      return { present: true, bytes: v.length, total: stocks.length, portfolio, watchlist };
    }
    return { present: true, bytes: v.length };
  } catch {
    return { present: true, bytes: v.length, parseFailed: true };
  }
}

export async function GET() {
  try {
    // Backups live in Blob now — list them all (newest first) and summarize
    // each, instead of probing 30 fixed dates in Redis.
    const blobs = await listBackupBlobs();
    const found: Array<{
      pathname: string;
      uploadedAt: string;
      backedUpAt?: string;
      blobBytes: number;
      pimPositions: unknown;
      pimModels: unknown;
      stocks: unknown;
    }> = [];

    for (const b of blobs) {
      let snap: { backedUpAt?: string; data?: Record<string, string> } | null = null;
      try {
        snap = await readBackupBlob(b.pathname);
      } catch {
        found.push({
          pathname: b.pathname,
          uploadedAt: b.uploadedAt,
          blobBytes: b.sizeBytes,
          pimPositions: { present: false, parseFailed: true },
          pimModels: { present: false, parseFailed: true },
          stocks: { present: false, parseFailed: true },
        });
        continue;
      }
      found.push({
        pathname: b.pathname,
        uploadedAt: b.uploadedAt,
        backedUpAt: snap?.backedUpAt,
        blobBytes: b.sizeBytes,
        pimPositions: summarize(snap?.data, "pm:pim-positions"),
        pimModels: summarize(snap?.data, "pm:pim-models"),
        stocks: summarize(snap?.data, "pm:stocks"),
      });
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      foundCount: found.length,
      found,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to check backup range" },
      { status: 500 },
    );
  }
}
