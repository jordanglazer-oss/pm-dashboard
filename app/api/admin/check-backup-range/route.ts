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
import { getRedis } from "@/app/lib/redis";

type BackupBlob = {
  backedUpAt?: string;
  keyCount?: number;
  totalBytes?: number;
  data?: Record<string, string>;
};

function isoDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

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
    const redis = await getRedis();
    const dates = Array.from({ length: 30 }, (_, i) => isoDateNDaysAgo(i));
    const found: Array<{
      date: string;
      backedUpAt?: string;
      blobBytes: number;
      pimPositions: unknown;
      pimModels: unknown;
      stocks: unknown;
    }> = [];
    const missing: string[] = [];

    for (const d of dates) {
      const raw = await redis.get(`pm:backup:${d}`);
      if (!raw) {
        missing.push(d);
        continue;
      }
      let parsed: BackupBlob | null = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        found.push({
          date: d,
          blobBytes: raw.length,
          pimPositions: { present: false, parseFailed: true },
          pimModels: { present: false, parseFailed: true },
          stocks: { present: false, parseFailed: true },
        });
        continue;
      }
      found.push({
        date: d,
        backedUpAt: parsed?.backedUpAt,
        blobBytes: raw.length,
        pimPositions: summarize(parsed?.data, "pm:pim-positions"),
        pimModels: summarize(parsed?.data, "pm:pim-models"),
        stocks: summarize(parsed?.data, "pm:stocks"),
      });
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      datesChecked: dates,
      foundCount: found.length,
      missingCount: missing.length,
      found,
      missing,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to check backup range" },
      { status: 500 },
    );
  }
}
