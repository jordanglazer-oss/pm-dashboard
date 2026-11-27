import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { mergeSplits } from "@/app/lib/sia-holdings";
import { siaTradeLog, tradeLogSummary } from "@/app/lib/sia-trade-log";
import { SIA_BOOKS, isSiaBook, readSiaStore, unpackTxns, type SiaBook } from "@/app/lib/sia-store";

/**
 * GET /api/trade-log?mandate=balanced&year=2026 — the trade log for one
 * mandate from its SIA transaction log: every buy, add, trim and sale in the
 * year, with the realized gain on each sale against average cost. READ-ONLY:
 * reads that mandate's pm:sia-transactions key (the All-Equity log when the
 * mandate has none, and says so); stores nothing.
 */

export const dynamic = "force-dynamic";
const log = createLogger("Trade-log");

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const wanted = q.get("mandate");
    let book: SiaBook = isSiaBook(wanted) ? wanted : "allEquity";
    let store = await readSiaStore(book);
    if (!store && book !== "allEquity") {
      book = "allEquity";
      store = await readSiaStore(book);
    }
    const mandates: { id: string; label: string }[] = [];
    for (const b of SIA_BOOKS) {
      const has = b.id === book ? Boolean(store) : Boolean(await readSiaStore(b.id));
      if (has) mandates.push({ id: b.id, label: b.label });
    }
    if (!store) return NextResponse.json({ onFile: false, mandates, rows: [], years: [] });

    const all = siaTradeLog(unpackTxns(store.txns), mergeSplits(store.splits));
    const years = Array.from(new Set(all.map((r) => r.date.slice(0, 4)))).sort().reverse();
    const asked = q.get("year") ?? "";
    const year = years.includes(asked) ? asked : years[0];
    const rows = all.filter((r) => r.date.startsWith(year));
    return NextResponse.json({
      onFile: true,
      book,
      bookLabel: SIA_BOOKS.find((b) => b.id === book)?.label ?? book,
      ownLog: !isSiaBook(wanted) || book === wanted,
      through: store.last,
      mandates,
      years,
      year,
      summary: tradeLogSummary(rows),
      rows: rows.map((r) => ({
        ...r,
        amount: +r.amount.toFixed(2),
        avgCost: r.avgCost == null ? null : +r.avgCost.toFixed(4),
        gainPct: r.gainPct == null ? null : +r.gainPct.toFixed(2),
        gain: r.gain == null ? null : +r.gain.toFixed(2),
      })),
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
