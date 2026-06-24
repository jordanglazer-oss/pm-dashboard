/**
 * GET /api/admin/check-backup?date=YYYY-MM-DD
 *
 * Inspects a single pm:backup:YYYY-MM-DD snapshot directly, without
 * relying on redis.keys() which behaves inconsistently across Redis
 * backends. If the backup exists, returns its backedUpAt timestamp,
 * key count, total bytes, and whether the three critical blobs
 * (pm:pim-positions, pm:pim-models, pm:stocks) are populated.
 *
 * Read-only. Safe to call repeatedly.
 */

import { NextRequest, NextResponse } from "next/server";
import { findBackupsByDate, readBackupBlob, type BackupSnapshot } from "@/app/lib/backup-store";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date query param required (YYYY-MM-DD)" }, { status: 400 });
    }
    // Backups live in Blob now. A given UTC date may have multiple snapshots
    // (the cron can run more than once a day) — inspect the newest that day.
    const matches = await findBackupsByDate(date);
    if (matches.length === 0) {
      return NextResponse.json({ exists: false, date });
    }
    const key = matches[0].pathname;
    let parsed: BackupSnapshot;
    try {
      parsed = await readBackupBlob(key);
    } catch (e) {
      return NextResponse.json({ exists: true, key, parseFailed: true, error: e instanceof Error ? e.message : String(e) });
    }
    const data = parsed.data ?? {};
    // Sanity-check each critical blob by parsing it out of the backup
    // and counting its constituent rows.
    const summarize = (k: string) => {
      const v = data[k];
      if (typeof v !== "string") return { present: false };
      try {
        const inner = JSON.parse(v);
        if (k === "pm:pim-positions") {
          const portfolios = Array.isArray(inner?.portfolios) ? inner.portfolios : [];
          const totalPositions = portfolios.reduce(
            (n: number, p: { positions?: unknown[] }) => n + (Array.isArray(p.positions) ? p.positions.length : 0),
            0,
          );
          return { present: true, bytes: v.length, portfolioCount: portfolios.length, totalPositions };
        }
        if (k === "pm:pim-models") {
          const groups = Array.isArray(inner?.groups) ? inner.groups : [];
          const totalHoldings = groups.reduce(
            (n: number, g: { holdings?: unknown[] }) => n + (Array.isArray(g.holdings) ? g.holdings.length : 0),
            0,
          );
          return { present: true, bytes: v.length, groupCount: groups.length, totalHoldings };
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
    };
    return NextResponse.json({
      exists: true,
      key,
      backedUpAt: parsed.backedUpAt,
      keyCount: parsed.keyCount,
      totalBytes: parsed.totalBytes,
      blobBytes: matches[0].sizeBytes,
      critical: {
        pimPositions: summarize("pm:pim-positions"),
        pimModels: summarize("pm:pim-models"),
        stocks: summarize("pm:stocks"),
      },
      allKeys: Object.keys(data).sort(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to check backup" },
      { status: 500 },
    );
  }
}
